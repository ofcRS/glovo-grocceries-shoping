import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, migrate } from "../src/db/index";
import { MIGRATIONS } from "../src/db/schema";
import { convertQty, UnitMismatchError } from "../src/planner/units";
import { PantryRepo } from "../src/planner/pantry";
import { MealsRepo, tbilisiToday } from "../src/planner/meals";
import { DeliveriesRepo } from "../src/planner/deliveries";
import { NotesRepo } from "../src/planner/notes";
import { SqliteMatchCache } from "../src/planner/matchCache";

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(":memory:"); });

test("migrate applies each migration once, records it in schema_version and creates the tables", () => {
  const raw = new Database(":memory:");
  expect(migrate(raw)).toBe(MIGRATIONS.length);
  expect(migrate(raw)).toBe(0);
  expect((raw.query("select count(*) as n from schema_version").get() as { n: number }).n).toBe(MIGRATIONS.length);
  const names = raw.query("select name from sqlite_master where type='table' order by name").all() as { name: string }[];
  const set = new Set(names.map((n) => n.name));
  for (const t of ["product", "product_match", "delivery", "delivery_item", "meal", "meal_ingredient", "pantry", "note", "checkout_log"]) expect(set.has(t)).toBe(true);
  raw.close();
});

test("convertQty handles mass, volume and identity; throws on mismatch (Review Focus 5)", () => {
  expect(convertQty(500, "g", "kg")).toBe(0.5);
  expect(convertQty(1.5, "kg", "g")).toBe(1500);
  expect(convertQty(250, "ml", "l")).toBe(0.25);
  expect(convertQty(3, "pcs", "pcs")).toBe(3);
  expect(() => convertQty(1, "kg", "l")).toThrow(UnitMismatchError);
  expect(() => convertQty(1, "pcs", "g")).toThrow(UnitMismatchError);
});

test("pantry set, adjust with unit conversion, never negative", () => {
  const p = new PantryRepo(db);
  p.set("rice", 1, "kg");
  expect(p.adjust("rice", -300, "g").qty).toBeCloseTo(0.7);
  expect(p.adjust("rice", -5, "kg").qty).toBe(0);
  expect(() => p.adjust("rice", 1, "l")).toThrow(UnitMismatchError);
  p.adjust("eggs", 10, "pcs"); // adjust on a missing row creates it
  expect(p.list().map((r) => r.ingredient).sort()).toEqual(["eggs", "rice"]);
});

test("pantry quantities are rounded so float residue does not survive", () => {
  const p = new PantryRepo(db);
  p.set("x", 0.1, "kg");
  p.adjust("x", 200, "g");
  expect(p.adjust("x", -300, "g").qty).toBe(0);
});

test("meals savePlan, recent window, mark cooked decrements pantry", () => {
  const p = new PantryRepo(db);
  p.set("chicken", 1, "kg");
  const m = new MealsRepo(db, p);
  const ids = m.savePlan([
    { date: "2026-09-25", slot: "dinner", title: "Roast chicken", notes: null, ingredients: [{ ingredient: "chicken", qty: 600, unit: "g" }] },
    { date: "2026-09-10", slot: "lunch", title: "Old meal", notes: null, ingredients: [] },
  ]);
  expect(ids.length).toBe(2);
  const recent = m.recent(14, "2026-09-25");
  expect(recent.map((x) => x.title)).toEqual(["Roast chicken"]);
  expect(recent[0]!.ingredients).toEqual([{ ingredient: "chicken", qty: 600, unit: "g" }]);
  const cooked = m.mark(ids[0]!, "cooked");
  expect(cooked.meal.status).toBe("cooked");
  expect(cooked.pantrySkipped).toEqual([]);
  expect(p.list().find((r) => r.ingredient === "chicken")!.qty).toBeCloseTo(0.4);
  // marking cooked twice must not decrement twice
  m.mark(ids[0]!, "cooked");
  expect(p.list().find((r) => r.ingredient === "chicken")!.qty).toBeCloseTo(0.4);
});

test("meal cooked -> skipped -> cooked decrements the pantry only once", () => {
  const p = new PantryRepo(db);
  p.set("chicken", 1, "kg");
  const m = new MealsRepo(db, p);
  const [id] = m.savePlan([
    { date: "2026-09-25", slot: "dinner", title: "Roast chicken", notes: null, ingredients: [{ ingredient: "chicken", qty: 600, unit: "g" }] },
  ]);
  m.mark(id!, "cooked");
  expect(m.mark(id!, "skipped").meal.status).toBe("skipped");
  expect(p.get("chicken")!.qty).toBeCloseTo(0.4);
  expect(m.mark(id!, "cooked").meal.status).toBe("cooked");
  expect(p.get("chicken")!.qty).toBeCloseTo(0.4);
});

test("delivery record totals the paid line totals and adds the physical amounts to the pantry", () => {
  const p = new PantryRepo(db);
  p.set("milk", 1, "l");
  const d = new DeliveriesRepo(db, p);
  const r = d.record({
    glovoOrderId: "G-1", store: "goodwill",
    items: [
      { productName: "Sante milk 1L", lineTotalTetri: 1197, qty: 3, unit: "l", ingredient: "milk" },
      { productName: "Chicken breast 800 g", lineTotalTetri: 1520, qty: 0.8, unit: "kg", ingredient: "chicken" },
      { productName: "Eggs 10", lineTotalTetri: 550, qty: 10, unit: "pcs" },
    ],
  });
  // the total is the sum of what was paid per line; qty is never a price multiplier
  expect(r.total).toBe(1197 + 1520 + 550);
  expect(p.get("milk")).toMatchObject({ qty: 4, unit: "l" });
  expect(p.get("chicken")).toMatchObject({ qty: 0.8, unit: "kg" });
  expect(p.get("Eggs 10")).toMatchObject({ qty: 10, unit: "pcs" }); // no ingredient: filed under productName
  expect(db.query("select product_name as productName, ingredient, qty, unit, line_total as lineTotal from delivery_item order by id").all()).toEqual([
    { productName: "Sante milk 1L", ingredient: "milk", qty: 3, unit: "l", lineTotal: 1197 },
    { productName: "Chicken breast 800 g", ingredient: "chicken", qty: 0.8, unit: "kg", lineTotal: 1520 },
    { productName: "Eggs 10", ingredient: null, qty: 10, unit: "pcs", lineTotal: 550 },
  ]);
  expect(d.recent(5)[0]).toMatchObject({ glovoOrderId: "G-1", store: "goodwill", total: r.total, status: "placed" });
});

test("delivery record rejects a line total that is not integer tetri and stores nothing", () => {
  const p = new PantryRepo(db);
  const d = new DeliveriesRepo(db, p);
  expect(() => d.record({
    glovoOrderId: "G-9", store: "goodwill",
    items: [{ productName: "Sante milk 1L", lineTotalTetri: 3.99, qty: 1, unit: "l", ingredient: "milk" }],
  })).toThrow(/integer tetri/);
  expect(d.recent(5)).toEqual([]);
  expect(p.get("milk")).toBeNull();
});

test("delivery record rolls back the delivery, its items and earlier pantry increments on a unit mismatch", () => {
  const p = new PantryRepo(db);
  p.set("milk", 1, "l");
  const d = new DeliveriesRepo(db, p);
  expect(() => d.record({
    glovoOrderId: "G-2", store: "goodwill",
    items: [
      { productName: "Sante milk 1L", lineTotalTetri: 798, qty: 2, unit: "l", ingredient: "milk" },
      { productName: "Milk powder", lineTotalTetri: 900, qty: 500, unit: "g", ingredient: "milk" },
    ],
  })).toThrow(UnitMismatchError);
  expect(d.recent(5)).toEqual([]);
  expect((db.query("select count(*) as n from delivery_item").get() as { n: number }).n).toBe(0);
  expect(p.get("milk")!.qty).toBe(1);
});

test("cooking a meal with an ingredient not in the pantry adds no row, so a later delivery in another unit succeeds", () => {
  const p = new PantryRepo(db);
  const m = new MealsRepo(db, p);
  const [id] = m.savePlan([
    { date: "2026-09-25", slot: "breakfast", title: "Omelette", notes: null, ingredients: [{ ingredient: "onion", qty: 150, unit: "g" }] },
  ]);
  m.mark(id!, "cooked");
  expect(p.list().find((r) => r.ingredient === "onion")).toBeUndefined();
  expect(p.adjust("onion", -1, "pcs")).toMatchObject({ ingredient: "onion", qty: 0, unit: "pcs" });
  expect(p.get("onion")).toBeNull();
  const d = new DeliveriesRepo(db, p);
  d.record({
    glovoOrderId: "G-3", store: "goodwill",
    items: [
      { productName: "Onion", lineTotalTetri: 240, qty: 2, unit: "pcs", ingredient: "onion" },
      { productName: "Eggs 10", lineTotalTetri: 550, qty: 10, unit: "pcs", ingredient: "eggs" },
    ],
  });
  expect(p.get("onion")).toMatchObject({ qty: 2, unit: "pcs" });
  expect(p.get("eggs")).toMatchObject({ qty: 10, unit: "pcs" });
});

test("notes add and recent newest first", () => {
  const n = new NotesRepo(db);
  n.add("chicken was bad");
  n.add("loved the salmon");
  expect(n.recent(10).map((x) => x.text)).toEqual(["loved the salmon", "chicken was bad"]);
});

test("SqliteMatchCache round trips and overwrites", () => {
  const c = new SqliteMatchCache(db);
  expect(c.get("k")).toBeNull();
  c.put({ glovoKey: "k", dazogeId: "d1", confidence: 0.9, confirmedAt: "2026-09-25T00:00:00Z" });
  c.put({ glovoKey: "k", dazogeId: "d2", confidence: 1, confirmedAt: "2026-09-26T00:00:00Z" });
  expect(c.get("k")).toEqual({ glovoKey: "k", dazogeId: "d2", confidence: 1, confirmedAt: "2026-09-26T00:00:00Z" });
});

const decrementedFlag = (id: number) =>
  (db.query("select pantry_decremented as d from meal where id = ?").get(id) as { d: number }).d;

test("cooking with one convertible and one mismatched ingredient marks cooked, decrements the first and lists the second", () => {
  const p = new PantryRepo(db);
  p.set("chicken", 1, "kg");
  p.set("eggs", 10, "pcs");
  const m = new MealsRepo(db, p);
  const [id] = m.savePlan([{ date: "2026-09-25", slot: "dinner", title: "Chicken and eggs", notes: null, ingredients: [
    { ingredient: "chicken", qty: 600, unit: "g" },
    { ingredient: "eggs", qty: 120, unit: "g" },
  ] }]);
  const r = m.mark(id!, "cooked");
  expect(r.meal.status).toBe("cooked");
  expect(r.pantrySkipped).toEqual([{ ingredient: "eggs", reason: "Cannot convert g to pcs" }]);
  expect(p.get("chicken")!.qty).toBeCloseTo(0.4);
  expect(p.get("eggs")!.qty).toBe(10);
  expect(decrementedFlag(id!)).toBe(1);
  // the decrement happened once, skips included: marking cooked again changes nothing
  const again = m.mark(id!, "cooked");
  expect(again.pantrySkipped).toEqual([]);
  expect(p.get("chicken")!.qty).toBeCloseTo(0.4);
});

test("a pantry error other than a unit mismatch rolls the whole mark back", () => {
  const p = new PantryRepo(db);
  p.set("chicken", 1, "kg");
  const m = new MealsRepo(db, p);
  const [id] = m.savePlan([{ date: "2026-09-25", slot: "dinner", title: "Roast chicken", notes: null, ingredients: [
    { ingredient: "chicken", qty: 600, unit: "g" },
  ] }]);
  p.adjust = () => { throw new Error("disk full"); };
  expect(() => m.mark(id!, "cooked")).toThrow("disk full");
  expect(m.byId(id!)!.status).toBe("planned");
  expect(decrementedFlag(id!)).toBe(0);
});

const meal = (date: string, slot: "breakfast" | "lunch" | "dinner", title: string, ingredients: { ingredient: string; qty: number; unit: string }[] = []) =>
  ({ date, slot, title, notes: null, ingredients });
const count = (table: string) => (db.query(`select count(*) as n from ${table}`).get() as { n: number }).n;

test("re-saving a plan replaces the planned meal in the same date and slot, ingredients included", () => {
  const m = new MealsRepo(db, new PantryRepo(db));
  m.savePlan([meal("2026-09-26", "dinner", "Pasta", [{ ingredient: "pasta", qty: 200, unit: "g" }]), meal("2026-09-26", "lunch", "Soup")]);
  const [risotto] = m.savePlan([meal("2026-09-26", "dinner", "Risotto", [{ ingredient: "rice", qty: 150, unit: "g" }])]);
  expect(m.upcoming(7, "2026-09-25").map((x) => x.title)).toEqual(["Soup", "Risotto"]);
  expect(count("meal")).toBe(2);
  expect(db.query("select meal_id as mealId, ingredient from meal_ingredient").all()).toEqual([{ mealId: risotto, ingredient: "rice" }]);
});

test("several meals for one slot in the same save are all kept", () => {
  const m = new MealsRepo(db, new PantryRepo(db));
  m.savePlan([meal("2026-09-26", "dinner", "Old dinner")]);
  m.savePlan([meal("2026-09-26", "dinner", "Steak"), meal("2026-09-26", "dinner", "Salad")]);
  expect(m.upcoming(7, "2026-09-25").map((x) => x.title).sort()).toEqual(["Salad", "Steak"]);
});

test("a cooked or skipped meal in the slot survives a re-save and the new meal is added alongside", () => {
  const m = new MealsRepo(db, new PantryRepo(db));
  const [cooked, skipped] = m.savePlan([meal("2026-09-25", "dinner", "Roast chicken"), meal("2026-09-25", "lunch", "Salad")]);
  m.mark(cooked!, "cooked");
  m.mark(skipped!, "skipped");
  m.savePlan([meal("2026-09-25", "dinner", "Leftover chicken"), meal("2026-09-25", "lunch", "Sandwich")]);
  expect(m.recent(0, "2026-09-25").map((x) => [x.slot, x.title, x.status])).toEqual([
    ["lunch", "Salad", "skipped"], ["lunch", "Sandwich", "planned"],
    ["dinner", "Roast chicken", "cooked"], ["dinner", "Leftover chicken", "planned"],
  ]);
});

test("upcoming lists today through today + days; recent keeps the past window", () => {
  const m = new MealsRepo(db, new PantryRepo(db));
  m.savePlan([
    meal("2026-09-24", "dinner", "Yesterday"), meal("2026-09-25", "dinner", "Today"), meal("2026-09-26", "dinner", "Tomorrow"),
    meal("2026-10-02", "dinner", "In a week"), meal("2026-10-03", "dinner", "Too far"),
  ]);
  expect(m.upcoming(7, "2026-09-25").map((x) => x.title)).toEqual(["Today", "Tomorrow", "In a week"]);
  expect(m.recent(14, "2026-09-25").map((x) => x.title)).toEqual(["Yesterday", "Today"]);
});

test("today is the Tbilisi date, so just after local midnight the new day is already today", () => {
  expect(tbilisiToday(new Date("2026-09-25T19:59:59Z"))).toBe("2026-09-25"); // 23:59:59 in Tbilisi
  expect(tbilisiToday(new Date("2026-09-25T20:30:00Z"))).toBe("2026-09-26"); // 00:30 in Tbilisi, still the 25th in UTC
  const m = new MealsRepo(db, new PantryRepo(db), () => new Date("2026-09-25T20:30:00Z"));
  m.savePlan([meal("2026-09-25", "dinner", "Last night"), meal("2026-09-26", "breakfast", "This morning")]);
  expect(m.upcoming(7).map((x) => x.title)).toEqual(["This morning"]);
  expect(m.recent(1).map((x) => x.title)).toEqual(["Last night", "This morning"]);
});
