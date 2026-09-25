import type { Database } from "bun:sqlite";
import type { PantryRepo } from "./pantry";

export type Slot = "breakfast" | "lunch" | "dinner";
export type MealStatus = "planned" | "cooked" | "skipped";
export interface MealIngredient { ingredient: string; qty: number; unit: string }
export interface Meal { id: number; date: string; slot: Slot; title: string; notes: string | null; status: MealStatus; ingredients: MealIngredient[] }
export type NewMeal = Omit<Meal, "id" | "status">;

export class MealsRepo {
  constructor(private readonly db: Database, private readonly pantry: PantryRepo) {}

  savePlan(meals: NewMeal[]): number[] {
    const insMeal = this.db.query("insert into meal(date, slot, title, notes) values (?, ?, ?, ?)");
    const insIng = this.db.query("insert into meal_ingredient(meal_id, ingredient, qty, unit) values (?, ?, ?, ?)");
    const ids: number[] = [];
    const tx = this.db.transaction(() => {
      for (const m of meals) {
        const id = Number(insMeal.run(m.date, m.slot, m.title, m.notes).lastInsertRowid);
        for (const i of m.ingredients) insIng.run(id, i.ingredient, i.qty, i.unit);
        ids.push(id);
      }
    });
    tx();
    return ids;
  }

  private load(where: string, ...params: unknown[]): Meal[] {
    const rows = this.db.query(`select id, date, slot, title, notes, status from meal ${where} order by date, case slot when 'breakfast' then 0 when 'lunch' then 1 else 2 end`).all(...(params as never[])) as Omit<Meal, "ingredients">[];
    const ing = this.db.query("select ingredient, qty, unit from meal_ingredient where meal_id = ?");
    return rows.map((r) => ({ ...r, ingredients: ing.all(r.id) as MealIngredient[] }));
  }

  recent(days: number, today = new Date().toISOString().slice(0, 10)): Meal[] {
    const from = new Date(new Date(today).getTime() - days * 86_400_000).toISOString().slice(0, 10);
    return this.load("where date >= ? and date <= ?", from, today);
  }

  byId(id: number): Meal | null {
    return this.load("where id = ?", id)[0] ?? null;
  }

  /**
   * Marks status. The first transition to cooked decrements pantry by the meal's ingredients; later marks do not,
   * including cooked -> skipped -> cooked. The meal.pantry_decremented flag records that the decrement happened.
   */
  mark(id: number, status: MealStatus): Meal {
    const tx = this.db.transaction(() => {
      const before = this.byId(id);
      if (!before) throw new Error(`No meal ${id}`);
      const { decremented } = this.db.query("select pantry_decremented as decremented from meal where id = ?").get(id) as { decremented: number };
      this.db.query("update meal set status = ? where id = ?").run(status, id);
      if (status === "cooked" && decremented === 0) {
        this.db.query("update meal set pantry_decremented = 1 where id = ?").run(id);
        for (const i of before.ingredients) this.pantry.adjust(i.ingredient, -i.qty, i.unit);
      }
    });
    tx();
    return this.byId(id)!;
  }
}
