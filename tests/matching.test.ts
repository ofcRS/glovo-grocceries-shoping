import { test, expect } from "bun:test";
import { normalizeName } from "../src/matching/normalize";
import { scoreCandidate, hasConflict, coversTarget, THRESHOLDS } from "../src/matching/score";
import { resolve, MemoryMatchCache, type MatchResult } from "../src/matching/resolver";
import { DazogeClient } from "../src/dazoge/client";
import type { DazogeProduct, DazogeSearchPage } from "../src/dazoge/types";

test("normalizeName extracts volume, weight, percent and lowercased tokens across scripts", () => {
  expect(normalizeName("სანტე-რძე 2.5% 1ლ")).toEqual({ tokens: ["სანტე", "რძე"], volumeMl: 1000, weightG: null, percent: 2.5, count: null });
  expect(normalizeName("Sante Milk 2,5% 1 L")).toEqual({ tokens: ["სანტე", "რძე"], volumeMl: 1000, weightG: null, percent: 2.5, count: null });
  expect(normalizeName("ყველი ბრი /Milky Lux / 1კგ")).toEqual({ tokens: ["ყველი", "ბრი", "milky", "lux"], volumeMl: null, weightG: 1000, percent: null, count: null });
  expect(normalizeName("PALMOLIVE Milk&Olive 90 გრ.")).toEqual({ tokens: ["palmolive", "რძე", "olive"], volumeMl: null, weightG: 90, percent: null, count: null });
  expect(normalizeName("Eggs 10 pcs 500ml")).toEqual({ tokens: ["კვერცხი"], volumeMl: 500, weightG: null, percent: null, count: 10 });
  // A number followed by a word is not a quantity. Dazoge's own parser read "5152 ლ" out of this sponge's name.
  expect(normalizeName("აბაზანის ღრუბელი გრძელი 5152 ლიონესი - Lionesse").volumeMl).toBeNull();
  expect(normalizeName("Bread 7 grains 500g").weightG).toBe(500);
});

test("normalizeName multiplies packs into the quantity and parses piece counts", () => {
  expect(normalizeName("Water 6 x 0.5L")).toEqual({ tokens: ["წყალი"], volumeMl: 3000, weightG: null, percent: null, count: null });
  expect(normalizeName("წყალი 6x0.5ლ")).toEqual({ tokens: ["წყალი"], volumeMl: 3000, weightG: null, percent: null, count: null });
  expect(normalizeName("Juice 2×1L").volumeMl).toBe(2000);
  expect(normalizeName("Snickers 4x50g").weightG).toBe(200);
  expect(normalizeName("აროიდ-ქოქოსის რძე 400მლ - 2 ცალი")).toEqual({ tokens: ["აროიდ", "ქოქოსის", "რძე"], volumeMl: 400, weightG: null, percent: null, count: 2 });
  expect(normalizeName("კვერცხი 10 ც")).toEqual({ tokens: ["კვერცხი"], volumeMl: null, weightG: null, percent: null, count: 10 });
  expect(normalizeName("Eggs 2 x 10 pcs").count).toBe(20); // a multiplier with no volume or weight multiplies the count
  expect(normalizeName("კვერცხი (ცალი)").tokens).toEqual(["კვერცხი"]); // sold per piece: the unit word is not a token
});

test("scoreCandidate rewards token overlap and matching quantities", () => {
  const a = normalizeName("Sante Milk 2.5% 1L");
  const same = normalizeName("სანტე-რძე 2.5% 1ლ");
  const otherFat = normalizeName("სანტე-რძე 3.2% 1ლ");
  const unrelated = normalizeName("PALMOLIVE Milk&Olive 90 გრ.");
  expect(scoreCandidate(a, same)).toBeGreaterThanOrEqual(THRESHOLDS.accept);
  expect(scoreCandidate(a, otherFat)).toBeLessThan(scoreCandidate(a, same));
  expect(scoreCandidate(a, otherFat)).toBeGreaterThanOrEqual(THRESHOLDS.consider);
  expect(scoreCandidate(a, unrelated)).toBeLessThan(THRESHOLDS.consider);
});

test("scoreCandidate treats quantities within 5% as equal and a different pack size as a mismatch", () => {
  const a = normalizeName("Sante Milk 2.5% 1L");
  expect(scoreCandidate(a, normalizeName("სანტე-რძე 2.5% 970მლ"))).toBe(1);
  expect(scoreCandidate(a, normalizeName("სანტე-რძე 2.5% 900მლ"))).toBeCloseTo(0.75, 10);
});

test("hasConflict needs both sides known and different; coversTarget needs every target token", () => {
  const milk = normalizeName("Sante Milk 2.5% 1L");
  expect(hasConflict(milk, normalizeName("სანტე-რძე 3.2% 1ლ"))).toBe(true); // percent
  expect(hasConflict(milk, normalizeName("სანტე-რძე 2.5% 2ლ"))).toBe(true); // volume
  expect(hasConflict(normalizeName("Eggs 10 pcs"), normalizeName("კვერცხი 30 ც"))).toBe(true); // count
  expect(hasConflict(milk, normalizeName("სანტე-რძე 1ლ"))).toBe(false); // percent unknown on one side
  expect(hasConflict(milk, normalizeName("სანტე-რძე 2.5% 970მლ"))).toBe(false); // within 5%
  expect(hasConflict(normalizeName("Yogurt 0% 400g"), normalizeName("იოგურტი 0% 400გ"))).toBe(false); // 0% equals 0%
  expect(coversTarget(milk, normalizeName("სანტე ულტრაპასტერიზებული რძე 2.5% 1ლ"))).toBe(true);
  expect(coversTarget(normalizeName("Sante Strawberry Yogurt 2.5% 400g"), normalizeName("სანტე იოგურტი 2.5% 400გ"))).toBe(false);
  expect(coversTarget(normalizeName("1L"), normalizeName("რძე 1ლ"))).toBe(false); // no target tokens
});

const product = (id: string, name: string): DazogeProduct => ({ id, name, volume: "", imageUrl: "", prices: [] });
const page = (items: Array<{ id: string; name: string }>): DazogeSearchPage => ({
  query: "", page: 1, hasMore: false,
  items: items.map((i) => ({ ...i, volume: "", price: 1, oldPrice: null, store: "x", storeSlug: null })),
});

test("resolve uses the cache first", async () => {
  const cache = new MemoryMatchCache();
  cache.put({ glovoKey: "g1", dazogeId: "d1", confidence: 1, confirmedAt: "2026-01-01" });
  const dazoge = { search: async () => { throw new Error("should not search"); }, getProduct: async () => null };
  expect(await resolve({ key: "g1", name: "anything" }, { dazoge, cache })).toEqual({ status: "matched", dazogeId: "d1", confidence: 1, via: "cache" });
});

test("resolve matches by barcode when Dazoge knows it, and caches", async () => {
  const cache = new MemoryMatchCache();
  const dazoge = { search: async () => page([]), getProduct: async (id: string) => (id === "4860051001298" ? product(id, "სანტე-რძე 2.5% 1ლ") : null) };
  const r = await resolve({ key: "g2", name: "Sante milk", barcode: "4860051001298" }, { dazoge, cache });
  expect(r).toEqual({ status: "matched", dazogeId: "4860051001298", confidence: 1, via: "barcode" });
  expect(cache.get("g2")?.dazogeId).toBe("4860051001298");
});

test("resolve falls back to name search when barcode is unknown to Dazoge", async () => {
  const cache = new MemoryMatchCache();
  let query = "";
  const dazoge = {
    getProduct: async () => null,
    search: async (q: string) => {
      query = q;
      return page([{ id: "4860051001298", name: "სანტე-რძე 2.5% 1ლ" }, { id: "4860051003018", name: "სანტე-რძე 3.2% 1ლ" }]);
    },
  };
  const r = await resolve({ key: "g3", name: "Sante Milk 2.5% 1L", barcode: "999" }, { dazoge, cache });
  expect(query).toBe("სანტე რძე"); // Dazoge is Georgian: a Latin "milk" search returns cosmetics, so aliases are searched
  expect(r.status).toBe("matched");
  if (r.status === "matched") { expect(r.dazogeId).toBe("4860051001298"); expect(r.via).toBe("name"); }
  expect(cache.get("g3")?.dazogeId).toBe("4860051001298");
});

test("resolve returns ambiguous candidates and does not cache them", async () => {
  const cache = new MemoryMatchCache();
  const dazoge = {
    getProduct: async () => null,
    search: async () => page([{ id: "a", name: "სანტე-რძე 3.2% 1ლ" }, { id: "b", name: "სანტე-რძე 1.5% 1ლ" }]),
  };
  const r = await resolve({ key: "g4", name: "Sante Milk 1L" }, { dazoge, cache });
  expect(r.status).toBe("ambiguous");
  if (r.status === "ambiguous") {
    expect(r.candidates.length).toBe(2);
    // A percent missing on the Glovo side counts against both fat variants equally: 0.6 + 0.25 + 0 = 0.85.
    for (const c of r.candidates) expect(c.score).toBeCloseTo(0.85, 10);
  }
  expect(cache.get("g4")).toBeNull();
});

test("resolve returns none when nothing scores above consider", async () => {
  const cache = new MemoryMatchCache();
  const dazoge = { getProduct: async () => null, search: async () => page([{ id: "z", name: "PALMOLIVE Milk&Olive 90 გრ." }]) };
  expect(await resolve({ key: "g5", name: "Sante Milk 2.5% 1L" }, { dazoge, cache })).toEqual({ status: "none" });
});

test("resolve accepts a lone candidate at accept or above, counting per-store duplicate rows once", async () => {
  const cache = new MemoryMatchCache();
  // Tokens overlap 2 of 3, volume and percent match: 0.6 * 2/3 + 0.25 + 0.15 = 0.8.
  const name = "სანტე რძე ულტრაპასტერიზებული 2.5% 1ლ";
  const dazoge = { getProduct: async () => null, search: async () => page([{ id: "u", name }, { id: "u", name }]) };
  const r = await resolve({ key: "g6", name: "Sante Milk 2.5% 1L" }, { dazoge, cache });
  expect(r.status).toBe("matched");
  if (r.status === "matched") { expect(r.dazogeId).toBe("u"); expect(r.confidence).toBeCloseTo(0.8, 10); expect(r.via).toBe("name"); }
  expect(cache.get("g6")?.dazogeId).toBe("u");
  expect(cache.get("g6")?.confidence).toBe(0.8); // rounded to 3 decimals, not 0.7999999999999999
});

test("resolve leaves a lone candidate below accept ambiguous, drops junk below consider, and caches nothing", async () => {
  const cache = new MemoryMatchCache();
  const dazoge = {
    getProduct: async () => null,
    // Lactose-free: tokens overlap 2 of 4, volume and percent match: 0.6 * 1/2 + 0.25 + 0.15 = 0.7. Soap: 0.6 * 1/4 = 0.15.
    search: async () => page([{ id: "lf", name: "სანტე რძე ულაქტოზო მსუბუქი 2.5% 1ლ" }, { id: "soap", name: "PALMOLIVE Milk&Olive 90 გრ." }]),
  };
  const r = await resolve({ key: "g7", name: "Sante Milk 2.5% 1L" }, { dazoge, cache });
  expect(r.status).toBe("ambiguous");
  if (r.status === "ambiguous") {
    expect(r.candidates.map((c) => c.dazogeId)).toEqual(["lf"]);
    expect(r.candidates[0]!.score).toBeCloseTo(0.7, 10);
  }
  expect(cache.get("g7")).toBeNull();
});

const fixtureClient = async (file: string) => {
  const body = await Bun.file(`${import.meta.dir}/fixtures/dazoge/${file}`).text();
  return new DazogeClient((async (_input: RequestInfo | URL) => new Response(body, { status: 200 })) as typeof fetch);
};

test("resolve on recorded Dazoge pages: Georgian milk results match, cosmetics from a Latin 'milk' search do not", async () => {
  const glovo = { key: "g8", name: "Sante Milk 2.5% 1L" };
  const rdze = await resolve(glovo, { dazoge: await fixtureClient("search-rdze.json"), cache: new MemoryMatchCache() });
  expect(rdze).toEqual({ status: "matched", dazogeId: "4860051001298", confidence: 1, via: "name" });
  const milk = await resolve(glovo, { dazoge: await fixtureClient("search-milk.json"), cache: new MemoryMatchCache() });
  expect(milk).toEqual({ status: "none" });
});

// Fix round 1: a known attribute conflict, an uncovered Glovo word or a differing pack never auto-accepts.

const searchOnly = (items: Array<{ id: string; name: string }>) => ({ getProduct: async () => null, search: async () => page(items) });
const flags = (r: MatchResult) =>
  r.status === "ambiguous" ? r.candidates.map((c) => [c.dazogeId, c.conflict, c.covers]) : r;

test("resolve does not auto-accept a lone candidate with the wrong fat percent", async () => {
  const cache = new MemoryMatchCache();
  const r = await resolve({ key: "c1", name: "Sante Milk 2.5% 1L" }, { dazoge: searchOnly([{ id: "f32", name: "სანტე-რძე 3.2% 1ლ" }]), cache });
  expect(r).toEqual({ status: "ambiguous", candidates: [{ dazogeId: "f32", name: "სანტე-რძე 3.2% 1ლ", score: 0.85, conflict: true, covers: true }] });
  expect(cache.get("c1")).toBeNull();
});

test("resolve does not let a wrong-fat candidate beat a correct long-named one", async () => {
  const cache = new MemoryMatchCache();
  const dazoge = searchOnly([
    { id: "f32", name: "სანტე-რძე 3.2% 1ლ" }, // 0.85, conflicts on percent
    { id: "loko", name: "სანტე ულტრაპასტერიზებული რძე ვიტამინებით ლოკო მოკო 2.5% 1 ლ" }, // 0.6: covers, no conflict, below accept
  ]);
  const r = await resolve({ key: "c2", name: "Sante Milk 2.5% 1L" }, { dazoge, cache });
  expect(flags(r)).toEqual([["f32", true, true], ["loko", false, true]]);
  expect(cache.get("c2")).toBeNull();
});

test("resolve does not auto-accept a lone candidate with the wrong pack size", async () => {
  const cache = new MemoryMatchCache();
  const r = await resolve({ key: "c3", name: "Sante Milk 2.5% 1L" }, { dazoge: searchOnly([{ id: "two", name: "სანტე-რძე 2.5% 2ლ" }]), cache });
  expect(r).toEqual({ status: "ambiguous", candidates: [{ dazogeId: "two", name: "სანტე-რძე 2.5% 2ლ", score: 0.75, conflict: true, covers: true }] });
  expect(cache.get("c3")).toBeNull();
});

test("resolve does not auto-accept a plainer variant that misses a Glovo word (strawberry is not aliased)", async () => {
  const cache = new MemoryMatchCache();
  const dazoge = searchOnly([
    { id: "plain", name: "სანტე იოგურტი 2.5% 400გ" }, // 0.8
    { id: "straw", name: "სანტე იოგურტი მარწყვის გემოთი 2.5% 400გ" }, // 0.64
  ]);
  const r = await resolve({ key: "c4", name: "Sante Strawberry Yogurt 2.5% 400g" }, { dazoge, cache });
  expect(flags(r)).toEqual([["plain", false, false], ["straw", false, false]]);
  expect(cache.get("c4")).toBeNull();
});

test("resolve treats a 6 x 0.5L pack as 3L: a single bottle conflicts, the matching pack is accepted", async () => {
  const single = { id: "single", name: "წყალი 0.5ლ" };
  const cache = new MemoryMatchCache();
  const lone = await resolve({ key: "c5", name: "Water 6 x 0.5L" }, { dazoge: searchOnly([single]), cache });
  expect(flags(lone)).toEqual([["single", true, true]]);
  expect(cache.get("c5")).toBeNull();
  const both = await resolve({ key: "c5", name: "Water 6 x 0.5L" }, { dazoge: searchOnly([single, { id: "pack", name: "წყალი 6x0.5ლ" }]), cache });
  expect(both).toEqual({ status: "matched", dazogeId: "pack", confidence: 1, via: "name" });
  expect(cache.get("c5")?.dazogeId).toBe("pack");
});

test("resolve blocks auto-accept when piece counts differ and accepts when they agree", async () => {
  const glovo = { key: "c6", name: "Eggs 10 pcs" };
  const thirty = await resolve(glovo, { dazoge: searchOnly([{ id: "e30", name: "კვერცხი 30 ც" }]), cache: new MemoryMatchCache() });
  expect(flags(thirty)).toEqual([["e30", true, true]]);
  const ten = await resolve(glovo, { dazoge: searchOnly([{ id: "e10", name: "კვერცხი 10 ც" }]), cache: new MemoryMatchCache() });
  expect(ten).toEqual({ status: "matched", dazogeId: "e10", confidence: 1, via: "name" });
});

test("resolve counts a gap of exactly 0.1 as clear, despite floating point (0.7999999999999999 vs 0.7000000000000001)", async () => {
  const dazoge = searchOnly([
    { id: "u", name: "სანტე რძე ულტრაპასტერიზებული 2.5% 1ლ" }, // 0.8
    { id: "lf", name: "სანტე რძე ულაქტოზო მსუბუქი 2.5% 1ლ" }, // 0.7
  ]);
  const r = await resolve({ key: "c7", name: "Sante Milk 2.5% 1L" }, { dazoge, cache: new MemoryMatchCache() });
  expect(r).toEqual({ status: "matched", dazogeId: "u", confidence: 0.8, via: "name" });
});
