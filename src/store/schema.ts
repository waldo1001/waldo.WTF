import type { Database } from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 19;

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

// v13 threads the Entra tenant id through Viva subscriptions so the sync loop
// can acquire a per-tenant Yammer token when syncing externally-joined
// communities. NULL = legacy home-tenant row (treat as default authority).
function migrateV13(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(viva_subscriptions)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "tenant_id")) {
    db.exec("ALTER TABLE viva_subscriptions ADD COLUMN tenant_id TEXT");
  }
}

// v14 adds Teams channel subscriptions: per-channel opt-in mirroring the Viva
// pattern. Three-tuple PK (account, team_id, channel_id) defends against
// theoretical channel-id collisions across teams. Delta cursors live in
// chat_cursors keyed as `channel:<teamId>:<channelId>`; last_cursor_at here is
// display/observability metadata only.
const MIGRATION_14 = `
CREATE TABLE IF NOT EXISTS teams_channel_subscriptions (
  account TEXT NOT NULL,
  team_id TEXT NOT NULL,
  team_name TEXT,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  subscribed_at INTEGER NOT NULL,
  last_cursor_at INTEGER,
  PRIMARY KEY (account, team_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_tcs_account_enabled
  ON teams_channel_subscriptions(account, enabled);
`;

// v15 threads the Entra tenant id through Teams channel subscriptions so the
// sync loop can acquire a per-tenant Teams token when the user has cached MSAL
// accounts in multiple tenants. NULL = legacy row created before this slice
// (treated as the running account's home tenant at sync time).
function migrateV15(db: Database): void {
  const cols = db
    .prepare("PRAGMA table_info(teams_channel_subscriptions)")
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === "tenant_id")) {
    db.exec(
      "ALTER TABLE teams_channel_subscriptions ADD COLUMN tenant_id TEXT",
    );
  }
}

// v16 adds calendar support: `events` + `event_attendees` hold synced
// Microsoft Graph calendar data (slice 1 of the calendar feature), and
// `calendar_accounts` tracks per-account opt-in (populated starting in a
// later slice — calendar sync is deliberately not on-by-default like the
// other sources). `start_at`/`end_at`/`last_modified_at` are ISO-8601 UTC
// text, not the INTEGER-ms convention used elsewhere in this schema,
// because Graph's all-day-event semantics (00:00→24:00 in the user's tz)
// aren't faithfully representable as a single UTC instant without the
// `is_all_day` flag alongside it — text keeps the two paired at the row
// level. The `event_attendees` FK declares ON DELETE CASCADE for
// documentation/defense-in-depth, but MessageStore.deleteEvents does not
// rely on it — it deletes attendee rows explicitly in the same
// transaction, since not every caller opens the database with
// `PRAGMA foreign_keys = ON` (see openDatabase vs. bare `new Database()`
// in tests).
const MIGRATION_16 = `
CREATE TABLE IF NOT EXISTS events (
  account TEXT NOT NULL,
  event_id TEXT NOT NULL,
  tenant_id TEXT,
  subject TEXT,
  organizer_name TEXT,
  organizer_email TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  is_all_day INTEGER NOT NULL DEFAULT 0,
  is_cancelled INTEGER NOT NULL DEFAULT 0,
  chat_id TEXT,
  online_meeting_url TEXT,
  online_meeting_id TEXT,
  last_modified_at TEXT,
  raw_json TEXT,
  PRIMARY KEY (account, event_id)
);
CREATE INDEX IF NOT EXISTS idx_events_start_at ON events(start_at);
CREATE INDEX IF NOT EXISTS idx_events_account_start_at ON events(account, start_at);

CREATE TABLE IF NOT EXISTS event_attendees (
  account TEXT NOT NULL,
  event_id TEXT NOT NULL,
  attendee_email TEXT NOT NULL,
  display_name TEXT,
  response_status TEXT NOT NULL DEFAULT 'none',
  is_organizer INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, event_id, attendee_email),
  FOREIGN KEY (account, event_id) REFERENCES events(account, event_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS calendar_accounts (
  account TEXT PRIMARY KEY,
  tenant_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  transcripts_enabled INTEGER NOT NULL DEFAULT 0,
  enabled_at INTEGER NOT NULL
);
`;

// v17 adds two event-targeted steering rule types
// (event_organizer_email, event_subject_contains — calendar slice 8).
// steering_rules.rule_type carries a CHECK constraint enumerating valid
// values, so (unlike a plain TEXT column) this needs a real rebuild —
// SQLite has no ALTER TABLE to widen a CHECK constraint in place. Mirrors
// the sync_state rebuild in migrateV11: create the widened table, copy
// rows verbatim (ids preserved), drop the old one, rename into place.
// Any future schema change that needs real new columns/tables bumps to
// v18+ — v17 is this enum-widening rebuild only.
function migrateV17(db: Database): void {
  db.exec(`
    CREATE TABLE steering_rules_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type TEXT NOT NULL CHECK(rule_type IN
        ('sender_email','sender_domain','thread_id','thread_name_contains','body_contains',
         'event_organizer_email','event_subject_contains')),
      pattern TEXT NOT NULL,
      source TEXT,
      account TEXT,
      reason TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    INSERT INTO steering_rules_new
      (id, rule_type, pattern, source, account, reason, enabled, created_at)
      SELECT id, rule_type, pattern, source, account, reason, enabled, created_at
      FROM steering_rules;
    DROP TABLE steering_rules;
    ALTER TABLE steering_rules_new RENAME TO steering_rules;
    CREATE INDEX IF NOT EXISTS idx_steering_enabled_type
      ON steering_rules(enabled, rule_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_steering_dedupe
      ON steering_rules(rule_type, pattern, IFNULL(source,''), IFNULL(account,''));
  `);
}

// v18 adds meeting transcript support (calendar transcripts T1):
// `transcripts` holds one row per fetched transcript (a recording restart
// can produce more than one per meeting, hence transcript_id as part of
// the PK, not just account+event_id) and `transcript_segments` holds the
// parsed VTT cues. Both cascade-delete with their `events` row, mirroring
// event_attendees in v16. `status` covers fetch attempts that found no
// transcript content at all ('not-available' / 'quota-exhausted' /
// 'fetch-failed') as well as successes ('ok') — the sync job (a later
// slice) is expected to persist a status row even on failure so repeated
// polling can apply a per-status retry cooldown instead of re-fetching
// blindly every tick.
const MIGRATION_18 = `
CREATE TABLE IF NOT EXISTS transcripts (
  account TEXT NOT NULL,
  event_id TEXT NOT NULL,
  transcript_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  vtt_bytes INTEGER,
  segment_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  raw_json TEXT,
  PRIMARY KEY (account, event_id, transcript_id),
  FOREIGN KEY (account, event_id) REFERENCES events(account, event_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  account TEXT NOT NULL,
  event_id TEXT NOT NULL,
  transcript_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  speaker_email TEXT,
  speaker_display_name TEXT,
  start_offset_ms INTEGER NOT NULL,
  end_offset_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (account, event_id, transcript_id, sequence),
  FOREIGN KEY (account, event_id, transcript_id)
    REFERENCES transcripts(account, event_id, transcript_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_segments_event
  ON transcript_segments(account, event_id, sequence);
`;

// v19 adds full-text search over transcript segments (calendar transcripts
// T7), mirroring messages_fts (migration 2) exactly: external-content FTS5
// table keyed off transcript_segments' implicit rowid (the table has a
// composite TEXT primary key, same situation as messages.id — SQLite still
// maintains a hidden rowid unless a table is declared WITHOUT ROWID), with
// ai/ad/au triggers keeping the index in sync and a one-time backfill for
// any segments that existed before this migration ran.
// IF NOT EXISTS on the virtual table + triggers (unlike MIGRATION_2's
// messages_fts, which never needs it — no test rewinds below v2): this is
// currently the LATEST migration, so it's the one migration every
// "rewind user_version and re-apply" test in this file re-runs on its
// second applyMigrations call, after the first call already created these
// objects. INSERT OR IGNORE on the backfill for the same reason.
const MIGRATION_19 = `
CREATE VIRTUAL TABLE IF NOT EXISTS transcript_segments_fts USING fts5(
  text,
  content='transcript_segments',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS transcript_segments_ai AFTER INSERT ON transcript_segments BEGIN
  INSERT INTO transcript_segments_fts(rowid, text)
  VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS transcript_segments_ad AFTER DELETE ON transcript_segments BEGIN
  INSERT INTO transcript_segments_fts(transcript_segments_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS transcript_segments_au AFTER UPDATE ON transcript_segments BEGIN
  INSERT INTO transcript_segments_fts(transcript_segments_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
  INSERT INTO transcript_segments_fts(rowid, text)
  VALUES (new.rowid, new.text);
END;

INSERT OR IGNORE INTO transcript_segments_fts(rowid, text)
  SELECT rowid, text FROM transcript_segments;
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
    if (current < 13) {
      migrateV13(db);
    }
    if (current < 14) {
      db.exec(MIGRATION_14);
    }
    if (current < 15) {
      migrateV15(db);
    }
    if (current < 16) {
      db.exec(MIGRATION_16);
    }
    if (current < 17) {
      migrateV17(db);
    }
    if (current < 18) {
      db.exec(MIGRATION_18);
    }
    if (current < 19) {
      db.exec(MIGRATION_19);
    }
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
  run();
}
