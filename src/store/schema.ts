import type { Database } from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 1;

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

export function applyMigrations(db: Database): void {
  const current = (
    db.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;

  if (current >= CURRENT_SCHEMA_VERSION) return;

  const run = db.transaction(() => {
    if (current < 1) {
      db.exec(MIGRATION_1);
    }
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
  run();
}
