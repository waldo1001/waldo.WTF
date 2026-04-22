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
    expect(CURRENT_SCHEMA_VERSION).toBe(12);
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
      DROP TABLE IF EXISTS chat_cursors;
    `);

    applyMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
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
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("schema / chat_cursors (migration 4)", () => {
  function hasColumn(
    db: Database.Database,
    table: string,
    column: string,
  ): boolean {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    return rows.some((r) => r.name === column);
  }

  it("creates chat_cursors table with composite primary key on v3→v4", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const tables = objectNames(db, "table");
    expect(tables).toContain("chat_cursors");
    expect(hasColumn(db, "chat_cursors", "account")).toBe(true);
    expect(hasColumn(db, "chat_cursors", "chat_id")).toBe(true);
    expect(hasColumn(db, "chat_cursors", "cursor")).toBe(true);
  });

  it("chat_cursors primary key rejects a duplicate (account, chat_id)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const insert = db.prepare(
      "INSERT INTO chat_cursors (account, chat_id, cursor) VALUES (?, ?, ?)",
    );
    insert.run("a@example.test", "chat-1", "2026-04-13T10:00:00.000Z");
    expect(() =>
      insert.run("a@example.test", "chat-1", "2026-04-13T11:00:00.000Z"),
    ).toThrow();
  });

  it("preserves v3 data across the v4 migration", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    insertMessageRow(db, { id: "survivor", body: "pre-v4" });
    applyMigrations(db);
    const n = (
      db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE id = ?")
        .get("survivor") as { n: number }
    ).n;
    expect(n).toBe(1);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("upgrades a pre-existing v3 database to v4 and keeps rows intact", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    insertMessageRow(db, { id: "before-v4", body: "rows survive" });
    db.exec("PRAGMA user_version = 3");
    // chat_cursors does not exist yet in this simulated v3 state.
    db.exec("DROP TABLE IF EXISTS chat_cursors");

    applyMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const tables = objectNames(db, "table");
    expect(tables).toContain("chat_cursors");
    const n = (
      db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE id = ?")
        .get("before-v4") as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it("is idempotent at v4", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    applyMigrations(db);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("schema / chat_cursors column rename (migration 5)", () => {
  function hasColumn(
    db: Database.Database,
    table: string,
    column: string,
  ): boolean {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    return rows.some((r) => r.name === column);
  }

  it("renames last_modified_iso → cursor on v4→v5", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(hasColumn(db, "chat_cursors", "cursor")).toBe(true);
    expect(hasColumn(db, "chat_cursors", "last_modified_iso")).toBe(false);
  });

  it("preserves row data across the v4→v5 rename", () => {
    const db = new Database(":memory:");
    // Simulate v4 state: create the old table shape explicitly, seed data, set version.
    db.exec(`
      CREATE TABLE chat_cursors (
        account TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        last_modified_iso TEXT NOT NULL,
        PRIMARY KEY (account, chat_id)
      );
      PRAGMA user_version = 4;
    `);
    db.prepare(
      "INSERT INTO chat_cursors (account, chat_id, last_modified_iso) VALUES (?, ?, ?)",
    ).run("a@example.test", "chat-1", "2026-04-13T10:00:00.000Z");

    // Fresh db with the rest of the schema so applyMigrations doesn't error out.
    db.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL, native_id TEXT NOT NULL, thread_id TEXT, thread_name TEXT, sender_name TEXT, sender_email TEXT, sent_at INTEGER NOT NULL, imported_at INTEGER NOT NULL, is_read INTEGER, body TEXT, body_html TEXT, raw_json TEXT, chat_type TEXT, reply_to_id TEXT, mentions_json TEXT);
      CREATE TABLE sync_state (account TEXT NOT NULL, source TEXT NOT NULL, delta_token TEXT, last_sync_at INTEGER, PRIMARY KEY (account, source));
      CREATE TABLE sync_log (ts INTEGER NOT NULL, account TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ok','error')), messages_added INTEGER, error_message TEXT);
      CREATE TABLE accounts (username TEXT PRIMARY KEY, display_name TEXT, tenant_id TEXT, added_at INTEGER NOT NULL);
    `);

    applyMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(hasColumn(db, "chat_cursors", "cursor")).toBe(true);
    const row = db
      .prepare("SELECT account, chat_id, cursor FROM chat_cursors")
      .get() as { account: string; chat_id: string; cursor: string };
    expect(row.cursor).toBe("2026-04-13T10:00:00.000Z");
  });

  it("is idempotent at the current schema version", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    applyMigrations(db);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("migrates an existing v5 db to v6 preserving rows and FTS index", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL,
        native_id TEXT NOT NULL, thread_id TEXT, thread_name TEXT,
        sender_name TEXT, sender_email TEXT, sent_at INTEGER NOT NULL,
        imported_at INTEGER NOT NULL, is_read INTEGER, body TEXT,
        body_html TEXT, raw_json TEXT, chat_type TEXT, reply_to_id TEXT,
        mentions_json TEXT
      );
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        body, thread_name, sender_name, content='messages', content_rowid='rowid'
      );
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, body, thread_name, sender_name)
        VALUES (new.rowid, new.body, new.thread_name, new.sender_name);
      END;
      INSERT INTO messages (id, source, account, native_id, sent_at, imported_at, body, thread_name)
      VALUES ('x', 'outlook', 'a', 'n', 0, 0, 'kangaroo', 'subj');
      PRAGMA user_version = 5;
    `);
    applyMigrations(db);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const row = db.prepare("SELECT id, body FROM messages").get() as {
      id: string;
      body: string;
    };
    expect(row).toEqual({ id: "x", body: "kangaroo" });
    const hit = db
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'kangaroo'")
      .all();
    expect(hit).toHaveLength(1);
  });
});

describe("schema / oauth_access_tokens (migration 9)", () => {
  function hasColumn(
    db: Database.Database,
    table: string,
    column: string,
  ): boolean {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    return rows.some((r) => r.name === column);
  }

  it("creates oauth_access_tokens table on v8→v9", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const tables = objectNames(db, "table");
    expect(tables).toContain("oauth_access_tokens");
    expect(hasColumn(db, "oauth_access_tokens", "access_token")).toBe(true);
    expect(hasColumn(db, "oauth_access_tokens", "refresh_token")).toBe(true);
    expect(hasColumn(db, "oauth_access_tokens", "client_id")).toBe(true);
    expect(hasColumn(db, "oauth_access_tokens", "access_expires_at")).toBe(true);
    expect(hasColumn(db, "oauth_access_tokens", "refresh_expires_at")).toBe(true);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("oauth_access_tokens PRIMARY KEY rejects duplicate access_token", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris_json, created_at) VALUES (?, ?, ?, ?)",
    ).run("c1", null, '["https://claude.ai/cb"]', 0);
    const insert = db.prepare(
      "INSERT INTO oauth_access_tokens (access_token, refresh_token, client_id, scope, access_expires_at, refresh_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("at-1", "rt-1", "c1", "mcp", 1e12, 1e12, 0);
    expect(() => insert.run("at-1", "rt-2", "c1", "mcp", 1e12, 1e12, 0)).toThrow();
  });

  it("v8→v9 preserves oauth_clients and oauth_auth_codes data", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris_json, created_at) VALUES (?, ?, ?, ?)",
    ).run("survivor", null, '["https://claude.ai/cb"]', 0);
    db.exec("PRAGMA user_version = 8");
    db.exec("DROP TABLE IF EXISTS oauth_access_tokens");
    applyMigrations(db);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const tables = objectNames(db, "table");
    expect(tables).toContain("oauth_access_tokens");
    const n = (
      db
        .prepare("SELECT COUNT(*) AS n FROM oauth_clients WHERE client_id = ?")
        .get("survivor") as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it("is idempotent at v9 (current schema)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    applyMigrations(db);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("schema / oauth_auth_codes (migration 8)", () => {
  function hasColumn(
    db: Database.Database,
    table: string,
    column: string,
  ): boolean {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    return rows.some((r) => r.name === column);
  }

  it("creates oauth_auth_codes table on v7→v8", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const tables = objectNames(db, "table");
    expect(tables).toContain("oauth_auth_codes");
    expect(hasColumn(db, "oauth_auth_codes", "code")).toBe(true);
    expect(hasColumn(db, "oauth_auth_codes", "client_id")).toBe(true);
    expect(hasColumn(db, "oauth_auth_codes", "redirect_uri")).toBe(true);
    expect(hasColumn(db, "oauth_auth_codes", "code_challenge")).toBe(true);
    expect(hasColumn(db, "oauth_auth_codes", "state")).toBe(true);
    expect(hasColumn(db, "oauth_auth_codes", "expires_at")).toBe(true);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("oauth_auth_codes PRIMARY KEY rejects duplicate code on raw insert", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris_json, created_at) VALUES (?, ?, ?, ?)",
    ).run("c1", null, '["https://claude.ai/cb"]', 0);
    const insert = db.prepare(
      "INSERT INTO oauth_auth_codes (code, client_id, redirect_uri, scope, code_challenge, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("code-1", "c1", "https://claude.ai/cb", "mcp", "ch", null, 1e12, 0);
    expect(() =>
      insert.run("code-1", "c1", "https://claude.ai/cb", "mcp", "ch", null, 1e12, 0),
    ).toThrow();
  });

  it("v7→v8 preserves oauth_clients data", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris_json, created_at) VALUES (?, ?, ?, ?)",
    ).run("survivor", null, '["https://claude.ai/cb"]', 0);
    db.exec("PRAGMA user_version = 7");
    db.exec("DROP TABLE IF EXISTS oauth_auth_codes");
    applyMigrations(db);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const n = (
      db
        .prepare("SELECT COUNT(*) AS n FROM oauth_clients WHERE client_id = ?")
        .get("survivor") as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it("is idempotent at v8 (current schema)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    applyMigrations(db);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("schema / oauth_clients (migration 7)", () => {
  function hasColumn(
    db: Database.Database,
    table: string,
    column: string,
  ): boolean {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    return rows.some((r) => r.name === column);
  }

  it("creates oauth_clients table on v6→v7", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const tables = objectNames(db, "table");
    expect(tables).toContain("oauth_clients");
    expect(hasColumn(db, "oauth_clients", "client_id")).toBe(true);
    expect(hasColumn(db, "oauth_clients", "client_name")).toBe(true);
    expect(hasColumn(db, "oauth_clients", "redirect_uris_json")).toBe(true);
    expect(hasColumn(db, "oauth_clients", "created_at")).toBe(true);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("oauth_clients PRIMARY KEY rejects duplicate client_id on raw insert", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const insert = db.prepare(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris_json, created_at) VALUES (?, ?, ?, ?)",
    );
    insert.run(
      "client-1",
      "Claude",
      '["https://claude.ai/cb"]',
      1_700_000_000_000,
    );
    expect(() =>
      insert.run(
        "client-1",
        "Other",
        '["https://other.example/cb"]',
        1_700_000_000_001,
      ),
    ).toThrow();
  });

  it("upgrades a pre-existing v6 database to v7 preserving messages rows", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    insertMessageRow(db, { id: "before-v7", body: "rows survive v7" });
    db.exec("PRAGMA user_version = 6");
    db.exec("DROP TABLE IF EXISTS oauth_clients");

    applyMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const tables = objectNames(db, "table");
    expect(tables).toContain("oauth_clients");
    const n = (
      db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE id = ?")
        .get("before-v7") as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it("is idempotent at the current schema version (from v7 base)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    applyMigrations(db);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("schema / sent-items support (migration 11)", () => {
  function hasColumn(
    db: Database.Database,
    table: string,
    column: string,
  ): boolean {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    return rows.some((r) => r.name === column);
  }

  it("adds from_me column to messages with default 0", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(hasColumn(db, "messages", "from_me")).toBe(true);

    insertMessageRow(db, { id: "m1", body: "hi" });
    const row = db
      .prepare("SELECT from_me FROM messages WHERE id = ?")
      .get("m1") as { from_me: number };
    expect(row.from_me).toBe(0);
  });

  it("adds folder column to sync_state with default ''", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(hasColumn(db, "sync_state", "folder")).toBe(true);

    db.prepare(
      "INSERT INTO sync_state (account, source, delta_token, last_sync_at) VALUES (?, ?, ?, ?)",
    ).run("a@example.test", "outlook", "tok", 1);
    const row = db
      .prepare(
        "SELECT folder FROM sync_state WHERE account = ? AND source = ?",
      )
      .get("a@example.test", "outlook") as { folder: string };
    expect(row.folder).toBe("");
  });

  it("sync_state PK is (account, source, folder) — same (account, source) allowed for different folder", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const insert = db.prepare(
      "INSERT INTO sync_state (account, source, delta_token, last_sync_at, folder) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("a@example.test", "outlook", "tok-inbox", 1, "");
    expect(() =>
      insert.run("a@example.test", "outlook", "tok-sent", 2, "sentitems"),
    ).not.toThrow();
    // But duplicate (account, source, folder) still rejects.
    expect(() =>
      insert.run("a@example.test", "outlook", "tok-dup", 3, ""),
    ).toThrow();
  });

  it("upgrades a pre-existing v10 database to v11 preserving messages + sync_state data", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    insertMessageRow(db, { id: "before-v11", body: "rows survive" });
    db.prepare(
      "INSERT INTO sync_state (account, source, delta_token, last_sync_at) VALUES (?, ?, ?, ?)",
    ).run("a@example.test", "outlook", "existing-token", 42);
    db.exec("PRAGMA user_version = 10");
    // Simulate a v10 schema where from_me + folder do not exist yet.
    db.exec(`
      CREATE TABLE _msg_old AS SELECT
        id, source, account, native_id, thread_id, thread_name,
        sender_name, sender_email, sent_at, imported_at, is_read,
        body, body_html, raw_json, chat_type, reply_to_id, mentions_json
      FROM messages;
      DROP TABLE messages;
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL,
        native_id TEXT NOT NULL, thread_id TEXT, thread_name TEXT,
        sender_name TEXT, sender_email TEXT, sent_at INTEGER NOT NULL,
        imported_at INTEGER NOT NULL, is_read INTEGER, body TEXT,
        body_html TEXT, raw_json TEXT, chat_type TEXT, reply_to_id TEXT,
        mentions_json TEXT
      );
      INSERT INTO messages SELECT * FROM _msg_old;
      DROP TABLE _msg_old;

      CREATE TABLE _ss_old AS SELECT account, source, delta_token, last_sync_at
      FROM sync_state;
      DROP TABLE sync_state;
      CREATE TABLE sync_state (
        account TEXT NOT NULL, source TEXT NOT NULL,
        delta_token TEXT, last_sync_at INTEGER,
        PRIMARY KEY (account, source)
      );
      INSERT INTO sync_state SELECT * FROM _ss_old;
      DROP TABLE _ss_old;
    `);

    applyMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(hasColumn(db, "messages", "from_me")).toBe(true);
    expect(hasColumn(db, "sync_state", "folder")).toBe(true);

    const msgRow = db
      .prepare("SELECT id, from_me FROM messages WHERE id = ?")
      .get("before-v11") as { id: string; from_me: number };
    expect(msgRow.id).toBe("before-v11");
    expect(msgRow.from_me).toBe(0);

    const ssRow = db
      .prepare(
        "SELECT delta_token, folder FROM sync_state WHERE account = ? AND source = ?",
      )
      .get("a@example.test", "outlook") as {
      delta_token: string;
      folder: string;
    };
    expect(ssRow.delta_token).toBe("existing-token");
    expect(ssRow.folder).toBe("");
  });

  it("is idempotent at v11 (current schema)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    applyMigrations(db);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("schema / steering_rules (migration 10)", () => {
  function hasColumn(
    db: Database.Database,
    table: string,
    column: string,
  ): boolean {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    return rows.some((r) => r.name === column);
  }

  it("creates steering_rules table on v9→v10", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const tables = objectNames(db, "table");
    expect(tables).toContain("steering_rules");
    for (const col of [
      "id",
      "rule_type",
      "pattern",
      "source",
      "account",
      "reason",
      "enabled",
      "created_at",
    ]) {
      expect(hasColumn(db, "steering_rules", col)).toBe(true);
    }
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("creates steering_rules indices (enabled+type and dedupe)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const indices = objectNames(db, "index");
    expect(indices).toEqual(
      expect.arrayContaining(["idx_steering_enabled_type", "idx_steering_dedupe"]),
    );
  });

  it("steering_rules.rule_type CHECK rejects unknown values", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const insert = db.prepare(
      "INSERT INTO steering_rules (rule_type, pattern, enabled, created_at) VALUES (?, ?, ?, ?)",
    );
    expect(() => insert.run("bogus_type", "foo", 1, 0)).toThrow();
    expect(() => insert.run("sender_email", "foo@bar.com", 1, 0)).not.toThrow();
  });

  it("steering_rules dedupe unique index rejects duplicates across NULL scope", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const insert = db.prepare(
      "INSERT INTO steering_rules (rule_type, pattern, source, account, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("sender_email", "foo@bar.com", null, null, 1, 0);
    expect(() =>
      insert.run("sender_email", "foo@bar.com", null, null, 1, 1),
    ).toThrow();
    // Different scope should be allowed.
    expect(() =>
      insert.run("sender_email", "foo@bar.com", "outlook", null, 1, 2),
    ).not.toThrow();
    expect(() =>
      insert.run("sender_email", "foo@bar.com", null, "a@ex.test", 1, 3),
    ).not.toThrow();
  });

  it("upgrades a pre-existing v9 database to v10 preserving data", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      "INSERT INTO accounts (username, display_name, tenant_id, added_at) VALUES (?, ?, ?, ?)",
    ).run("survivor@example.test", "Survivor", "tenant", 1);
    db.exec("PRAGMA user_version = 9");
    db.exec("DROP TABLE IF EXISTS steering_rules");

    applyMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const tables = objectNames(db, "table");
    expect(tables).toContain("steering_rules");
    const n = (
      db
        .prepare("SELECT COUNT(*) AS n FROM accounts WHERE username = ?")
        .get("survivor@example.test") as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it("is idempotent at v10 (current schema)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    applyMigrations(db);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("schema / viva_subscriptions (migration 12)", () => {
  function hasColumn(
    db: Database.Database,
    table: string,
    column: string,
  ): boolean {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    return rows.some((r) => r.name === column);
  }

  it("creates viva_subscriptions table on v11→v12", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const tables = objectNames(db, "table");
    expect(tables).toContain("viva_subscriptions");
    for (const col of [
      "account",
      "network_id",
      "network_name",
      "community_id",
      "community_name",
      "enabled",
      "subscribed_at",
      "last_cursor_at",
    ]) {
      expect(hasColumn(db, "viva_subscriptions", col)).toBe(true);
    }
  });

  it("creates the idx_viva_subs_account index", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const indices = objectNames(db, "index");
    expect(indices).toContain("idx_viva_subs_account");
  });

  it("viva_subscriptions PK is (account, community_id) — duplicate rejects", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const insert = db.prepare(
      "INSERT INTO viva_subscriptions (account, network_id, community_id, subscribed_at) VALUES (?, ?, ?, ?)",
    );
    insert.run("a@example.test", "net-1", "comm-1", 1);
    expect(() =>
      insert.run("a@example.test", "net-1", "comm-1", 2),
    ).toThrow();
    // Different account → allowed
    expect(() =>
      insert.run("b@example.test", "net-1", "comm-1", 3),
    ).not.toThrow();
    // Different community → allowed
    expect(() =>
      insert.run("a@example.test", "net-1", "comm-2", 4),
    ).not.toThrow();
  });

  it("upgrades a pre-existing v11 database to v12 preserving messages data", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    insertMessageRow(db, { id: "before-v12", body: "rows survive" });
    db.exec("PRAGMA user_version = 11");
    db.exec("DROP TABLE IF EXISTS viva_subscriptions");

    applyMigrations(db);

    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const tables = objectNames(db, "table");
    expect(tables).toContain("viva_subscriptions");
    const n = (
      db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE id = ?")
        .get("before-v12") as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it("is idempotent at v12 (current schema)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    applyMigrations(db);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });
});
