import { test, expect } from "bun:test";
import { DazogeClient } from "../src/dazoge/client";
import { storeSlug } from "../src/dazoge/stores";

const fixture = (name: string) => Bun.file(`tests/fixtures/dazoge/${name}`).text();

function fakeFetch(routes: Record<string, { status: number; body: string }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const hit = routes[url];
    if (!hit) return new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(hit.body, { status: hit.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("storeSlug maps known Georgian names and returns null for unknown", () => {
  expect(storeSlug("აგროჰაბი")).toBe("agrohub");
  expect(storeSlug("გუდვილი")).toBe("goodwill");
  expect(storeSlug("კარფური")).toBe("carrefour");
  expect(storeSlug("სპარი")).toBe("spar");
  expect(storeSlug(" ორი ნაბიჯი ")).toBe("2nabiji");
  expect(storeSlug("unknown shop")).toBeNull();
});

test("getProduct parses prices in tetri and tags store slugs", async () => {
  const body = await fixture("product-4860051001298.json");
  const client = new DazogeClient(
    fakeFetch({ "https://www.dazoge.info/api/product/4860051001298.json": { status: 200, body } }),
  );
  const p = await client.getProduct("4860051001298");
  expect(p).not.toBeNull();
  expect(p!.id).toBe("4860051001298");
  expect(p!.name).toBe("სანტე-რძე 2.5% 1ლ");
  const goodwill = p!.prices.find((x) => x.storeSlug === "goodwill");
  expect(goodwill).toEqual({ store: "გუდვილი", storeSlug: "goodwill", price: 399, oldPrice: 695 });
  const carrefour = p!.prices.find((x) => x.storeSlug === "carrefour");
  expect(carrefour!.oldPrice).toBeNull(); // old_price 0 means no old price
});

test("getProduct returns null on 404", async () => {
  const client = new DazogeClient(fakeFetch({}));
  expect(await client.getProduct("0000000000000")).toBeNull();
});

test("search encodes Georgian queries once and extracts ids from href", async () => {
  const body = await fixture("search-rdze.json");
  const seen: string[] = [];
  const f: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new DazogeClient(f);
  const page = await client.search("რძე");
  expect(seen[0]).toBe("https://www.dazoge.info/api/search.json?q=%E1%83%A0%E1%83%AB%E1%83%94&page=1");
  expect(page.query).toBe("რძე");
  expect(page.page).toBe(1);
  expect(page.hasMore).toBe(true);
  expect(page.items[0]).toEqual({
    id: "4860051003018",
    name: "სანტე-რძე 3.2% 1ლ",
    volume: "1 ლ",
    price: 499,
    oldPrice: 595,
    store: "სპარი",
    storeSlug: "spar",
  });
});

test("search with empty results yields empty items and hasMore false", async () => {
  const client = new DazogeClient(
    fakeFetch({
      "https://www.dazoge.info/api/search.json?q=zzzz&page=1": {
        status: 200,
        body: JSON.stringify({ q: "zzzz", page: 1, items: [], hasMore: false }),
      },
    }),
  );
  const page = await client.search("zzzz");
  expect(page.items).toEqual([]);
  expect(page.hasMore).toBe(false);
});

test("search passes page number through", async () => {
  const seen: string[] = [];
  const f: typeof fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ q: "milk", page: 2, items: [], hasMore: false }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  await new DazogeClient(f).search("milk", 2);
  expect(seen[0]).toContain("&page=2");
});
