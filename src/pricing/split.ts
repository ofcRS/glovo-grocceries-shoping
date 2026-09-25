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
    lines.push({ itemKey: it.key, name: it.name, qty: it.qty, unitPrice: qt.unitPrice, lineTotal: qt.unitPrice * it.qty, source: qt.source });
  }
  const subtotal = lines.reduce((a, l) => a + l.lineTotal, 0);
  return { store, lines, subtotal, deliveryFee: info.deliveryFee, total: subtotal + info.deliveryFee, meetsMinimum: subtotal >= info.minOrder };
}

export function decideSplit(
  basket: BasketItem[],
  quotes: ItemQuote[],
  stores: StoreInfo[],
  config: SplitConfig = DEFAULT_SPLIT_CONFIG,
): SplitDecision {
  const idx = indexQuotes(quotes);
  const anchor = config.anchorStore;
  const anchorInfo = stores.find((s) => s.store === anchor);
  if (!anchorInfo) throw new Error(`Anchor store ${anchor} not in stores list`);

  const unpriced = basket.filter((it) => !idx.get(it.key)?.get(anchor)).map((it) => it.key);
  const priced = basket.filter((it) => !unpriced.includes(it.key));
  const isProtected = (it: BasketItem) => config.protectedCategories.includes(it.category);

  const anchorOnly = buildCart(anchor, priced, idx, stores);

  let best: { carts: ProposedCart[]; savings: number } | null = null;
  const rejections: string[] = [];

  for (const alt of stores) {
    if (alt.store === anchor) continue;
    const movable = priced.filter((it) => !isProtected(it) && idx.get(it.key)?.get(alt.store));
    if (movable.length === 0) continue;
    const staying = priced.filter((it) => !movable.includes(it));
    const altCart = buildCart(alt.store, movable, idx, stores);
    const anchorCart = buildCart(anchor, staying, idx, stores);
    // an empty anchor remainder is dropped, and so is its delivery fee
    const carts = anchorCart.lines.length ? [anchorCart, altCart] : [altCart];
    const savings = anchorOnly.total - carts.reduce((a, c) => a + c.total, 0);
    if (!altCart.meetsMinimum) { rejections.push(`${alt.store} cart ${altCart.subtotal} is under its minimum ${alt.minOrder}`); continue; }
    if (anchorCart.lines.length > 0 && !anchorCart.meetsMinimum) { rejections.push(`${anchor} remainder ${anchorCart.subtotal} is under its minimum ${anchorInfo.minOrder}`); continue; }
    if (!best || savings > best.savings) best = { carts, savings };
  }

  if (best && best.savings > config.marginTetri) {
    return {
      carts: best.carts,
      anchorOnlyTotal: anchorOnly.total,
      savings: best.savings,
      unpriced,
      reason: `Splitting saves ${best.savings} tetri after both delivery fees, above the ${config.marginTetri} tetri margin.`,
    };
  }

  const why = best
    ? `Best split would save only ${best.savings} tetri, within the ${config.marginTetri} tetri margin.`
    : rejections.length
      ? `No split: ${rejections.join("; ")}.`
      : "No alternative store had quotes for the non-protected items.";
  const minNote = anchorOnly.meetsMinimum ? "" : ` Note: the ${anchor} cart is under its minimum order.`;
  return { carts: [anchorOnly], anchorOnlyTotal: anchorOnly.total, savings: 0, unpriced, reason: why + minNote };
}
