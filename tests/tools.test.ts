import { test, expect } from "bun:test";
import { connectedClient, textOf } from "./helpers/mcp";
import { openDb } from "../src/db/index";
import { DazogeClient } from "../src/dazoge/client";
import { tbilisiToday } from "../src/planner/meals";

const fixture = (name: string) => Bun.file(`tests/fixtures/dazoge/${name}`).text();

function testDeps() {
  const db = openDb(":memory:");
  const dazoge = new DazogeClient((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/product/4860051001298.json")) return new Response(await fixture("product-4860051001298.json"), { status: 200 });
    if (url.includes("/api/search.json")) return new Response(await fixture("search-rdze.json"), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch);
  const glovoSession = async () => ({ getAuth: async () => null, refresh: async () => null, close: async () => {} });
  // any test that reaches the Glovo API without its own fake fetch fails loudly instead of calling live Glovo
  const glovoFetch = (async () => { throw new Error("live Glovo is disabled in tests"); }) as unknown as typeof fetch;
  return { db, dazoge, glovoSession, glovoFetch, preferencesPath: "data/preferences.example.md" };
}

const futureAuth = (token: string) => ({ accessToken: token, expiresAt: 4102444800, userId: 1 });

test("server lists ping and answers pong (rewrite of the Task 1 test so it never opens the real database)", async () => {
  const client = await connectedClient(testDeps());
  expect((await client.listTools()).tools.map((t) => t.name)).toContain("ping");
  expect(textOf(await client.callTool({ name: "ping", arguments: {} }))).toBe("pong");
});

test("registers the full tool set", async () => {
  const client = await connectedClient(testDeps());
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  for (const n of ["dazoge_prices", "dazoge_search", "glovo_session_status", "pantry_list", "pantry_set", "pantry_adjust",
    "meals_recent", "meals_upcoming", "meals_plan_save", "meal_mark", "delivery_record", "deliveries_recent", "note_add", "notes_recent", "preferences_read", "price_basket"]) {
    expect(names).toContain(n);
  }
});

test("dazoge_prices returns GEL-formatted prices per store as JSON", async () => {
  const client = await connectedClient(testDeps());
  const res = await client.callTool({ name: "dazoge_prices", arguments: { id: "4860051001298" } });
  const body = JSON.parse(textOf(res));
  expect(body.name).toBe("სანტე-რძე 2.5% 1ლ");
  const gw = body.prices.find((p: { storeSlug: string }) => p.storeSlug === "goodwill");
  expect(gw.price).toBe("3.99 GEL");
  expect(gw.priceTetri).toBe(399);
  expect(gw.oldPrice).toBe("6.95 GEL");
  expect(gw.oldPriceTetri).toBe(695);
  const cf = body.prices.find((p: { storeSlug: string }) => p.storeSlug === "carrefour");
  expect(cf.oldPrice).toBeNull();
  expect(cf.oldPriceTetri).toBeNull();
});

test("dazoge_search returns GEL prices with raw tetri alongside", async () => {
  const client = await connectedClient(testDeps());
  const body = JSON.parse(textOf(await client.callTool({ name: "dazoge_search", arguments: { query: "რძე" } })));
  const gw = body.items.find((i: { id: string; storeSlug: string }) => i.id === "4860051001298" && i.storeSlug === "goodwill");
  expect(gw).toMatchObject({ price: "3.99 GEL", priceTetri: 399, oldPrice: "6.95 GEL", oldPriceTetri: 695 });
});

test("glovo_session_status reports loggedIn false without a session", async () => {
  const client = await connectedClient(testDeps());
  const body = JSON.parse(textOf(await client.callTool({ name: "glovo_session_status", arguments: {} })));
  expect(body).toEqual({ loggedIn: false, hint: "Run `bun run login` in the project folder." });
});

test("glovo_session_status reports the account when the session is logged in", async () => {
  let closed = 0;
  const seen: string[] = [];
  const glovoFetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ id: 1, name: "A", deliveredOrdersCount: 33, preferredCityCode: "TBI" }), { status: 200 });
  }) as unknown as typeof fetch;
  const glovoSession = async () => ({ getAuth: async () => futureAuth("t1"), refresh: async () => null, close: async () => { closed++; } });
  const client = await connectedClient({ ...testDeps(), glovoSession, glovoFetch });
  const body = JSON.parse(textOf(await client.callTool({ name: "glovo_session_status", arguments: {} })));
  expect(body).toEqual({ loggedIn: true, name: "A", deliveredOrders: 33, city: "TBI" });
  expect(seen).toEqual(["https://api.glovoapp.com/v3/me"]);
  expect(closed).toBe(1);
});

test("glovo_session_status reports loggedIn false when Glovo rejects the token and the refreshed one", async () => {
  let closed = 0;
  let calls = 0;
  const glovoFetch = (async () => { calls++; return new Response("unauthorized", { status: 401 }); }) as unknown as typeof fetch;
  const glovoSession = async () => ({ getAuth: async () => futureAuth("t1"), refresh: async () => futureAuth("t2"), close: async () => { closed++; } });
  const client = await connectedClient({ ...testDeps(), glovoSession, glovoFetch });
  const res = await client.callTool({ name: "glovo_session_status", arguments: {} });
  expect(res.isError).toBeFalsy();
  expect(JSON.parse(textOf(res))).toEqual({ loggedIn: false, hint: "Run `bun run login` in the project folder." });
  expect(calls).toBe(2);
  expect(closed).toBe(1);
});

test("pantry and meal tools round trip through the server", async () => {
  const client = await connectedClient(testDeps());
  await client.callTool({ name: "pantry_set", arguments: { ingredient: "rice", qty: 1, unit: "kg" } });
  const ids = JSON.parse(textOf(await client.callTool({ name: "meals_plan_save", arguments: { meals: [
    { date: "2026-09-25", slot: "dinner", title: "Rice bowl", notes: null, ingredients: [{ ingredient: "rice", qty: 200, unit: "g" }] },
  ] } }))).ids as number[];
  await client.callTool({ name: "meal_mark", arguments: { id: ids[0], status: "cooked" } });
  const pantry = JSON.parse(textOf(await client.callTool({ name: "pantry_list", arguments: {} })));
  expect(pantry[0].qty).toBeCloseTo(0.8);
});

test("pantry_adjust with a mismatched unit returns an error result instead of crashing", async () => {
  const client = await connectedClient(testDeps());
  await client.callTool({ name: "pantry_set", arguments: { ingredient: "rice", qty: 1, unit: "kg" } });
  const res = await client.callTool({ name: "pantry_adjust", arguments: { ingredient: "rice", delta: 1, unit: "l" } });
  expect(res.isError).toBe(true);
  expect(textOf(res)).toMatch(/Cannot convert/);
});

test("price_basket applies the split rule and formats totals", async () => {
  const client = await connectedClient(testDeps());
  const res = await client.callTool({ name: "price_basket", arguments: {
    basket: [
      { key: "chicken", name: "Chicken", qty: 1, category: "meat" },
      { key: "milk", name: "Milk", qty: 3, category: "dairy" },
    ],
    quotes: [
      { itemKey: "chicken", store: "agrohub", unitPrice: 2500, source: "glovo" },
      { itemKey: "milk", store: "agrohub", unitPrice: 500, source: "glovo" },
      { itemKey: "milk", store: "goodwill", unitPrice: 100, source: "dazoge" },
    ],
    stores: [
      { store: "agrohub", deliveryFee: 500, minOrder: 1000 },
      { store: "goodwill", deliveryFee: 100, minOrder: 100 },
    ],
  } });
  const body = JSON.parse(textOf(res));
  expect(body.carts.length).toBe(2);
  expect(body.anchorOnlyTotal).toBe("45.00 GEL");
  expect(body.savings).toBe("11.00 GEL");
});

test("pantry_adjust on a missing ingredient with a negative delta says nothing was stored", async () => {
  const client = await connectedClient(testDeps());
  const body = JSON.parse(textOf(await client.callTool({ name: "pantry_adjust", arguments: { ingredient: "salt", delta: -5, unit: "g" } })));
  expect(body).toMatchObject({ ingredient: "salt", qty: 0, stored: false });
  expect(JSON.parse(textOf(await client.callTool({ name: "pantry_list", arguments: {} })))).toEqual([]);
  const added = JSON.parse(textOf(await client.callTool({ name: "pantry_adjust", arguments: { ingredient: "salt", delta: 5, unit: "g" } })));
  expect(added.stored).toBeUndefined();
});

test("glovo_session_status closes the browser session even when the check fails", async () => {
  let closed = 0;
  const deps = { ...testDeps(), glovoSession: async () => ({
    getAuth: async () => { throw new Error("browser crashed"); }, refresh: async () => null, close: async () => { closed++; },
  }) };
  const client = await connectedClient(deps);
  const res = await client.callTool({ name: "glovo_session_status", arguments: {} });
  expect(res.isError).toBe(true);
  expect(textOf(res)).toBe("browser crashed");
  expect(closed).toBe(1);
});

const delivery = (glovoOrderId: string, placedAt?: string) => ({
  glovoOrderId, store: "agrohub", ...(placedAt === undefined ? {} : { placedAt }),
  items: [{ productName: "Santé milk 2.5% 1L", ingredient: "milk", qty: 1, unit: "l", lineTotalTetri: 399 }],
});

test("delivery_record rejects a placedAt that is not an ISO datetime", async () => {
  const client = await connectedClient(testDeps());
  const res = await client.callTool({ name: "delivery_record", arguments: delivery("o-1", "yesterday") });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(await client.callTool({ name: "deliveries_recent", arguments: {} })))).toEqual([]);
});

test("deliveries_recent orders by real time when placedAt values carry different offsets", async () => {
  const client = await connectedClient(testDeps());
  // 01:00+04:00 is 21:00Z on the 24th, an hour before the second order
  await client.callTool({ name: "delivery_record", arguments: delivery("early", "2026-09-25T01:00:00+04:00") });
  await client.callTool({ name: "delivery_record", arguments: delivery("late", "2026-09-24T22:00:00Z") });
  const rows = JSON.parse(textOf(await client.callTool({ name: "deliveries_recent", arguments: {} })));
  expect(rows.map((r: { glovoOrderId: string }) => r.glovoOrderId)).toEqual(["late", "early"]);
  expect(rows[1].placedAt).toBe("2026-09-24T21:00:00.000Z");
  expect(rows[0].total).toBe("3.99 GEL");
});

test("tool descriptions state the units and pantry semantics Claude needs", async () => {
  const client = await connectedClient(testDeps());
  const desc = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.description ?? ""]));
  expect(desc.price_basket).toMatch(/integer tetri/);
  for (const field of ["unitPrice", "deliveryFee", "minOrder", "marginTetri"]) expect(desc.price_basket).toContain(field);
  expect(desc.delivery_record).toMatch(/pantry key/);
  expect(desc.delivery_record).toContain("lineTotalTetri");
  expect(desc.delivery_record).toContain(`{productName:"Eggs 10", lineTotalTetri:550, qty:10, unit:"pcs", ingredient:"eggs"}`);
  expect(desc.delivery_record).toContain("ISO 8601 with seconds and offset, e.g. 2026-09-25T10:15:00+04:00");
  expect(desc.delivery_record).not.toContain("priceTetri");
  expect(desc.meal_mark).toBe("Mark a meal planned, cooked or skipped. The first transition to cooked decrements the pantry once; " +
    "ingredients whose unit cannot convert are listed in pantrySkipped.");
  expect(desc.meals_plan_save).toMatch(/re-saving replaces planned meals in the same date and slot/i);
  expect(desc.meals_upcoming).toMatch(/today/);
  expect(desc.delivery_record).toMatch(/filed under productName/);
  expect(desc.dazoge_search).toBe("Search Dazoge by product name. Use Georgian words for generic foods (e.g. 'რძე' for milk, " +
    "'კვერცხი' for eggs); Latin works for brand names. Results include non-food items from pharmacies; ignore those. " +
    "Returns one row per product per store with prices in tetri and GEL.");
  expect(desc.price_basket).toContain("qty is the number of quoted packs (a 'chicken 800 g' pack is qty 1, not 800).");
  expect(desc.price_basket).toContain("Store keys must match across basket quotes, stores and anchorStore; use Dazoge storeSlug values " +
    "(agrohub, goodwill, carrefour, spar, ...).");
  expect(desc.price_basket).toContain("Delivery fees and minimums are not known to this server yet; ask the user or use the last seen values.");
  expect(desc.pantry_adjust).toMatch(/floor at zero/);
  expect(desc.pantry_adjust).toContain("stored: false");
});

test("delivery_record totals line totals, fills the pantry with physical amounts and rejects the old priceTetri shape", async () => {
  const client = await connectedClient(testDeps());
  const res = await client.callTool({ name: "delivery_record", arguments: { glovoOrderId: "o-2", store: "agrohub", items: [
    { productName: "Eggs 10", lineTotalTetri: 550, qty: 10, unit: "pcs", ingredient: "eggs" },
    { productName: "Chicken breast 800 g", lineTotalTetri: 1520, qty: 0.8, unit: "kg", ingredient: "chicken" },
  ] } });
  expect(JSON.parse(textOf(res)).total).toBe("20.70 GEL");
  const pantry = JSON.parse(textOf(await client.callTool({ name: "pantry_list", arguments: {} })));
  expect(pantry.map((r: { ingredient: string; qty: number; unit: string }) => [r.ingredient, r.qty, r.unit])).toEqual([["chicken", 0.8, "kg"], ["eggs", 10, "pcs"]]);
  const old = await client.callTool({ name: "delivery_record", arguments: { glovoOrderId: "o-3", store: "agrohub", items: [
    { productName: "Eggs 10", priceTetri: 550, qty: 1, unit: "pcs" },
  ] } });
  expect(old.isError).toBe(true);
  const fractional = await client.callTool({ name: "delivery_record", arguments: { glovoOrderId: "o-4", store: "agrohub", items: [
    { productName: "Eggs 10", lineTotalTetri: 5.5, qty: 10, unit: "pcs" },
  ] } });
  expect(fractional.isError).toBe(true);
});

test("meal_mark returns the meal and the ingredients the pantry could not take", async () => {
  const client = await connectedClient(testDeps());
  await client.callTool({ name: "pantry_set", arguments: { ingredient: "eggs", qty: 10, unit: "pcs" } });
  await client.callTool({ name: "pantry_set", arguments: { ingredient: "rice", qty: 1, unit: "kg" } });
  const [id] = JSON.parse(textOf(await client.callTool({ name: "meals_plan_save", arguments: { meals: [
    { date: "2026-09-25", slot: "dinner", title: "Egg fried rice", ingredients: [
      { ingredient: "rice", qty: 200, unit: "g" }, { ingredient: "eggs", qty: 100, unit: "g" },
    ] },
  ] } }))).ids as number[];
  const body = JSON.parse(textOf(await client.callTool({ name: "meal_mark", arguments: { id, status: "cooked" } })));
  expect(body.meal).toMatchObject({ id, status: "cooked", title: "Egg fried rice" });
  expect(body.pantrySkipped).toEqual([{ ingredient: "eggs", reason: "Cannot convert g to pcs" }]);
});

test("meals_upcoming lists the plan ahead from today in Tbilisi, and a re-saved slot shows once", async () => {
  const client = await connectedClient(testDeps());
  const shift = (days: number) => new Date(Date.parse(`${tbilisiToday()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  // dates are relative to the test's today; a tomorrow meal is listed even if Tbilisi midnight passes mid-test
  const save = (date: string, title: string) => client.callTool({ name: "meals_plan_save", arguments: { meals: [
    { date, slot: "dinner", title, ingredients: [] },
  ] } });
  await save(shift(-1), "Yesterday");
  await save(shift(1), "Tomorrow draft");
  await save(shift(1), "Tomorrow");
  await save(shift(30), "Next month");
  const upcoming = JSON.parse(textOf(await client.callTool({ name: "meals_upcoming", arguments: {} })));
  expect(upcoming.map((m: { title: string }) => m.title)).toEqual(["Tomorrow"]);
  const recent = JSON.parse(textOf(await client.callTool({ name: "meals_recent", arguments: {} })));
  expect(recent.map((m: { title: string }) => m.title)).toContain("Yesterday");
});

test("price_basket rejects a zero unitPrice: 0 is not a price", async () => {
  const client = await connectedClient(testDeps());
  const res = await client.callTool({ name: "price_basket", arguments: {
    basket: [{ key: "milk", name: "Milk", qty: 1, category: "dairy" }],
    quotes: [{ itemKey: "milk", store: "agrohub", unitPrice: 0, source: "glovo" }],
    stores: [{ store: "agrohub", deliveryFee: 500, minOrder: 1000 }],
  } });
  expect(res.isError).toBe(true);
  expect(textOf(res)).toMatch(/unitPrice/);
});

test("preferences_read explains what to do when the preferences file is missing", async () => {
  const client = await connectedClient({ ...testDeps(), preferencesPath: "data/does-not-exist.md" });
  const res = await client.callTool({ name: "preferences_read", arguments: {} });
  expect(res.isError).toBe(true);
  expect(textOf(res)).toContain("preferences.example.md");
});
