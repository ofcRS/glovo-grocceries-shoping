import { test, expect } from "bun:test";
import { decideSplit, DEFAULT_SPLIT_CONFIG } from "../src/pricing/split";
import type { BasketItem, ItemQuote, StoreInfo } from "../src/pricing/types";

const stores: StoreInfo[] = [
  { store: "agrohub", deliveryFee: 500, minOrder: 2000 },
  { store: "goodwill", deliveryFee: 400, minOrder: 1500 },
  { store: "carrefour", deliveryFee: 300, minOrder: 1500 },
];

const basket: BasketItem[] = [
  { key: "chicken", name: "Chicken thighs 1kg", qty: 1, category: "meat" },
  { key: "apples", name: "Apples 1kg", qty: 1, category: "fruit" },
  { key: "milk", name: "Milk 1L", qty: 3, category: "dairy" },
  { key: "rice", name: "Rice 1kg", qty: 1, category: "grain" },
  { key: "eggs", name: "Eggs 10", qty: 1, category: "other" },
];

const q = (itemKey: string, store: string, unitPrice: number, source: "glovo" | "dazoge" = "glovo"): ItemQuote =>
  ({ itemKey, store, unitPrice, source });

test("splits when the alternative store saves more than fee plus margin", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
    q("milk", "goodwill", 400), q("rice", "goodwill", 300), q("eggs", "goodwill", 500),
    q("milk", "carrefour", 450), q("rice", "carrefour", 600), q("eggs", "carrefour", 900),
  ];
  const d = decideSplit(basket, quotes, stores);
  // anchor only: 2500+900+1500+800+1200 = 6900 + fee 500 = 7400
  expect(d.anchorOnlyTotal).toBe(7400);
  expect(d.carts.map((c) => c.store)).toEqual(["agrohub", "goodwill"]);
  const [ag, gw] = d.carts;
  expect(ag!.lines.map((l) => l.itemKey)).toEqual(["chicken", "apples"]);
  expect(ag!.subtotal).toBe(3400); expect(ag!.total).toBe(3900);
  expect(gw!.lines.map((l) => l.itemKey)).toEqual(["milk", "rice", "eggs"]);
  expect(gw!.subtotal).toBe(1200 + 300 + 500); expect(gw!.total).toBe(2400);
  expect(d.savings).toBe(7400 - 3900 - 2400); // 1100 > margin 1000
  expect(d.unpriced).toEqual([]);
});

test("does not split when savings are within the margin", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
    q("milk", "goodwill", 450), q("rice", "goodwill", 700), q("eggs", "goodwill", 1100),
  ];
  const d = decideSplit(basket, quotes, stores);
  expect(d.carts.length).toBe(1);
  expect(d.carts[0]!.store).toBe("agrohub");
  expect(d.carts[0]!.total).toBe(7400);
  expect(d.savings).toBe(0);
  expect(d.reason).toMatch(/margin/i);
});

test("protected categories never leave the anchor even when cheaper elsewhere", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
    q("chicken", "goodwill", 100), q("apples", "goodwill", 100),
    // goodwill cart must clear its 1500 minimum or no split happens at all (see the minimum test below)
    q("milk", "goodwill", 400), q("rice", "goodwill", 300), q("eggs", "goodwill", 500),
  ];
  const d = decideSplit(basket, quotes, stores);
  expect(d.carts.length).toBe(2);
  const ag = d.carts.find((c) => c.store === "agrohub")!;
  expect(ag.lines.map((l) => l.itemKey).sort()).toEqual(["apples", "chicken"]);
});

test("no split when the alternative cart would miss the store minimum (Review Focus 4)", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
    q("milk", "goodwill", 100), q("rice", "goodwill", 100), q("eggs", "goodwill", 100), // subtotal 500 < 1500
  ];
  const d = decideSplit(basket, quotes, stores);
  expect(d.carts.length).toBe(1);
  expect(d.reason).toMatch(/minimum/i);
  expect(d.reason).toMatch(/goodwill/);
});

test("items unquoted at the alternative store fall back to the anchor cart", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
    q("milk", "goodwill", 100), q("rice", "goodwill", 100), // no eggs at goodwill
  ];
  const d = decideSplit(basket, quotes, stores);
  if (d.carts.length === 2) {
    const ag = d.carts.find((c) => c.store === "agrohub")!;
    expect(ag.lines.map((l) => l.itemKey)).toContain("eggs");
  } else {
    expect(d.carts[0]!.lines.map((l) => l.itemKey)).toContain("eggs");
  }
});

test("items with no anchor quote are reported unpriced and excluded from totals (Review Focus 1)", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), // eggs missing everywhere
  ];
  const d = decideSplit(basket, quotes, stores);
  expect(d.unpriced).toEqual(["eggs"]);
  expect(d.anchorOnlyTotal).toBe(2500 + 900 + 1500 + 800 + 500);
  for (const c of d.carts) expect(c.lines.find((l) => l.itemKey === "eggs")).toBeUndefined();
});

test("prefers glovo quotes over dazoge quotes for the same item and store", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 999, "dazoge"), q("milk", "agrohub", 500, "glovo"),
    q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
  ];
  const d = decideSplit(basket, quotes, stores);
  const milk = d.carts[0]!.lines.find((l) => l.itemKey === "milk")!;
  expect(milk.unitPrice).toBe(500);
  expect(milk.source).toBe("glovo");
});

test("anchor-only cart below anchor minimum is flagged", () => {
  const small: BasketItem[] = [{ key: "milk", name: "Milk", qty: 1, category: "dairy" }];
  const d = decideSplit(small, [q("milk", "agrohub", 500)], stores);
  expect(d.carts[0]!.meetsMinimum).toBe(false);
  expect(d.reason).toMatch(/minimum/i);
});

test("default config matches the spec", () => {
  expect(DEFAULT_SPLIT_CONFIG).toEqual({ anchorStore: "agrohub", protectedCategories: ["meat", "fish", "fruit"], marginTetri: 1000 });
});

const noMargin = { ...DEFAULT_SPLIT_CONFIG, marginTetri: 0 };

test("no split when the anchor remainder would miss the anchor minimum", () => {
  const quotes = [
    q("chicken", "agrohub", 500), q("apples", "agrohub", 900), // remainder 1400 < agrohub minimum 2000
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
    q("milk", "goodwill", 400), q("rice", "goodwill", 300), q("eggs", "goodwill", 500),
  ];
  const d = decideSplit(basket, quotes, stores);
  // the split would save 5400 - (1900 + 2400) = 1100, above the margin, but agrohub keeps only 1400
  expect(d.carts.map((c) => c.store)).toEqual(["agrohub"]);
  expect(d.carts[0]!.total).toBe(5400);
  expect(d.savings).toBe(0);
  expect(d.reason).toMatch(/minimum/i);
  expect(d.reason).toMatch(/agrohub/);
});

test("savings exactly equal to the margin do not split; one tetri more does", () => {
  const base = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
    q("milk", "goodwill", 400), q("rice", "goodwill", 300),
  ];
  // goodwill 1200+300+600 = 2100 + 400 = 2500; agrohub remainder 3400 + 500 = 3900; savings 7400 - 6400 = 1000.
  // The items alone save 3500 - 2100 = 1400; only the second delivery fee brings it down to the margin.
  const atMargin = decideSplit(basket, [...base, q("eggs", "goodwill", 600)], stores);
  expect(atMargin.carts.map((c) => c.store)).toEqual(["agrohub"]);
  expect(atMargin.savings).toBe(0);
  expect(atMargin.reason).toMatch(/margin/i);

  const overMargin = decideSplit(basket, [...base, q("eggs", "goodwill", 599)], stores);
  expect(overMargin.carts.map((c) => c.store)).toEqual(["agrohub", "goodwill"]);
  expect(overMargin.savings).toBe(1001);
});

test("a basket with no protected items moves wholly to the cheaper store and pays only its fee", () => {
  const staples = basket.filter((it) => ["milk", "rice", "eggs"].includes(it.key));
  const quotes = [
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
    q("milk", "goodwill", 400), q("rice", "goodwill", 300), q("eggs", "goodwill", 500),
  ];
  const d = decideSplit(staples, quotes, stores);
  // anchor only: 3500 + 500 = 4000; goodwill: 2000 + 400 = 2400; no agrohub cart, so no agrohub fee
  expect(d.anchorOnlyTotal).toBe(4000);
  expect(d.carts.map((c) => c.store)).toEqual(["goodwill"]);
  expect(d.savings).toBe(1600);
  expect(d.savings).toBe(d.anchorOnlyTotal - d.carts.reduce((a, c) => a + c.total, 0));
});

test("an item with no anchor quote stays unpriced and out of every cart even when another store quotes it", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800),
    q("milk", "goodwill", 400), q("rice", "goodwill", 300), q("eggs", "goodwill", 100),
  ];
  const d = decideSplit(basket, quotes, stores, noMargin);
  // anchor only 5700 + 500 = 6200; split 3900 + 1900 = 5800; savings 400 > 0
  expect(d.unpriced).toEqual(["eggs"]);
  expect(d.anchorOnlyTotal).toBe(6200);
  expect(d.carts.map((c) => c.store)).toEqual(["agrohub", "goodwill"]);
  expect(d.carts[1]!.lines.map((l) => l.itemKey)).toEqual(["milk", "rice"]);
  expect(d.savings).toBe(400);
});

test("an item the alternative store lacks stays in the anchor cart when a split does happen", () => {
  const quotes = [
    q("chicken", "agrohub", 2500), q("apples", "agrohub", 900),
    q("milk", "agrohub", 500), q("rice", "agrohub", 800), q("eggs", "agrohub", 1200),
    q("milk", "goodwill", 400), q("rice", "goodwill", 300), // no eggs at goodwill
  ];
  const d = decideSplit(basket, quotes, stores, noMargin);
  // goodwill 1500 + 400 = 1900; agrohub 4600 + 500 = 5100; savings 7400 - 7000 = 400 > 0
  expect(d.carts.map((c) => c.store)).toEqual(["agrohub", "goodwill"]);
  expect(d.carts[0]!.lines.map((l) => l.itemKey)).toEqual(["chicken", "apples", "eggs"]);
  expect(d.carts[1]!.lines.map((l) => l.itemKey)).toEqual(["milk", "rice"]);
  expect(d.savings).toBe(400);
});
