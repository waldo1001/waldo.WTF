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
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
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
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

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

function insertMessageRow(
  db: Database.Database,
  overrides: {
    id: string;
    body?: string | null;
    threadName?: string | null;
    senderName?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO messages (
      id, source, account, native_id, thread_name, sender_name,
      sent_at, imported_at, body
    ) VALUES (?, 'outlook', 'a@example.test', ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id,
    `native-${overrides.id}`,
    overrides.threadName ?? null,
    overrides.senderName ?? null,
    1_700_000_000_000,
    1_700_000_000_000,
    overrides.body ?? null,
  );
}

function ftsRowidsMatching(db: Database.Database, query: string): number[] {
  return (
    db
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?")
      .all(query) as { rowid: number }[]
  ).map((r) => r.rowid);
}

describe("schema / FTS5 (migration 2)", () => {
  it("creates messages_fts virtual table and ai/ad/au triggers", () => {
    const db = new Database(":memory:");
    applyMigrations(db);

    const tables = objectNames(db, "table");
    expect(tables).toContain("messages_fts");

    const triggers = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(triggers).toEqual(
      expect.arrayContaining(["messages_ai", "messages_ad", "messages_au"]),
    );
  });

  it("is idempotent at v2 — second call leaves the FTS index unchanged", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    insertMessageRow(db, { id: "1", body: "lorem ipsum dolor" });

    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM messages_fts").get() as {
        n: number;
      }
    ).n;
    expect(() => applyMigrations(db)).not.toThrow();
    const after = (
      db.prepare("SELECT COUNT(*) AS n FROM messages_fts").get() as {
        n: number;
      }
    ).n;
    expect(after).toBe(before);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("backfills existing messages rows when upgrading from v1 to v2", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        account TEXT NOT NULL,
        native_id TEXT NOT NULL,
        thread_id TEXT,
        thread_name TEXT,
        sender_name TEXT,
        sender_email TEXT,
        sent_at INTEGER NOT NULL,
        imported_at INTEGER NOT NULL,
        is_read INTEGER,
        body TEXT,
        body_html TEXT,
        raw_json TEXT
      );
      CREATE TABLE sync_state (
        account TEXT NOT NULL,
        source TEXT NOT NULL,
        delta_token TEXT,
        last_sync_at INTEGER,
        PRIMARY KEY (account, source)
      );
      CREATE TABLE sync_log (
        ts INTEGER NOT NULL,
        account TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ok','error')),
        messages_added INTEGER,
        error_message TEXT
      );
      CREATE TABLE accounts (
        username TEXT PRIMARY KEY,
        display_name TEXT,
        tenant_id TEXT,
        added_at INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    insertMessageRow(db, {
      id: "preexisting",
      body: "alpha bravo charlie",
      threadName: "Project Delta",
      senderName: "Eric",
    });

    applyMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM messages_fts").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
    expect(ftsRowidsMatching(db, "bravo")).toHaveLength(1);
    expect(ftsRowidsMatching(db, "Delta")).toHaveLength(1);
    expect(ftsRowidsMatching(db, "Eric")).toHaveLength(1);
  });

  it("insert trigger reflects new messages into the FTS index", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    insertMessageRow(db, { id: "1", body: "kangaroo platypus" });
    expect(ftsRowidsMatching(db, "kangaroo")).toHaveLength(1);
    expect(ftsRowidsMatching(db, "platypus")).toHaveLength(1);
    expect(ftsRowidsMatching(db, "absent")).toHaveLength(0);
  });

  it("delete trigger removes rows from the FTS index", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    insertMessageRow(db, { id: "1", body: "kangaroo platypus" });
    db.prepare("DELETE FROM messages WHERE id = ?").run("1");
    expect(ftsRowidsMatching(db, "kangaroo")).toHaveLength(0);
  });

  it("update trigger refreshes the FTS index when body changes", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    insertMessageRow(db, { id: "1", body: "kangaroo platypus" });
    db.prepare("UPDATE messages SET body = ? WHERE id = ?").run(
      "wombat echidna",
      "1",
    );
    expect(ftsRowidsMatching(db, "kangaroo")).toHaveLength(0);
    expect(ftsRowidsMatching(db, "wombat")).toHaveLength(1);
  });
});

describe("schema / Teams columns (migration 3)", () => {
  function hasColumn(db: Database.Database, table: string, column: string): boolean {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    return rows.some((r) => r.name === column);
  }

  it("adds chat_type, reply_to_id, mentions_json columns to messages on v2→v3", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(hasColumn(db, "messages", "chat_type")).toBe(true);
    expect(hasColumn(db, "messages", "reply_to_id")).toBe(true);
    expect(hasColumn(db, "messages", "mentions_json")).toBe(true);
  });

  it("preserves v2 data across the v3 migration", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    insertMessageRow(db, { id: "survivor", body: "pre-v3" });
    applyMigrations(db);
    const row = db
      .prepare("SELECT id, body, chat_type, reply_to_id, mentions_json FROM messages WHERE id = ?")
      .get("survivor") as {
      id: string;
      body: string;
      chat_type: string | null;
      reply_to_id: string | null;
      mentions_json: string | null;
    };
    expect(row.id).toBe("survivor");
    expect(row.body).toBe("pre-v3");
    expect(row.chat_type).toBeNull();
    expect(row.reply_to_id).toBeNull();
    expect(row.mentions_json).toBeNull();
  });

  it("upgrades a pre-existing v2 database to v3 and keeps rows intact", () => {
    const db = new Database(":memory:");
    // Simulate a v2 db by running migrations, inserting, then dropping user_version back (cheat: use current schema).
    applyMigrations(db);
    insertMessageRow(db, { id: "before-v3", body: "rows survive" });
    db.exec("PRAGMA user_version = 2");
    // Also simulate lack of new columns by dropping and recreating messages without them.
    db.exec(`
      CREATE TABLE _msg_old AS SELECT
        id, source, account, native_id, thread_id, thread_name,
        sender_name, sender_email, sent_at, imported_at, is_read,
        body, body_html, raw_json
      FROM messages;
      DROP TABLE messages;
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        account TEXT NOT NULL,
        native_id TEXT NOT NULL,
        thread_id TEXT,
        thread_name TEXT,
        sender_name TEXT,
        sender_email TEXT,
        sent_at INTEGER NOT NULL,
        imported_at INTEGER NOT NULL,
        is_read INTEGER,
        body TEXT,
        body_html TEXT,
        raw_json TEXT
      );
      INSERT INTO messages SELECT * FROM _msg_old;
      DROP TABLE _msg_old;
    `);

    applyMigrations(db);

    expect(userVersion(db)).toBe(3);
    expect(hasColumn(db, "messages", "chat_type")).toBe(true);
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = ?").get(
        "before-v3",
      ) as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it("is idempotent at v3", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    applyMigrations(db);
    expect(userVersion(db)).toBe(3);
  });
});
