import type { Tetri } from "../money";
import type { StoreSlug } from "./stores";

export interface DazogeStorePrice { store: string; storeSlug: StoreSlug | null; price: Tetri; oldPrice: Tetri | null }
export interface DazogeProduct { id: string; name: string; volume: string; imageUrl: string; prices: DazogeStorePrice[] }
export interface DazogeSearchItem {
  id: string; name: string; volume: string; price: Tetri; oldPrice: Tetri | null; store: string; storeSlug: StoreSlug | null;
}
export interface DazogeSearchPage { query: string; page: number; items: DazogeSearchItem[]; hasMore: boolean }
