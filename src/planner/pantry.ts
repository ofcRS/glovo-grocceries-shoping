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
    ).run(ingredient, Math.round(Math.max(0, qty) * 1e9) / 1e9, unit, new Date().toISOString());
  }

  /**
   * Adds delta (may be negative) converting into the stored unit. Floors at zero.
   * A missing row is created only for a positive delta; otherwise nothing is stored (so the unit stays unfixed)
   * and a synthetic zero row is returned.
   */
  adjust(ingredient: string, delta: number, unit: string): PantryRow {
    const row = this.get(ingredient);
    if (!row) {
      if (delta <= 0) return { ingredient, qty: 0, unit, updatedAt: new Date().toISOString() };
      this.set(ingredient, delta, unit);
      return this.get(ingredient)!;
    }
    const converted = convertQty(delta, unit, row.unit);
    this.set(ingredient, row.qty + converted, row.unit);
    return this.get(ingredient)!;
  }
}
