import type { Database, Statement } from "better-sqlite3";
import type {
  DeleteResult,
  MessageStore,
  UpsertResult,
} from "./message-store.js";
import { applyMigrations } from "./schema.js";
import type {
  AccountRecord,
  Message,
  MessageSource,
  SearchHit,
  SyncLogEntry,
  SyncStateEntry,
} from "./types.js";

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

interface AccountRow {
  username: string;
  display_name: string | null;
  tenant_id: string | null;
  added_at: number;
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
  private readonly appendSyncLogStmt: Statement<
    [number, string, string, string, number | null, string | null]
  >;
  private readonly upsertAccountStmt: Statement<
    [string, string | null, string | null, number]
  >;
  private readonly listAccountsStmt: Statement<[]>;
  private readonly searchStmt: Statement<[string, number]>;

  constructor(private readonly db: Database) {
    applyMigrations(db);

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
    this.appendSyncLogStmt = db.prepare(`
      INSERT INTO sync_log (ts, account, source, status, messages_added, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.upsertAccountStmt = db.prepare(`
      INSERT INTO accounts (username, display_name, tenant_id, added_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        display_name = excluded.display_name,
        tenant_id = excluded.tenant_id,
        added_at = excluded.added_at
    `);
    this.listAccountsStmt = db.prepare(
      "SELECT username, display_name, tenant_id, added_at FROM accounts ORDER BY added_at ASC, username ASC",
    );
    this.searchStmt = db.prepare(`
      SELECT m.id, m.source, m.account, m.native_id,
             m.thread_id, m.thread_name, m.sender_name, m.sender_email,
             m.sent_at, m.imported_at, m.is_read, m.body, m.body_html, m.raw_json,
             snippet(messages_fts, 0, '[', ']', '…', 16) AS snippet,
             bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
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

  async appendSyncLog(entry: SyncLogEntry): Promise<void> {
    this.appendSyncLogStmt.run(
      entry.ts.getTime(),
      entry.account,
      entry.source,
      entry.status,
      nullable(entry.messagesAdded),
      nullable(entry.errorMessage),
    );
  }

  async upsertAccount(account: AccountRecord): Promise<void> {
    this.upsertAccountStmt.run(
      account.username,
      nullable(account.displayName),
      nullable(account.tenantId),
      account.addedAt.getTime(),
    );
  }

  async listAccounts(): Promise<readonly AccountRecord[]> {
    const rows = this.listAccountsStmt.all() as AccountRow[];
    return rows.map((r) => ({
      username: r.username,
      ...(r.display_name !== null && { displayName: r.display_name }),
      ...(r.tenant_id !== null && { tenantId: r.tenant_id }),
      addedAt: new Date(r.added_at),
    }));
  }

  async searchMessages(
    query: string,
    limit: number,
  ): Promise<readonly SearchHit[]> {
    const phrase = toFts5Phrase(query);
    if (phrase === null) return [];
    const rows = this.searchStmt.all(phrase, limit) as (MessageRow & {
      snippet: string;
      rank: number;
    })[];
    return rows.map((r) => ({
      message: fromRow(r),
      snippet: r.snippet,
      rank: r.rank,
    }));
  }
}

function toFts5Phrase(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function fromRow(r: MessageRow): Message {
  return {
    id: r.id,
    source: r.source as MessageSource,
    account: r.account,
    nativeId: r.native_id,
    ...(r.thread_id !== null && { threadId: r.thread_id }),
    ...(r.thread_name !== null && { threadName: r.thread_name }),
    ...(r.sender_name !== null && { senderName: r.sender_name }),
    ...(r.sender_email !== null && { senderEmail: r.sender_email }),
    sentAt: new Date(r.sent_at),
    importedAt: new Date(r.imported_at),
    ...(r.is_read !== null && { isRead: r.is_read === 1 }),
    ...(r.body !== null && { body: r.body }),
    ...(r.body_html !== null && { bodyHtml: r.body_html }),
    ...(r.raw_json !== null && { rawJson: r.raw_json }),
  };
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
