import type { Database } from "bun:sqlite";

export class NotesRepo {
  constructor(private readonly db: Database) {}
  add(text: string): number {
    return Number(this.db.query("insert into note(created_at, text) values (?, ?)").run(new Date().toISOString(), text).lastInsertRowid);
  }
  recent(limit: number): Array<{ id: number; createdAt: string; text: string }> {
    return this.db.query("select id, created_at as createdAt, text from note order by id desc limit ?").all(limit) as Array<{ id: number; createdAt: string; text: string }>;
  }
}
