import type { Database } from "bun:sqlite";
import { convertQty } from "./units";

export interface PantryRow { ingredient: string; qty: number; unit: string; updatedAt: string }

export class PantryRepo {
  constructor(private readonly db: Database) {}

  list(): PantryRow[] {
    return (this.db.query("select ingredient, qty, unit, updated_at as updatedAt from pantry order by ingredient").all() as PantryRow[]);
  }

  get(ingredient: string): PantryRow | null {
    return (this.db.query("select ingredient, qty, unit, updated_at as updatedAt from pantry where ingredient = ?").get(ingredient) as PantryRow | null) ?? null;
  }

  set(ingredient: string, qty: number, unit: string): void {
    this.db.query(
      "insert into pantry(ingredient, qty, unit, updated_at) values (?, ?, ?, ?) on conflict(ingredient) do update set qty = excluded.qty, unit = excluded.unit, updated_at = excluded.updated_at",
    ).run(ingredient, Math.max(0, qty), unit, new Date().toISOString());
  }

  /** Adds delta (may be negative) converting into the stored unit. Creates the row if missing. Floors at zero. */
  adjust(ingredient: string, delta: number, unit: string): PantryRow {
    const row = this.get(ingredient);
    if (!row) { this.set(ingredient, delta, unit); return this.get(ingredient)!; }
    const converted = convertQty(delta, unit, row.unit);
    this.set(ingredient, row.qty + converted, row.unit);
    return this.get(ingredient)!;
  }
}
