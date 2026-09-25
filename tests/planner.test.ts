import { test, expect, beforeEach } from "bun:test";
import { openDb } from "../src/db/index";
import { convertQty, UnitMismatchError } from "../src/planner/units";
import { PantryRepo } from "../src/planner/pantry";
import { MealsRepo } from "../src/planner/meals";
import { DeliveriesRepo } from "../src/planner/deliveries";
import { NotesRepo } from "../src/planner/notes";
import { SqliteMatchCache } from "../src/planner/matchCache";

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(":memory:"); });

test("openDb is idempotent and creates the tables", () => {
  openDb(":memory:");
  const names = db.query("select name from sqlite_master where type='table' order by name").all() as { name: string }[];
  const set = new Set(names.map((n) => n.name));
  for (const t of ["product", "product_match", "delivery", "delivery_item", "meal", "meal_ingredient", "pantry", "note", "checkout_log"]) expect(set.has(t)).toBe(true);
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
