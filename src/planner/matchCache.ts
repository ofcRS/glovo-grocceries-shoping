import type { Database } from "bun:sqlite";
import type { CachedMatch, MatchCache } from "../matching/resolver";

export class SqliteMatchCache implements MatchCache {
  constructor(private readonly db: Database) {}
  get(glovoKey: string): CachedMatch | null {
    return (this.db.query("select glovo_key as glovoKey, dazoge_id as dazogeId, confidence, confirmed_at as confirmedAt from product_match where glovo_key = ?").get(glovoKey) as CachedMatch | null) ?? null;
  }
  put(m: CachedMatch): void {
    this.db.query(
      "insert into product_match(glovo_key, dazoge_id, confidence, confirmed_at) values (?, ?, ?, ?) on conflict(glovo_key) do update set dazoge_id = excluded.dazoge_id, confidence = excluded.confidence, confirmed_at = excluded.confirmed_at",
    ).run(m.glovoKey, m.dazogeId, m.confidence, m.confirmedAt);
  }
}
