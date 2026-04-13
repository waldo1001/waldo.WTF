import Database, { type Database as DatabaseHandle } from "better-sqlite3";

export function openDatabase(path: string): DatabaseHandle {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  return db;
}
