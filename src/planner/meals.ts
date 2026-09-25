import type { Database } from "bun:sqlite";
import type { PantryRepo } from "./pantry";
import { UnitMismatchError } from "./units";

export type Slot = "breakfast" | "lunch" | "dinner";
export type MealStatus = "planned" | "cooked" | "skipped";
export interface MealIngredient { ingredient: string; qty: number; unit: string }
export interface Meal { id: number; date: string; slot: Slot; title: string; notes: string | null; status: MealStatus; ingredients: MealIngredient[] }
export type NewMeal = Omit<Meal, "id" | "status">;
export interface PantrySkip { ingredient: string; reason: string }

const TBILISI_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tbilisi", year: "numeric", month: "2-digit", day: "2-digit" });

/** The calendar date (YYYY-MM-DD) in Tbilisi at `now`: meals are planned in local days, not UTC days. */
export function tbilisiToday(now: Date = new Date()): string {
  return TBILISI_DATE.format(now);
}

/** Calendar arithmetic on a YYYY-MM-DD date. */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export class MealsRepo {
  constructor(private readonly db: Database, private readonly pantry: PantryRepo, private readonly now: () => Date = () => new Date()) {}

  /**
   * Inserts the meals. Meals still `planned` in any (date, slot) being saved are replaced, ingredients included, so a
   * re-saved plan does not duplicate; cooked and skipped meals stay and the new meal is added alongside. Several meals
   * for one slot in the same call are all kept.
   */
  savePlan(meals: NewMeal[]): number[] {
    const planned = this.db.query("select id from meal where date = ? and slot = ? and status = 'planned'");
    const delIng = this.db.query("delete from meal_ingredient where meal_id = ?");
    const delMeal = this.db.query("delete from meal where id = ?");
    const insMeal = this.db.query("insert into meal(date, slot, title, notes) values (?, ?, ?, ?)");
    const insIng = this.db.query("insert into meal_ingredient(meal_id, ingredient, qty, unit) values (?, ?, ?, ?)");
    const ids: number[] = [];
    const tx = this.db.transaction(() => {
      const slots = new Map(meals.map((m) => [`${m.date}|${m.slot}`, m] as const));
      for (const { date, slot } of slots.values()) {
        for (const { id } of planned.all(date, slot) as { id: number }[]) { delIng.run(id); delMeal.run(id); }
      }
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
    const rows = this.db.query(`select id, date, slot, title, notes, status from meal ${where} order by date, case slot when 'breakfast' then 0 when 'lunch' then 1 else 2 end, id`).all(...(params as never[])) as Omit<Meal, "ingredients">[];
    const ing = this.db.query("select ingredient, qty, unit from meal_ingredient where meal_id = ?");
    return rows.map((r) => ({ ...r, ingredients: ing.all(r.id) as MealIngredient[] }));
  }

  /** Meals from `today - days` through `today` (Tbilisi date by default): the past window. */
  recent(days: number, today = tbilisiToday(this.now())): Meal[] {
    return this.load("where date >= ? and date <= ?", addDays(today, -days), today);
  }

  /** Meals from `today` through `today + days` (Tbilisi date by default): the plan ahead. */
  upcoming(days: number, today = tbilisiToday(this.now())): Meal[] {
    return this.load("where date >= ? and date <= ?", today, addDays(today, days));
  }

  byId(id: number): Meal | null {
    return this.load("where id = ?", id)[0] ?? null;
  }

  /**
   * Marks status. The first transition to cooked decrements pantry by the meal's ingredients; later marks do not,
   * including cooked -> skipped -> cooked. The meal.pantry_decremented flag records that the transition happened.
   * An ingredient whose unit cannot convert to the pantry's is skipped and reported; any other error rolls back.
   */
  mark(id: number, status: MealStatus): { meal: Meal; pantrySkipped: PantrySkip[] } {
    const pantrySkipped: PantrySkip[] = [];
    const tx = this.db.transaction(() => {
      const before = this.byId(id);
      if (!before) throw new Error(`No meal ${id}`);
      const { decremented } = this.db.query("select pantry_decremented as decremented from meal where id = ?").get(id) as { decremented: number };
      this.db.query("update meal set status = ? where id = ?").run(status, id);
      if (status === "cooked" && decremented === 0) {
        this.db.query("update meal set pantry_decremented = 1 where id = ?").run(id);
        for (const i of before.ingredients) {
          try {
            this.pantry.adjust(i.ingredient, -i.qty, i.unit);
          } catch (e) {
            if (!(e instanceof UnitMismatchError)) throw e;
            pantrySkipped.push({ ingredient: i.ingredient, reason: e.message });
          }
        }
      }
    });
    tx();
    return { meal: this.byId(id)!, pantrySkipped };
  }
}
