import { Database } from "bun:sqlite";
import { MIGRATIONS } from "./schema";

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("pragma journal_mode = WAL; pragma foreign_keys = on;");
  db.exec("create table if not exists schema_version (version integer not null)");
  const row = db.query("select max(version) as v from schema_version").get() as { v: number | null };
  const current = row.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.query("insert into schema_version(version) values (?)").run(i + 1);
    })();
  }
  return db;
}

export type { Database };
