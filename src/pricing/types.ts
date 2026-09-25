import type { Tetri } from "../money";

export type Category =
  | "meat" | "fish" | "fruit" | "vegetable" | "dairy" | "bakery" | "grain" | "pantry" | "drink" | "household" | "other";

export interface BasketItem { key: string; name: string; qty: number; category: Category }
export interface StoreInfo { store: string; deliveryFee: Tetri; minOrder: Tetri }
export interface ItemQuote { itemKey: string; store: string; unitPrice: Tetri; source: "glovo" | "dazoge" }
export interface SplitConfig { anchorStore: string; protectedCategories: Category[]; marginTetri: Tetri }
export interface CartLine { itemKey: string; name: string; qty: number; unitPrice: Tetri; lineTotal: Tetri; source: "glovo" | "dazoge" }
export interface ProposedCart { store: string; lines: CartLine[]; subtotal: Tetri; deliveryFee: Tetri; total: Tetri; meetsMinimum: boolean }
export interface SplitDecision { carts: ProposedCart[]; anchorOnlyTotal: Tetri; savings: Tetri; unpriced: string[]; reason: string }
