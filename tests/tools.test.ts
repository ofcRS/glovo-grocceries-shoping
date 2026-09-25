import { test, expect } from "bun:test";
import { connectedClient, textOf } from "./helpers/mcp";
import { openDb } from "../src/db/index";
import { DazogeClient } from "../src/dazoge/client";

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
  return { db, dazoge, glovoSession, glovoFetch, preferencesPath: "data/preferences.md" };
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
    "meals_recent", "meals_plan_save", "meal_mark", "delivery_record", "deliveries_recent", "note_add", "notes_recent", "preferences_read", "price_basket"]) {
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
  items: [{ productName: "Santé milk 2.5% 1L", ingredient: "milk", qty: 1, unit: "l", priceTetri: 399 }],
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
  expect(desc.delivery_record).toMatch(/filed under productName/);
  expect(desc.pantry_adjust).toMatch(/floor at zero/);
  expect(desc.pantry_adjust).toContain("stored: false");
});
