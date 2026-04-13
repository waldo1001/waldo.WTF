import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, applyMigrations } from "./schema.js";

function userVersion(db: Database.Database): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function objectNames(db: Database.Database, type: "table" | "index"): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(type) as { name: string }[]
  ).map((r) => r.name);
}

describe("schema / applyMigrations", () => {
  it("advances a fresh db from user_version 0 to CURRENT_SCHEMA_VERSION", () => {
    const db = new Database(":memory:");
    expect(userVersion(db)).toBe(0);
    applyMigrations(db);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });

  it("creates all four tables and expected indices", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    const tables = objectNames(db, "table");
    expect(tables).toEqual(
      expect.arrayContaining(["messages", "sync_state", "sync_log", "accounts"]),
    );

    const indices = objectNames(db, "index");
    expect(indices).toEqual(
      expect.arrayContaining([
        "idx_messages_sent_at",
        "idx_messages_account_source",
        "idx_sync_log_ts",
      ]),
    );
  });

  it("is idempotent — second call is a no-op", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      "INSERT INTO accounts (username, display_name, tenant_id, added_at) VALUES (?, ?, ?, ?)",
    ).run("a@example.test", "A", "t1", 1_700_000_000_000);

    expect(() => applyMigrations(db)).not.toThrow();
    expect(userVersion(db)).toBe(1);

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("sync_log.status CHECK rejects unknown values", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const insert = db.prepare(
      "INSERT INTO sync_log (ts, account, source, status, messages_added, error_message) VALUES (?, ?, ?, ?, ?, ?)",
    );
    expect(() =>
      insert.run(1, "a@example.test", "outlook", "pending", 0, null),
    ).toThrow();
    expect(() =>
      insert.run(2, "a@example.test", "outlook", "ok", 5, null),
    ).not.toThrow();
    expect(() =>
      insert.run(3, "a@example.test", "outlook", "error", null, "boom"),
    ).not.toThrow();
  });

  it("accounts.username is PRIMARY KEY — duplicate raw insert rejects", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const insert = db.prepare(
      "INSERT INTO accounts (username, display_name, tenant_id, added_at) VALUES (?, ?, ?, ?)",
    );
    insert.run("a@example.test", "A", "t1", 1);
    expect(() => insert.run("a@example.test", "A2", "t1", 2)).toThrow();
  });
});
