import type { Database } from "bun:sqlite";
import type { PantryRepo } from "./pantry";

/**
 * One delivered line. `lineTotalTetri` is what was paid for the whole line (integer tetri); `qty`/`unit` is the physical
 * amount that went into the pantry (10 pcs of eggs, 0.8 kg of chicken, 3 l of milk), never a price multiplier.
 */
export interface DeliveryItem { productName: string; lineTotalTetri: number; qty: number; unit: string; ingredient?: string }
export interface DeliveryRow { id: number; glovoOrderId: string; store: string; placedAt: string; total: number; status: string }

export class DeliveriesRepo {
  constructor(private readonly db: Database, private readonly pantry: PantryRepo) {}

  /** Stores the delivery and its items and increments the pantry, all in one transaction: any failure rolls everything back. */
  record(input: { glovoOrderId: string; store: string; placedAt?: string; items: DeliveryItem[] }): { id: number; total: number } {
    for (const i of input.items) {
      if (!Number.isInteger(i.lineTotalTetri) || i.lineTotalTetri < 0) {
        throw new Error(`lineTotalTetri must be a non-negative integer tetri amount, got ${i.lineTotalTetri} for ${i.productName}`);
      }
    }
    const total = input.items.reduce((s, i) => s + i.lineTotalTetri, 0);
    const placedAt = input.placedAt ?? new Date().toISOString();
    let id = 0;
    const tx = this.db.transaction(() => {
      id = Number(this.db.query("insert into delivery(glovo_order_id, store, placed_at, total) values (?, ?, ?, ?)").run(input.glovoOrderId, input.store, placedAt, total).lastInsertRowid);
      const ins = this.db.query("insert into delivery_item(delivery_id, product_name, ingredient, qty, unit, line_total) values (?, ?, ?, ?, ?, ?)");
      for (const i of input.items) {
        ins.run(id, i.productName, i.ingredient ?? null, i.qty, i.unit, i.lineTotalTetri);
        this.pantry.adjust(i.ingredient ?? i.productName, i.qty, i.unit);
      }
    });
    tx();
    return { id, total };
  }

  recent(limit: number): DeliveryRow[] {
    return this.db.query("select id, glovo_order_id as glovoOrderId, store, placed_at as placedAt, total, status from delivery order by placed_at desc limit ?").all(limit) as DeliveryRow[];
  }
}
