import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, migrate } from "../src/db/index";
import { MIGRATIONS } from "../src/db/schema";
import { convertQty, UnitMismatchError } from "../src/planner/units";
import { PantryRepo } from "../src/planner/pantry";
import { MealsRepo } from "../src/planner/meals";
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
  expect(cooked.status).toBe("cooked");
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
  expect(m.mark(id!, "skipped").status).toBe("skipped");
  expect(p.get("chicken")!.qty).toBeCloseTo(0.4);
  expect(m.mark(id!, "cooked").status).toBe("cooked");
  expect(p.get("chicken")!.qty).toBeCloseTo(0.4);
});

test("delivery record stores items, computes total, increments pantry by ingredient", () => {
  const p = new PantryRepo(db);
  p.set("milk", 1, "l");
  const d = new DeliveriesRepo(db, p);
  const r = d.record({
    glovoOrderId: "G-1", store: "goodwill",
    items: [
      { productName: "Sante milk 1L", qty: 3, unit: "l", priceTetri: 399, ingredient: "milk" },
      { productName: "Eggs 10", qty: 1, unit: "pcs", priceTetri: 550 },
    ],
  });
  expect(r.total).toBe(3 * 399 + 550);
  expect(p.list().find((x) => x.ingredient === "milk")!.qty).toBe(4);
  expect(p.list().find((x) => x.ingredient === "Eggs 10")!.qty).toBe(1);
  expect(d.recent(5)[0]).toMatchObject({ glovoOrderId: "G-1", store: "goodwill", total: r.total, status: "placed" });
});

test("delivery record rolls back the delivery, its items and earlier pantry increments on a unit mismatch", () => {
  const p = new PantryRepo(db);
  p.set("milk", 1, "l");
  const d = new DeliveriesRepo(db, p);
  expect(() => d.record({
    glovoOrderId: "G-2", store: "goodwill",
    items: [
      { productName: "Sante milk 1L", qty: 2, unit: "l", priceTetri: 399, ingredient: "milk" },
      { productName: "Milk powder", qty: 500, unit: "g", priceTetri: 900, ingredient: "milk" },
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
      { productName: "Onion", qty: 2, unit: "pcs", priceTetri: 120, ingredient: "onion" },
      { productName: "Eggs 10", qty: 1, unit: "pcs", priceTetri: 550, ingredient: "eggs" },
    ],
  });
  expect(p.get("onion")).toMatchObject({ qty: 2, unit: "pcs" });
  expect(p.get("eggs")).toMatchObject({ qty: 1, unit: "pcs" });
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
