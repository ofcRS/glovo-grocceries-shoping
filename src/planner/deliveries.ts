import type { Database } from "bun:sqlite";
import type { PantryRepo } from "./pantry";

export interface DeliveryItem { productName: string; qty: number; unit: string; priceTetri: number; ingredient?: string }
export interface DeliveryRow { id: number; glovoOrderId: string; store: string; placedAt: string; total: number; status: string }

export class DeliveriesRepo {
  constructor(private readonly db: Database, private readonly pantry: PantryRepo) {}

  /** Stores the delivery and its items and increments the pantry, all in one transaction: any failure rolls everything back. */
  record(input: { glovoOrderId: string; store: string; placedAt?: string; items: DeliveryItem[] }): { id: number; total: number } {
    const total = input.items.reduce((s, i) => s + Math.round(i.priceTetri * i.qty), 0);
    const placedAt = input.placedAt ?? new Date().toISOString();
    let id = 0;
    const tx = this.db.transaction(() => {
      id = Number(this.db.query("insert into delivery(glovo_order_id, store, placed_at, total) values (?, ?, ?, ?)").run(input.glovoOrderId, input.store, placedAt, total).lastInsertRowid);
      const ins = this.db.query("insert into delivery_item(delivery_id, product_name, ingredient, qty, unit, price) values (?, ?, ?, ?, ?, ?)");
      for (const i of input.items) {
        ins.run(id, i.productName, i.ingredient ?? null, i.qty, i.unit, i.priceTetri);
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
