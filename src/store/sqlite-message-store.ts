import type { Database, Statement } from "better-sqlite3";
import type {
  DeleteResult,
  MessageStore,
  UpsertResult,
} from "./message-store.js";
import type { Message, MessageSource, SyncStateEntry } from "./types.js";

const SCHEMA = `
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
`;

interface MessageRow {
  id: string;
  source: string;
  account: string;
  native_id: string;
  thread_id: string | null;
  thread_name: string | null;
  sender_name: string | null;
  sender_email: string | null;
  sent_at: number;
  imported_at: number;
  is_read: number | null;
  body: string | null;
  body_html: string | null;
  raw_json: string | null;
}

interface SyncStateRow {
  account: string;
  source: string;
  delta_token: string | null;
  last_sync_at: number | null;
}

const nullable = <T>(value: T | undefined): T | null =>
  value === undefined ? null : value;

const boolToInt = (value: boolean | undefined): number | null => {
  if (value === undefined) return null;
  return value ? 1 : 0;
};

export class SqliteMessageStore implements MessageStore {
  private readonly existsStmt: Statement<[string]>;
  private readonly upsertStmt: Statement<MessageRow>;
  private readonly deleteStmt: Statement<[string]>;
  private readonly getSyncStmt: Statement<[string, string]>;
  private readonly setSyncStmt: Statement<
    [string, string, string | null, number | null]
  >;

  constructor(private readonly db: Database) {
    db.exec(SCHEMA);

    this.existsStmt = db.prepare("SELECT 1 FROM messages WHERE id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO messages (
        id, source, account, native_id,
        thread_id, thread_name, sender_name, sender_email,
        sent_at, imported_at, is_read, body, body_html, raw_json
      ) VALUES (
        @id, @source, @account, @native_id,
        @thread_id, @thread_name, @sender_name, @sender_email,
        @sent_at, @imported_at, @is_read, @body, @body_html, @raw_json
      )
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        account = excluded.account,
        native_id = excluded.native_id,
        thread_id = excluded.thread_id,
        thread_name = excluded.thread_name,
        sender_name = excluded.sender_name,
        sender_email = excluded.sender_email,
        sent_at = excluded.sent_at,
        imported_at = excluded.imported_at,
        is_read = excluded.is_read,
        body = excluded.body,
        body_html = excluded.body_html,
        raw_json = excluded.raw_json
    `);
    this.deleteStmt = db.prepare("DELETE FROM messages WHERE id = ?");
    this.getSyncStmt = db.prepare(
      "SELECT account, source, delta_token, last_sync_at FROM sync_state WHERE account = ? AND source = ?",
    );
    this.setSyncStmt = db.prepare(`
      INSERT INTO sync_state (account, source, delta_token, last_sync_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account, source) DO UPDATE SET
        delta_token = excluded.delta_token,
        last_sync_at = excluded.last_sync_at
    `);
  }

  async upsertMessages(messages: readonly Message[]): Promise<UpsertResult> {
    if (messages.length === 0) return { added: 0, updated: 0 };

    const run = this.db.transaction((rows: readonly Message[]) => {
      let added = 0;
      let updated = 0;
      for (const m of rows) {
        const exists = this.existsStmt.get(m.id) !== undefined;
        this.upsertStmt.run(toRow(m));
        if (exists) updated++;
        else added++;
      }
      return { added, updated };
    });

    return run(messages);
  }

  async deleteMessages(ids: readonly string[]): Promise<DeleteResult> {
    if (ids.length === 0) return { deleted: 0 };

    const run = this.db.transaction((rows: readonly string[]) => {
      let deleted = 0;
      for (const id of rows) {
        const result = this.deleteStmt.run(id);
        deleted += result.changes;
      }
      return { deleted };
    });

    return run(ids);
  }

  async getSyncState(
    account: string,
    source: MessageSource,
  ): Promise<SyncStateEntry | null> {
    const row = this.getSyncStmt.get(account, source) as
      | SyncStateRow
      | undefined;
    if (row === undefined) return null;
    const entry: SyncStateEntry = {
      account: row.account,
      source: row.source as MessageSource,
    };
    return {
      ...entry,
      ...(row.delta_token !== null && { deltaToken: row.delta_token }),
      ...(row.last_sync_at !== null && {
        lastSyncAt: new Date(row.last_sync_at),
      }),
    };
  }

  async setSyncState(entry: SyncStateEntry): Promise<void> {
    this.setSyncStmt.run(
      entry.account,
      entry.source,
      nullable(entry.deltaToken),
      entry.lastSyncAt === undefined ? null : entry.lastSyncAt.getTime(),
    );
  }
}

function toRow(m: Message): MessageRow {
  return {
    id: m.id,
    source: m.source,
    account: m.account,
    native_id: m.nativeId,
    thread_id: nullable(m.threadId),
    thread_name: nullable(m.threadName),
    sender_name: nullable(m.senderName),
    sender_email: nullable(m.senderEmail),
    sent_at: m.sentAt.getTime(),
    imported_at: m.importedAt.getTime(),
    is_read: boolToInt(m.isRead),
    body: nullable(m.body),
    body_html: nullable(m.bodyHtml),
    raw_json: nullable(m.rawJson),
  };
}

