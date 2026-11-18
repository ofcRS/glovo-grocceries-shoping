import { storeSlug } from "./stores";
import type { DazogeProduct, DazogeSearchItem, DazogeSearchPage } from "./types";

interface RawPrice { store_name: string; price: number; old_price: number | null }
interface RawProduct { name: string; image_url: string; volume: string; href: string; prices: RawPrice[] }
interface RawSearchItem {
  name: string; image_url: string; volume: string; price: number; old_price: number | null;
  store: { name: string; logo_url: string }; href: string;
}
interface RawSearch { q: string; page: number; items: RawSearchItem[]; hasMore: boolean }

/** href looks like "/product/4860051001298/some-slug"; the second segment is the id. */
export function idFromHref(href: string): string {
  const m = href.match(/^\/product\/([^/]+)/);
  if (!m || !m[1]) throw new Error(`Unexpected Dazoge href: ${href}`);
  return m[1];
}

const oldPrice = (v: number | null | undefined): number | null => (v && v > 0 ? v : null);

export class DazogeClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://www.dazoge.info",
  ) {}

  async getProduct(id: string): Promise<DazogeProduct | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/product/${encodeURIComponent(id)}.json`, {
      headers: { accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Dazoge product ${id}: HTTP ${res.status}`);
    const raw = (await res.json()) as RawProduct;
    return {
      id: idFromHref(raw.href),
      name: raw.name,
      volume: raw.volume ?? "",
      imageUrl: raw.image_url,
      prices: raw.prices.map((p) => ({
        store: p.store_name,
        storeSlug: storeSlug(p.store_name),
        price: p.price,
        oldPrice: oldPrice(p.old_price),
      })),
    };
  }

  async search(query: string, page = 1): Promise<DazogeSearchPage> {
    const url = `${this.baseUrl}/api/search.json?q=${encodeURIComponent(query)}&page=${page}`;
    const res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Dazoge search ${JSON.stringify(query)}: HTTP ${res.status}`);
    const raw = (await res.json()) as RawSearch;
    const items: DazogeSearchItem[] = (raw.items ?? []).map((it) => ({
      id: idFromHref(it.href),
      name: it.name,
      volume: it.volume ?? "",
      price: it.price,
      oldPrice: oldPrice(it.old_price),
      store: it.store.name,
      storeSlug: storeSlug(it.store.name),
    }));
    return { query, page: raw.page ?? page, items, hasMore: Boolean(raw.hasMore) };
  }
}
