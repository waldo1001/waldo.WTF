import type { Database, Statement } from "better-sqlite3";
import type {
  DeleteResult,
  GetRecentMessagesOptions,
  MessageStore,
  UpsertResult,
} from "./message-store.js";
import { applyMigrations } from "./schema.js";
import type {
  AccountRecord,
  ChatCursorEntry,
  ChatType,
  Message,
  MessageSource,
  SearchHit,
  SyncLogEntry,
  SyncStateEntry,
  SyncStatusRow,
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
  chat_type: string | null;
  reply_to_id: string | null;
  mentions_json: string | null;
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
  private readonly getChatCursorStmt: Statement<[string, string]>;
  private readonly setChatCursorStmt: Statement<[string, string, string]>;
  private readonly listChatCursorsStmt: Statement<[string]>;

  constructor(private readonly db: Database) {
    applyMigrations(db);

    this.existsStmt = db.prepare("SELECT 1 FROM messages WHERE id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO messages (
        id, source, account, native_id,
        thread_id, thread_name, sender_name, sender_email,
        sent_at, imported_at, is_read, body, body_html, raw_json,
        chat_type, reply_to_id, mentions_json
      ) VALUES (
        @id, @source, @account, @native_id,
        @thread_id, @thread_name, @sender_name, @sender_email,
        @sent_at, @imported_at, @is_read, @body, @body_html, @raw_json,
        @chat_type, @reply_to_id, @mentions_json
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
        raw_json = excluded.raw_json,
        chat_type = excluded.chat_type,
        reply_to_id = excluded.reply_to_id,
        mentions_json = excluded.mentions_json
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
             m.chat_type, m.reply_to_id, m.mentions_json,
             snippet(messages_fts, 0, '[', ']', '…', 16) AS snippet,
             bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this.getChatCursorStmt = db.prepare(
      "SELECT cursor FROM chat_cursors WHERE account = ? AND chat_id = ?",
    );
    this.setChatCursorStmt = db.prepare(`
      INSERT INTO chat_cursors (account, chat_id, cursor)
      VALUES (?, ?, ?)
      ON CONFLICT(account, chat_id) DO UPDATE SET
        cursor = excluded.cursor
    `);
    this.listChatCursorsStmt = db.prepare(
      "SELECT account, chat_id, cursor FROM chat_cursors WHERE account = ? ORDER BY chat_id ASC",
    );
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

  async getChatCursor(
    account: string,
    chatId: string,
  ): Promise<string | undefined> {
    const row = this.getChatCursorStmt.get(account, chatId) as
      | { cursor: string }
      | undefined;
    return row?.cursor;
  }

  async setChatCursor(entry: ChatCursorEntry): Promise<void> {
    this.setChatCursorStmt.run(entry.account, entry.chatId, entry.cursor);
  }

  async listChatCursors(
    account: string,
  ): Promise<readonly ChatCursorEntry[]> {
    const rows = this.listChatCursorsStmt.all(account) as {
      account: string;
      chat_id: string;
      cursor: string;
    }[];
    return rows.map((r) => ({
      account: r.account,
      chatId: r.chat_id,
      cursor: r.cursor,
    }));
  }

  async getRecentMessages(
    opts: GetRecentMessagesOptions,
  ): Promise<readonly Message[]> {
    const clauses: string[] = ["sent_at >= ?"];
    const params: (string | number)[] = [opts.since.getTime()];
    if (opts.sources && opts.sources.length > 0) {
      clauses.push(
        `source IN (${opts.sources.map(() => "?").join(", ")})`,
      );
      params.push(...opts.sources);
    }
    if (opts.accounts && opts.accounts.length > 0) {
      clauses.push(
        `account IN (${opts.accounts.map(() => "?").join(", ")})`,
      );
      params.push(...opts.accounts);
    }
    params.push(opts.limit);
    const sql = `
      SELECT id, source, account, native_id,
             thread_id, thread_name, sender_name, sender_email,
             sent_at, imported_at, is_read, body, body_html, raw_json,
             chat_type, reply_to_id, mentions_json
      FROM messages
      WHERE ${clauses.join(" AND ")}
      ORDER BY sent_at DESC, id DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params) as MessageRow[];
    return rows.map(fromRow);
  }

  async getSyncStatus(now: Date): Promise<readonly SyncStatusRow[]> {
    const since24h = now.getTime() - 24 * 3600 * 1000;
    const rows = this.db
      .prepare(
        `
      WITH pairs AS (
        SELECT account, source FROM sync_state
        UNION
        SELECT account, source FROM sync_log
      )
      SELECT
        p.account AS account,
        p.source AS source,
        (SELECT last_sync_at FROM sync_state
           WHERE account = p.account AND source = p.source) AS last_sync_at,
        (SELECT ts FROM sync_log
           WHERE account = p.account AND source = p.source AND status = 'ok'
           ORDER BY ts DESC LIMIT 1) AS last_ok_at,
        (SELECT messages_added FROM sync_log
           WHERE account = p.account AND source = p.source AND status = 'ok'
           ORDER BY ts DESC LIMIT 1) AS messages_added_last_ok,
        (SELECT status FROM sync_log
           WHERE account = p.account AND source = p.source
           ORDER BY ts DESC LIMIT 1) AS last_status,
        (SELECT error_message FROM sync_log
           WHERE account = p.account AND source = p.source
           ORDER BY ts DESC LIMIT 1) AS last_error_message,
        COALESCE((SELECT SUM(messages_added) FROM sync_log
           WHERE account = p.account AND source = p.source
             AND status = 'ok' AND ts >= ?), 0) AS messages_added_last_24h
      FROM pairs p
      ORDER BY account ASC, source ASC
    `,
      )
      .all(since24h) as {
      account: string;
      source: string;
      last_sync_at: number | null;
      last_ok_at: number | null;
      messages_added_last_ok: number | null;
      last_status: string | null;
      last_error_message: string | null;
      messages_added_last_24h: number | null;
    }[];
    return rows.map((r) => {
      const status = r.last_status as "ok" | "error" | null;
      const row: SyncStatusRow = {
        account: r.account,
        source: r.source as MessageSource,
        ...(r.last_sync_at !== null && { lastSyncAt: new Date(r.last_sync_at) }),
        ...(r.last_ok_at !== null && { lastOkAt: new Date(r.last_ok_at) }),
        ...(status !== null && { lastStatus: status }),
        ...(status === "error" &&
          r.last_error_message !== null && { lastError: r.last_error_message }),
        ...(r.messages_added_last_ok !== null && {
          messagesAddedLastOk: r.messages_added_last_ok,
        }),
        messagesAddedLast24h: r.messages_added_last_24h ?? 0,
      };
      return row;
    });
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

function parseMentions(raw: string | null): readonly string[] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
      return parsed as readonly string[];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function fromRow(r: MessageRow): Message {
  const mentions = parseMentions(r.mentions_json);
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
    ...(r.chat_type !== null && { chatType: r.chat_type as ChatType }),
    ...(r.reply_to_id !== null && { replyToId: r.reply_to_id }),
    ...(mentions !== undefined && { mentions }),
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
    chat_type: nullable(m.chatType),
    reply_to_id: nullable(m.replyToId),
    mentions_json: m.mentions === undefined ? null : JSON.stringify(m.mentions),
  };
}
