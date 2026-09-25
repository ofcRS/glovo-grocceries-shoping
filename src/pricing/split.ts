import { formatGel, type Tetri } from "../money";
import type { BasketItem, CartLine, ItemQuote, ProposedCart, SplitConfig, SplitDecision, StoreInfo } from "./types";

export const DEFAULT_SPLIT_CONFIG: SplitConfig = {
  anchorStore: "agrohub",
  protectedCategories: ["meat", "fish", "fruit"],
  marginTetri: 1000,
};

type QuoteIndex = Map<string, Map<string, ItemQuote>>; // itemKey -> store -> best quote

function indexQuotes(quotes: ItemQuote[]): QuoteIndex {
  const idx: QuoteIndex = new Map();
  for (const q of quotes) {
    const byStore = idx.get(q.itemKey) ?? new Map<string, ItemQuote>();
    const existing = byStore.get(q.store);
    // glovo beats dazoge; otherwise keep the first seen
    if (!existing || (existing.source === "dazoge" && q.source === "glovo")) byStore.set(q.store, q);
    idx.set(q.itemKey, byStore);
  }
  return idx;
}

function buildCart(store: string, items: BasketItem[], idx: QuoteIndex, stores: StoreInfo[]): ProposedCart {
  const info = stores.find((s) => s.store === store);
  if (!info) throw new Error(`Unknown store ${store}`);
  const lines: CartLine[] = [];
  for (const it of items) {
    const qt = idx.get(it.key)?.get(store);
    if (!qt) continue;
    // weighed goods have fractional qty; round so every amount stays integer tetri
    lines.push({ itemKey: it.key, name: it.name, qty: it.qty, unitPrice: qt.unitPrice, lineTotal: Math.round(qt.unitPrice * it.qty), source: qt.source });
  }
  const subtotal = lines.reduce((a, l) => a + l.lineTotal, 0);
  return { store, lines, subtotal, deliveryFee: info.deliveryFee, total: subtotal + info.deliveryFee, meetsMinimum: subtotal >= info.minOrder };
}

const underMinimum = (cart: ProposedCart, minOrder: Tetri) =>
  `${cart.store} cart ${formatGel(cart.subtotal)} is under its ${formatGel(minOrder)} minimum`;

export function decideSplit(
  basket: BasketItem[],
  quotes: ItemQuote[],
  stores: StoreInfo[],
  config: SplitConfig = DEFAULT_SPLIT_CONFIG,
): SplitDecision {
  for (const it of basket) {
    if (!Number.isFinite(it.qty) || it.qty <= 0) throw new Error(`Invalid qty ${it.qty} for basket item ${it.key}`);
  }
  const idx = indexQuotes(quotes);
  const anchor = config.anchorStore;
  const anchorInfo = stores.find((s) => s.store === anchor);
  if (!anchorInfo) throw new Error(`Anchor store ${anchor} not in stores list`);

  const priceAt = (it: BasketItem, store: string) => idx.get(it.key)?.get(store)?.unitPrice;
  const unpriced = basket.filter((it) => priceAt(it, anchor) === undefined).map((it) => it.key);
  const priced = basket.filter((it) => !unpriced.includes(it.key));
  const isProtected = (it: BasketItem) => config.protectedCategories.includes(it.category);

  if (priced.length === 0) {
    const fee = anchorInfo.deliveryFee;
    return {
      carts: [{ store: anchor, lines: [], subtotal: 0, deliveryFee: fee, total: fee, meetsMinimum: false }],
      anchorOnlyTotal: fee,
      savings: 0,
      unpriced,
      reason: `Nothing to price: no items have a quote at ${anchor}.`,
    };
  }

  const anchorOnly = buildCart(anchor, priced, idx, stores);

  let best: { carts: ProposedCart[]; savings: number } | null = null;
  const rejections: string[] = [];

  for (const alt of stores) {
    if (alt.store === anchor) continue;
    // priced items have an anchor price; `quoted` items also have one here
    const quoted = priced.filter((it) => !isProtected(it) && priceAt(it, alt.store) !== undefined);
    if (quoted.length === 0) continue;
    const altPrice = (it: BasketItem) => priceAt(it, alt.store)!;
    const anchorPrice = (it: BasketItem) => priceAt(it, anchor)!;

    // move only what is strictly cheaper here...
    const moving = new Set(quoted.filter((it) => altPrice(it) < anchorPrice(it)));
    const movingCart = () => buildCart(alt.store, priced.filter((it) => moving.has(it)), idx, stores);
    let altCart = movingCart();
    // ...and if that misses the store minimum, top up with the items that cost least extra in total
    const topUps = quoted
      .filter((it) => !moving.has(it))
      .sort((a, b) => (altPrice(a) - anchorPrice(a)) * a.qty - (altPrice(b) - anchorPrice(b)) * b.qty);
    for (const it of topUps) {
      if (altCart.meetsMinimum) break;
      moving.add(it);
      altCart = movingCart();
    }
    if (!altCart.meetsMinimum) { rejections.push(underMinimum(altCart, alt.minOrder)); continue; }

    const anchorCart = buildCart(anchor, priced.filter((it) => !moving.has(it)), idx, stores);
    if (anchorCart.lines.length > 0 && !anchorCart.meetsMinimum) { rejections.push(underMinimum(anchorCart, anchorInfo.minOrder)); continue; }
    // an empty anchor remainder is dropped, and so is its delivery fee
    const carts = anchorCart.lines.length ? [anchorCart, altCart] : [altCart];
    const savings = anchorOnly.total - carts.reduce((a, c) => a + c.total, 0);
    if (!best || savings > best.savings) best = { carts, savings };
  }

  if (best && best.savings > config.marginTetri) {
    const fees = best.carts.length === 1 ? "the delivery fee" : "delivery fees";
    return {
      carts: best.carts,
      anchorOnlyTotal: anchorOnly.total,
      savings: best.savings,
      unpriced,
      reason: `Splitting saves ${formatGel(best.savings)} after ${fees}, above the ${formatGel(config.marginTetri)} margin.`,
    };
  }

  let why: string;
  if (best) {
    why = best.savings > 0
      ? `Best split would save only ${formatGel(best.savings)}, within the ${formatGel(config.marginTetri)} margin.`
      : `No alternative store beats ${anchor} once delivery fees are counted.`;
    if (rejections.length) why += ` Rejected: ${rejections.join("; ")}.`;
  } else if (rejections.length) {
    why = `No split: ${rejections.join("; ")}.`;
  } else {
    why = "No alternative store had quotes for the non-protected items.";
  }
  const minNote = anchorOnly.meetsMinimum ? "" : ` Note: the ${anchor} cart is under its minimum order.`;
  return { carts: [anchorOnly], anchorOnlyTotal: anchorOnly.total, savings: 0, unpriced, reason: why + minNote };
}
