import type { Database } from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 12;

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS messages (
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
CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_account_source
  ON messages(account, source);

CREATE TABLE IF NOT EXISTS sync_state (
  account TEXT NOT NULL,
  source TEXT NOT NULL,
  delta_token TEXT,
  last_sync_at INTEGER,
  PRIMARY KEY (account, source)
);

CREATE TABLE IF NOT EXISTS sync_log (
  ts INTEGER NOT NULL,
  account TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok','error')),
  messages_added INTEGER,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_log_ts ON sync_log(ts DESC);

CREATE TABLE IF NOT EXISTS accounts (
  username TEXT PRIMARY KEY,
  display_name TEXT,
  tenant_id TEXT,
  added_at INTEGER NOT NULL
);
`;

const MIGRATION_2 = `
CREATE VIRTUAL TABLE messages_fts USING fts5(
  body,
  thread_name,
  sender_name,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body, thread_name, sender_name)
  VALUES (new.rowid, new.body, new.thread_name, new.sender_name);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body, thread_name, sender_name)
  VALUES ('delete', old.rowid, old.body, old.thread_name, old.sender_name);
END;

CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body, thread_name, sender_name)
  VALUES ('delete', old.rowid, old.body, old.thread_name, old.sender_name);
  INSERT INTO messages_fts(rowid, body, thread_name, sender_name)
  VALUES (new.rowid, new.body, new.thread_name, new.sender_name);
END;

INSERT INTO messages_fts(rowid, body, thread_name, sender_name)
  SELECT rowid, body, thread_name, sender_name FROM messages;
`;

const MIGRATION_3 = `
ALTER TABLE messages ADD COLUMN chat_type TEXT;
ALTER TABLE messages ADD COLUMN reply_to_id TEXT;
ALTER TABLE messages ADD COLUMN mentions_json TEXT;
`;

const MIGRATION_4 = `
CREATE TABLE IF NOT EXISTS chat_cursors (
  account TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  last_modified_iso TEXT NOT NULL,
  PRIMARY KEY (account, chat_id)
);
`;

const MIGRATION_5 = `
ALTER TABLE chat_cursors RENAME COLUMN last_modified_iso TO cursor;
`;

// v6 is a marker-only migration for the body-from-html backfill. No DDL —
// the `body` and `body_html` columns already exist since v1. The bump lets
// operational tooling and future code assume "v6+ means backfill has run
// or is expected to run via `cli --backfill-bodies`".
const MIGRATION_6 = `SELECT 1;`;

const MIGRATION_7 = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

const MIGRATION_8 = `
CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'mcp',
  code_challenge TEXT NOT NULL,
  state TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

const MIGRATION_9 = `
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  access_token TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  scope TEXT NOT NULL DEFAULT 'mcp',
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_refresh
  ON oauth_access_tokens(refresh_token);
`;

const MIGRATION_10 = `
CREATE TABLE IF NOT EXISTS steering_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_type TEXT NOT NULL CHECK(rule_type IN
    ('sender_email','sender_domain','thread_id','thread_name_contains','body_contains')),
  pattern TEXT NOT NULL,
  source TEXT,
  account TEXT,
  reason TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steering_enabled_type
  ON steering_rules(enabled, rule_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_steering_dedupe
  ON steering_rules(rule_type, pattern, IFNULL(source,''), IFNULL(account,''));
`;

// v11 adds Sent Items support:
// - `messages.from_me` marks rows ingested from /me/mailFolders/sentitems.
// - `sync_state.folder` lets a single (account, source) carry multiple cursors
//   (inbox vs. sentitems). PK becomes (account, source, folder); legacy rows
//   get folder=''.
function migrateV11(db: Database): void {
  const msgCols = db.prepare("PRAGMA table_info(messages)").all() as {
    name: string;
  }[];
  if (!msgCols.some((c) => c.name === "from_me")) {
    db.exec(
      "ALTER TABLE messages ADD COLUMN from_me INTEGER NOT NULL DEFAULT 0",
    );
  }

  const ssCols = db.prepare("PRAGMA table_info(sync_state)").all() as {
    name: string;
  }[];
  if (ssCols.length > 0 && !ssCols.some((c) => c.name === "folder")) {
    db.exec(`
      CREATE TABLE sync_state_new (
        account TEXT NOT NULL,
        source TEXT NOT NULL,
        folder TEXT NOT NULL DEFAULT '',
        delta_token TEXT,
        last_sync_at INTEGER,
        PRIMARY KEY (account, source, folder)
      );
      INSERT INTO sync_state_new (account, source, folder, delta_token, last_sync_at)
        SELECT account, source, '', delta_token, last_sync_at FROM sync_state;
      DROP TABLE sync_state;
      ALTER TABLE sync_state_new RENAME TO sync_state;
    `);
  }
}

// v12 adds Viva Engage support: per-account subscription list with a per-row
// timestamp cursor. Per-community cursors live in `viva_subscriptions`, not
// `sync_state`, so each community advances independently.
const MIGRATION_12 = `
CREATE TABLE IF NOT EXISTS viva_subscriptions (
  account TEXT NOT NULL,
  network_id TEXT NOT NULL,
  network_name TEXT,
  community_id TEXT NOT NULL,
  community_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  subscribed_at INTEGER NOT NULL,
  last_cursor_at INTEGER,
  PRIMARY KEY (account, community_id)
);
CREATE INDEX IF NOT EXISTS idx_viva_subs_account
  ON viva_subscriptions(account, enabled);
`;

export function applyMigrations(db: Database): void {
  const current = (
    db.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;

  if (current >= CURRENT_SCHEMA_VERSION) return;

  const run = db.transaction(() => {
    if (current < 1) {
      db.exec(MIGRATION_1);
    }
    if (current < 2) {
      db.exec(MIGRATION_2);
    }
    if (current < 3) {
      db.exec(MIGRATION_3);
    }
    if (current < 4) {
      db.exec(MIGRATION_4);
    }
    if (current < 5) {
      db.exec(MIGRATION_5);
    }
    if (current < 6) {
      db.exec(MIGRATION_6);
    }
    if (current < 7) {
      db.exec(MIGRATION_7);
    }
    if (current < 8) {
      db.exec(MIGRATION_8);
    }
    if (current < 9) {
      db.exec(MIGRATION_9);
    }
    if (current < 10) {
      db.exec(MIGRATION_10);
    }
    if (current < 11) {
      migrateV11(db);
    }
    if (current < 12) {
      db.exec(MIGRATION_12);
    }
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
  run();
}
