import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema";

/** Applies the MIGRATIONS entries beyond the recorded schema_version, one transaction each. Returns how many ran. */
export function migrate(db: Database): number {
  db.exec("create table if not exists schema_version (version integer not null)");
  const row = db.query("select max(version) as v from schema_version").get() as { v: number | null };
  const current = row.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.query("insert into schema_version(version) values (?)").run(i + 1);
    })();
  }
  return Math.max(0, MIGRATIONS.length - current);
}

/** Opens (creating the file and its parent directory if needed) and migrates the database. */
export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  // busy_timeout first: the MCP server and a script may hold the file at once, and the WAL switch itself takes a lock
  db.exec("pragma busy_timeout = 5000; pragma journal_mode = WAL; pragma foreign_keys = on;");
  migrate(db);
  return db;
}

export type { Database };
