import type { Database } from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 6;

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
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
  run();
}
