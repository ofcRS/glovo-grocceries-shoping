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
  return { db, dazoge, glovoSession, preferencesPath: "data/preferences.md" };
}

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
});

test("glovo_session_status reports loggedIn false without a session", async () => {
  const client = await connectedClient(testDeps());
  const body = JSON.parse(textOf(await client.callTool({ name: "glovo_session_status", arguments: {} })));
  expect(body).toEqual({ loggedIn: false, hint: "Run `bun run login` in the project folder." });
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
