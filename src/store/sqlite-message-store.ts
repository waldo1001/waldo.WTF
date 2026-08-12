import type { Database, Statement } from "better-sqlite3";
import {
  composeRecentItems,
  DEFAULT_GET_THREAD_LIMIT,
  type DeleteResult,
  type FindEventsOptions,
  type FindEventsResult,
  type GetRecentItemsOptions,
  type GetRecentItemsResult,
  type GetRecentMessagesOptions,
  type GetRecentMessagesResult,
  type GetThreadOptions,
  type ListThreadSummariesOptions,
  type MessageStore,
  type SearchMessagesOptions,
  type SearchMessagesResult,
  type SearchTranscriptSegmentsResult,
  type TranscriptWithSegments,
  type UpsertResult,
  type UpsertTranscriptInput,
} from "./message-store.js";
import { escapeLikePattern } from "./like-pattern.js";
import { applyMigrations } from "./schema.js";
import {
  buildSteeringPredicate,
  type SteeringPredicate,
} from "./steering-filter.js";
import type { SteeringStore } from "./steering-store.js";
import type {
  AccountRecord,
  CalendarEvent,
  ChatCursorEntry,
  ChatType,
  EventAttendee,
  EventKey,
  EventResponseStatus,
  Message,
  MessageSource,
  SyncLogEntry,
  SyncLogSource,
  SyncStateEntry,
  SyncStatusRow,
  ThreadSummary,
  Transcript,
  TranscriptKey,
  TranscriptSegment,
  TranscriptStatus,
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
  from_me: number;
}

interface SyncStateRow {
  account: string;
  source: string;
  folder: string;
  delta_token: string | null;
  last_sync_at: number | null;
}

interface AccountRow {
  username: string;
  display_name: string | null;
  tenant_id: string | null;
  added_at: number;
}

interface EventRow {
  account: string;
  event_id: string;
  tenant_id: string | null;
  subject: string | null;
  organizer_name: string | null;
  organizer_email: string | null;
  start_at: string;
  end_at: string;
  is_all_day: number;
  is_cancelled: number;
  chat_id: string | null;
  online_meeting_url: string | null;
  online_meeting_id: string | null;
  last_modified_at: string | null;
  raw_json: string | null;
}

interface EventAttendeeRow {
  account: string;
  event_id: string;
  attendee_email: string;
  display_name: string | null;
  response_status: string;
  is_organizer: number;
}

interface TranscriptRow {
  account: string;
  event_id: string;
  transcript_id: string;
  fetched_at: string;
  vtt_bytes: number | null;
  segment_count: number;
  status: string;
  raw_json: string | null;
}

interface TranscriptSegmentRow {
  account: string;
  event_id: string;
  transcript_id: string;
  sequence: number;
  speaker_email: string | null;
  speaker_display_name: string | null;
  start_offset_ms: number;
  end_offset_ms: number;
  text: string;
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
  private readonly getSyncStmt: Statement<[string, string, string]>;
  private readonly setSyncStmt: Statement<
    [string, string, string, string | null, number | null]
  >;
  private readonly appendSyncLogStmt: Statement<
    [number, string, string, string, number | null, string | null]
  >;
  private readonly upsertAccountStmt: Statement<
    [string, string | null, string | null, number]
  >;
  private readonly listAccountsStmt: Statement<[]>;
  private readonly getChatCursorStmt: Statement<[string, string]>;
  private readonly setChatCursorStmt: Statement<[string, string, string]>;
  private readonly listChatCursorsStmt: Statement<[string]>;
  private readonly upsertEventStmt: Statement<EventRow>;
  private readonly deleteEventStmt: Statement<[string, string]>;
  private readonly deleteAttendeesForEventStmt: Statement<[string, string]>;
  private readonly insertAttendeeStmt: Statement<EventAttendeeRow>;
  private readonly getEventsInRangeStmt: Statement<[string, string, string]>;
  private readonly getAttendeesForEventStmt: Statement<[string, string]>;
  private readonly getEventByKeyStmt: Statement<[string, string]>;

  constructor(
    private readonly db: Database,
    private readonly steeringStore?: SteeringStore,
  ) {
    applyMigrations(db);

    this.existsStmt = db.prepare("SELECT 1 FROM messages WHERE id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO messages (
        id, source, account, native_id,
        thread_id, thread_name, sender_name, sender_email,
        sent_at, imported_at, is_read, body, body_html, raw_json,
        chat_type, reply_to_id, mentions_json, from_me
      ) VALUES (
        @id, @source, @account, @native_id,
        @thread_id, @thread_name, @sender_name, @sender_email,
        @sent_at, @imported_at, @is_read, @body, @body_html, @raw_json,
        @chat_type, @reply_to_id, @mentions_json, @from_me
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
        mentions_json = excluded.mentions_json,
        from_me = excluded.from_me
    `);
    this.deleteStmt = db.prepare("DELETE FROM messages WHERE id = ?");
    this.getSyncStmt = db.prepare(
      "SELECT account, source, folder, delta_token, last_sync_at FROM sync_state WHERE account = ? AND source = ? AND folder = ?",
    );
    this.setSyncStmt = db.prepare(`
      INSERT INTO sync_state (account, source, folder, delta_token, last_sync_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account, source, folder) DO UPDATE SET
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
    this.upsertEventStmt = db.prepare(`
      INSERT INTO events (
        account, event_id, tenant_id, subject, organizer_name, organizer_email,
        start_at, end_at, is_all_day, is_cancelled,
        chat_id, online_meeting_url, online_meeting_id, last_modified_at, raw_json
      ) VALUES (
        @account, @event_id, @tenant_id, @subject, @organizer_name, @organizer_email,
        @start_at, @end_at, @is_all_day, @is_cancelled,
        @chat_id, @online_meeting_url, @online_meeting_id, @last_modified_at, @raw_json
      )
      ON CONFLICT(account, event_id) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        subject = excluded.subject,
        organizer_name = excluded.organizer_name,
        organizer_email = excluded.organizer_email,
        start_at = excluded.start_at,
        end_at = excluded.end_at,
        is_all_day = excluded.is_all_day,
        is_cancelled = excluded.is_cancelled,
        chat_id = excluded.chat_id,
        online_meeting_url = excluded.online_meeting_url,
        online_meeting_id = excluded.online_meeting_id,
        last_modified_at = excluded.last_modified_at,
        raw_json = excluded.raw_json
    `);
    this.deleteEventStmt = db.prepare(
      "DELETE FROM events WHERE account = ? AND event_id = ?",
    );
    this.deleteAttendeesForEventStmt = db.prepare(
      "DELETE FROM event_attendees WHERE account = ? AND event_id = ?",
    );
    this.insertAttendeeStmt = db.prepare(`
      INSERT INTO event_attendees (
        account, event_id, attendee_email, display_name, response_status, is_organizer
      ) VALUES (
        @account, @event_id, @attendee_email, @display_name, @response_status, @is_organizer
      )
    `);
    this.getEventsInRangeStmt = db.prepare(`
      SELECT account, event_id, tenant_id, subject, organizer_name, organizer_email,
             start_at, end_at, is_all_day, is_cancelled,
             chat_id, online_meeting_url, online_meeting_id, last_modified_at, raw_json
      FROM events
      WHERE account = ? AND start_at <= ? AND end_at >= ?
      ORDER BY start_at ASC
    `);
    this.getAttendeesForEventStmt = db.prepare(`
      SELECT account, event_id, attendee_email, display_name, response_status, is_organizer
      FROM event_attendees
      WHERE account = ? AND event_id = ?
      ORDER BY attendee_email ASC
    `);
    this.getEventByKeyStmt = db.prepare(`
      SELECT account, event_id, tenant_id, subject, organizer_name, organizer_email,
             start_at, end_at, is_all_day, is_cancelled,
             chat_id, online_meeting_url, online_meeting_id, last_modified_at, raw_json
      FROM events
      WHERE account = ? AND event_id = ?
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

  async upsertEvents(events: readonly CalendarEvent[]): Promise<void> {
    if (events.length === 0) return;

    const run = this.db.transaction((rows: readonly CalendarEvent[]) => {
      for (const e of rows) {
        this.upsertEventStmt.run(eventToRow(e));
        this.deleteAttendeesForEventStmt.run(e.account, e.eventId);
        for (const a of e.attendees) {
          this.insertAttendeeStmt.run(attendeeToRow(e.account, e.eventId, a));
        }
      }
    });

    run(events);
  }

  async deleteEvents(keys: readonly EventKey[]): Promise<void> {
    if (keys.length === 0) return;

    // Deletes attendees explicitly rather than relying on the
    // event_attendees FK's ON DELETE CASCADE — not every caller opens the
    // database with `PRAGMA foreign_keys = ON` (see openDatabase.ts), so
    // cascade can't be trusted to fire in every context this store runs in.
    const run = this.db.transaction((rows: readonly EventKey[]) => {
      for (const k of rows) {
        this.deleteAttendeesForEventStmt.run(k.account, k.eventId);
        this.deleteEventStmt.run(k.account, k.eventId);
      }
    });

    run(keys);
  }

  async getEventsInRange(
    account: string,
    from: Date,
    to: Date,
  ): Promise<readonly CalendarEvent[]> {
    const rows = this.getEventsInRangeStmt.all(
      account,
      to.toISOString(),
      from.toISOString(),
    ) as EventRow[];
    return rows.map((r) => this.eventRowToCalendarEvent(r));
  }

  async getEventByKey(key: EventKey): Promise<CalendarEvent | null> {
    const row = this.getEventByKeyStmt.get(key.account, key.eventId) as
      | EventRow
      | undefined;
    return row === undefined ? null : this.eventRowToCalendarEvent(row);
  }

  async findEvents(opts: FindEventsOptions): Promise<FindEventsResult> {
    const clauses: string[] = ["e.start_at <= ?", "e.end_at >= ?"];
    const params: (string | number)[] = [
      opts.to.toISOString(),
      opts.from.toISOString(),
    ];
    if (opts.accounts !== undefined && opts.accounts.length > 0) {
      clauses.push(`e.account IN (${opts.accounts.map(() => "?").join(", ")})`);
      params.push(...opts.accounts);
    }
    if (opts.subjectContains !== undefined) {
      clauses.push("e.subject LIKE ? ESCAPE '\\' COLLATE NOCASE");
      params.push(`%${escapeLikePattern(opts.subjectContains)}%`);
    }
    if (opts.attendee !== undefined) {
      const pattern = `%${escapeLikePattern(opts.attendee)}%`;
      clauses.push(`(
        e.organizer_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR e.organizer_email LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR EXISTS (
          SELECT 1 FROM event_attendees ea
          WHERE ea.account = e.account AND ea.event_id = e.event_id
            AND (ea.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR ea.attendee_email LIKE ? ESCAPE '\\' COLLATE NOCASE)
        )
      )`);
      params.push(pattern, pattern, pattern, pattern);
    }
    const order = opts.order === "desc" ? "DESC" : "ASC";

    const predicate = await this.loadEventPredicate(opts.includeMuted);
    let mutedCount = 0;
    if (predicate.sqlFragment !== null) {
      const countSql = `
        SELECT COUNT(*) AS n FROM events e
        WHERE ${clauses.join(" AND ")} AND ${predicate.sqlFragment}
      `;
      const countRow = this.db
        .prepare(countSql)
        .get(...params, ...predicate.params) as { n: number };
      mutedCount = countRow.n;
    }

    const dataClauses = [...clauses];
    const dataParams = [...params];
    if (predicate.sqlFragment !== null) {
      dataClauses.push(`NOT ${predicate.sqlFragment}`);
      dataParams.push(...predicate.params);
    }
    dataParams.push(opts.limit + 1);

    const sql = `
      SELECT e.account, e.event_id, e.tenant_id, e.subject, e.organizer_name, e.organizer_email,
             e.start_at, e.end_at, e.is_all_day, e.is_cancelled,
             e.chat_id, e.online_meeting_url, e.online_meeting_id, e.last_modified_at, e.raw_json
      FROM events e
      WHERE ${dataClauses.join(" AND ")}
      ORDER BY e.start_at ${order}
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...dataParams) as EventRow[];
    const truncated = rows.length > opts.limit;
    const sliced = truncated ? rows.slice(0, opts.limit) : rows;
    return {
      events: sliced.map((r) => this.eventRowToCalendarEvent(r)),
      truncated,
      mutedCount,
    };
  }

  async getRecentItems(
    opts: GetRecentItemsOptions,
  ): Promise<GetRecentItemsResult> {
    return composeRecentItems(this, opts);
  }

  async upsertTranscript(input: UpsertTranscriptInput): Promise<void> {
    const { transcript: t, segments } = input;
    const insertSegmentStmt = this.db.prepare(`
      INSERT INTO transcript_segments (
        account, event_id, transcript_id, sequence,
        speaker_email, speaker_display_name, start_offset_ms, end_offset_ms, text
      ) VALUES (
        @account, @event_id, @transcript_id, @sequence,
        @speaker_email, @speaker_display_name, @start_offset_ms, @end_offset_ms, @text
      )
    `);
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO transcripts (
          account, event_id, transcript_id, fetched_at, vtt_bytes, segment_count, status, raw_json
        ) VALUES (
          @account, @event_id, @transcript_id, @fetched_at, @vtt_bytes, @segment_count, @status, @raw_json
        )
        ON CONFLICT (account, event_id, transcript_id) DO UPDATE SET
          fetched_at = excluded.fetched_at,
          vtt_bytes = excluded.vtt_bytes,
          segment_count = excluded.segment_count,
          status = excluded.status,
          raw_json = excluded.raw_json
      `,
        )
        .run(transcriptToRow(t));
      this.db
        .prepare(
          "DELETE FROM transcript_segments WHERE account = ? AND event_id = ? AND transcript_id = ?",
        )
        .run(t.account, t.eventId, t.transcriptId);
      for (const s of segments) {
        insertSegmentStmt.run(segmentToRow(s));
      }
    });
    run();
  }

  async getTranscriptByKey(
    key: TranscriptKey,
  ): Promise<TranscriptWithSegments | null> {
    const row = this.db
      .prepare(
        `SELECT account, event_id, transcript_id, fetched_at, vtt_bytes, segment_count, status, raw_json
         FROM transcripts WHERE account = ? AND event_id = ? AND transcript_id = ?`,
      )
      .get(key.account, key.eventId, key.transcriptId) as
      | TranscriptRow
      | undefined;
    if (row === undefined) return null;
    const segmentRows = this.db
      .prepare(
        `SELECT account, event_id, transcript_id, sequence,
                speaker_email, speaker_display_name, start_offset_ms, end_offset_ms, text
         FROM transcript_segments
         WHERE account = ? AND event_id = ? AND transcript_id = ?
         ORDER BY sequence ASC`,
      )
      .all(key.account, key.eventId, key.transcriptId) as TranscriptSegmentRow[];
    return {
      transcript: transcriptRowToTranscript(row),
      segments: segmentRows.map(segmentRowToTranscriptSegment),
    };
  }

  async listTranscriptsForEvent(
    account: string,
    eventId: string,
  ): Promise<readonly Transcript[]> {
    const rows = this.db
      .prepare(
        `SELECT account, event_id, transcript_id, fetched_at, vtt_bytes, segment_count, status, raw_json
         FROM transcripts WHERE account = ? AND event_id = ?
         ORDER BY fetched_at ASC`,
      )
      .all(account, eventId) as TranscriptRow[];
    return rows.map(transcriptRowToTranscript);
  }

  async markTranscriptStatus(
    key: TranscriptKey,
    status: TranscriptStatus,
    fetchedAt: Date,
  ): Promise<void> {
    const fetchedAtIso = fetchedAt.toISOString();
    const result = this.db
      .prepare(
        `UPDATE transcripts SET status = ?, fetched_at = ?
         WHERE account = ? AND event_id = ? AND transcript_id = ?`,
      )
      .run(status, fetchedAtIso, key.account, key.eventId, key.transcriptId);
    if (result.changes > 0) return;
    // No existing row for this key (e.g. the first check for a meeting that
    // turned out to have no transcript at all) — insert a status-only
    // marker row so the retry-cooldown policy (a later slice) has
    // something to key off of without a real transcript ever existing.
    this.db
      .prepare(
        `INSERT INTO transcripts (
           account, event_id, transcript_id, fetched_at, vtt_bytes, segment_count, status, raw_json
         ) VALUES (?, ?, ?, ?, NULL, 0, ?, NULL)`,
      )
      .run(key.account, key.eventId, key.transcriptId, fetchedAtIso, status);
  }

  private eventRowToCalendarEvent(row: EventRow): CalendarEvent {
    const attendeeRows = this.getAttendeesForEventStmt.all(
      row.account,
      row.event_id,
    ) as EventAttendeeRow[];
    return {
      account: row.account,
      eventId: row.event_id,
      ...(row.tenant_id !== null && { tenantId: row.tenant_id }),
      ...(row.subject !== null && { subject: row.subject }),
      ...(row.organizer_name !== null && { organizerName: row.organizer_name }),
      ...(row.organizer_email !== null && {
        organizerEmail: row.organizer_email,
      }),
      startAt: new Date(row.start_at),
      endAt: new Date(row.end_at),
      isAllDay: row.is_all_day === 1,
      isCancelled: row.is_cancelled === 1,
      ...(row.chat_id !== null && { chatId: row.chat_id }),
      ...(row.online_meeting_url !== null && {
        onlineMeetingUrl: row.online_meeting_url,
      }),
      ...(row.online_meeting_id !== null && {
        onlineMeetingId: row.online_meeting_id,
      }),
      ...(row.last_modified_at !== null && {
        lastModifiedAt: new Date(row.last_modified_at),
      }),
      ...(row.raw_json !== null && { rawJson: row.raw_json }),
      attendees: attendeeRows.map(attendeeRowToEventAttendee),
    };
  }

  async getSyncState(
    account: string,
    source: MessageSource,
    folder?: string,
  ): Promise<SyncStateEntry | null> {
    const row = this.getSyncStmt.get(account, source, folder ?? "") as
      | SyncStateRow
      | undefined;
    if (row === undefined) return null;
    const entry: SyncStateEntry = {
      account: row.account,
      source: row.source as MessageSource,
      ...(row.folder !== "" && { folder: row.folder }),
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
      entry.folder ?? "",
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

  async getThread(opts: GetThreadOptions): Promise<readonly Message[]> {
    const limit = opts.limit ?? DEFAULT_GET_THREAD_LIMIT;
    const sql =
      opts.fromStart === true
        ? `
      SELECT id, source, account, native_id,
             thread_id, thread_name, sender_name, sender_email,
             sent_at, imported_at, is_read, body, body_html, raw_json,
             chat_type, reply_to_id, mentions_json, from_me
      FROM messages
      WHERE thread_id = ?
      ORDER BY sent_at ASC, id ASC
      LIMIT ?
    `
        : `
      SELECT id, source, account, native_id,
             thread_id, thread_name, sender_name, sender_email,
             sent_at, imported_at, is_read, body, body_html, raw_json,
             chat_type, reply_to_id, mentions_json, from_me
      FROM (
        SELECT *
        FROM messages
        WHERE thread_id = ?
        ORDER BY sent_at DESC, id DESC
        LIMIT ?
      )
      ORDER BY sent_at ASC, id ASC
    `;
    const rows = this.db
      .prepare(sql)
      .all(opts.threadId, limit) as MessageRow[];
    return rows.map(fromRow);
  }

  async listThreadSummaries(
    opts: ListThreadSummariesOptions,
  ): Promise<readonly ThreadSummary[]> {
    const rows = this.db
      .prepare(
        `
      SELECT
        thread_id AS threadId,
        COUNT(*) AS messageCount,
        MAX(sent_at) AS newestSentAt,
        MIN(sent_at) AS oldestSentAt,
        (SELECT thread_name FROM messages m2
           WHERE m2.source = m1.source AND m2.thread_id = m1.thread_id
           ORDER BY m2.sent_at DESC, m2.id DESC
           LIMIT 1) AS threadName
      FROM messages m1
      WHERE source = ? AND thread_id IS NOT NULL
      GROUP BY thread_id
      ORDER BY newestSentAt DESC
    `,
      )
      .all(opts.source) as {
      threadId: string;
      messageCount: number;
      newestSentAt: number;
      oldestSentAt: number;
      threadName: string | null;
    }[];
    return rows.map((r) => ({
      source: opts.source,
      threadId: r.threadId,
      ...(r.threadName !== null && { threadName: r.threadName }),
      messageCount: r.messageCount,
      newestSentAt: new Date(r.newestSentAt),
      oldestSentAt: new Date(r.oldestSentAt),
    }));
  }

  async getRecentMessages(
    opts: GetRecentMessagesOptions,
  ): Promise<GetRecentMessagesResult> {
    const baseClauses: string[] = ["m.sent_at >= ?"];
    const baseParams: (string | number)[] = [opts.since.getTime()];
    if (opts.sources && opts.sources.length > 0) {
      baseClauses.push(
        `m.source IN (${opts.sources.map(() => "?").join(", ")})`,
      );
      baseParams.push(...opts.sources);
    }
    if (opts.accounts && opts.accounts.length > 0) {
      baseClauses.push(
        `m.account IN (${opts.accounts.map(() => "?").join(", ")})`,
      );
      baseParams.push(...opts.accounts);
    }

    const predicate = await this.loadPredicate(opts.includeMuted);

    let mutedCount = 0;
    if (predicate.sqlFragment !== null) {
      const countSql = `
        SELECT COUNT(*) AS n FROM messages m
        WHERE ${baseClauses.join(" AND ")} AND ${predicate.sqlFragment}
      `;
      const countRow = this.db
        .prepare(countSql)
        .get(...baseParams, ...predicate.params) as { n: number };
      mutedCount = countRow.n;
    }

    const dataClauses = [...baseClauses];
    const dataParams = [...baseParams];
    if (predicate.sqlFragment !== null) {
      dataClauses.push(`NOT ${predicate.sqlFragment}`);
      dataParams.push(...predicate.params);
    }
    dataParams.push(opts.limit);

    const sql = `
      SELECT m.id, m.source, m.account, m.native_id,
             m.thread_id, m.thread_name, m.sender_name, m.sender_email,
             m.sent_at, m.imported_at, m.is_read, m.body, m.body_html, m.raw_json,
             m.chat_type, m.reply_to_id, m.mentions_json, m.from_me
      FROM messages m
      WHERE ${dataClauses.join(" AND ")}
      ORDER BY m.sent_at DESC, m.id DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...dataParams) as MessageRow[];
    return { messages: rows.map(fromRow), mutedCount };
  }

  private async loadPredicate(
    includeMuted: boolean | undefined,
  ): Promise<SteeringPredicate<Message>> {
    if (includeMuted === true || this.steeringStore === undefined) {
      return buildSteeringPredicate([], "message");
    }
    const rules = await this.steeringStore.listRules();
    return buildSteeringPredicate(rules, "message");
  }

  private async loadEventPredicate(
    includeMuted: boolean | undefined,
  ): Promise<SteeringPredicate<CalendarEvent>> {
    if (includeMuted === true || this.steeringStore === undefined) {
      return buildSteeringPredicate([], "event");
    }
    const rules = await this.steeringStore.listRules();
    return buildSteeringPredicate(rules, "event");
  }

  async getSyncLogRecent(limit: number): Promise<readonly SyncLogEntry[]> {
    if (limit <= 0) return [];
    const rows = this.db
      .prepare(
        `SELECT ts, account, source, status, messages_added, error_message
         FROM sync_log
         ORDER BY ts DESC, rowid DESC
         LIMIT ?`,
      )
      .all(limit) as {
      ts: number;
      account: string;
      source: string;
      status: "ok" | "error";
      messages_added: number | null;
      error_message: string | null;
    }[];
    return rows.map((r) => ({
      ts: new Date(r.ts),
      account: r.account,
      source: r.source as SyncLogSource,
      status: r.status,
      ...(r.messages_added !== null && { messagesAdded: r.messages_added }),
      ...(r.error_message !== null && { errorMessage: r.error_message }),
    }));
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
           WHERE account = p.account AND source = p.source AND folder = '') AS last_sync_at,
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
        source: r.source as SyncLogSource,
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
    opts?: SearchMessagesOptions,
  ): Promise<SearchMessagesResult> {
    const phrase = toFts5Phrase(query);
    const filters = buildStructuredFilterSql(opts);
    if (phrase === null && !filters.hasAny) {
      return { hits: [], mutedCount: 0 };
    }

    const predicate = await this.loadPredicate(opts?.includeMuted);
    const useFts = phrase !== null;

    const scopeClauses: string[] = [];
    const scopeParams: (string | number)[] = [];
    if (useFts) {
      scopeClauses.push("messages_fts MATCH ?");
      scopeParams.push(phrase);
    }
    scopeClauses.push(...filters.clauses);
    scopeParams.push(...filters.params);

    let mutedCount = 0;
    if (predicate.sqlFragment !== null) {
      const countSql = `
        SELECT COUNT(*) AS n
        FROM ${useFts ? "messages_fts JOIN messages m ON m.rowid = messages_fts.rowid" : "messages m"}
        WHERE ${scopeClauses.join(" AND ")} AND ${predicate.sqlFragment}
      `;
      const countRow = this.db
        .prepare(countSql)
        .get(...scopeParams, ...predicate.params) as { n: number };
      mutedCount = countRow.n;
    }

    const whereParts = [...scopeClauses];
    const sqlParams: (string | number)[] = [...scopeParams];
    if (predicate.sqlFragment !== null) {
      whereParts.push(`NOT ${predicate.sqlFragment}`);
      sqlParams.push(...predicate.params);
    }
    sqlParams.push(limit);
    const sql = useFts
      ? `
        SELECT m.id, m.source, m.account, m.native_id,
               m.thread_id, m.thread_name, m.sender_name, m.sender_email,
               m.sent_at, m.imported_at, m.is_read, m.body, m.body_html, m.raw_json,
               m.chat_type, m.reply_to_id, m.mentions_json, m.from_me,
               snippet(messages_fts, 0, '[', ']', '…', 16) AS snippet,
               bm25(messages_fts) AS rank
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        WHERE ${whereParts.join(" AND ")}
        ORDER BY rank
        LIMIT ?
      `
      : `
        SELECT m.id, m.source, m.account, m.native_id,
               m.thread_id, m.thread_name, m.sender_name, m.sender_email,
               m.sent_at, m.imported_at, m.is_read, m.body, m.body_html, m.raw_json,
               m.chat_type, m.reply_to_id, m.mentions_json, m.from_me,
               '' AS snippet,
               (-m.sent_at) AS rank
        FROM messages m
        WHERE ${whereParts.join(" AND ")}
        ORDER BY m.sent_at DESC, m.id DESC
        LIMIT ?
      `;
    const rows = this.db.prepare(sql).all(...sqlParams) as (MessageRow & {
      snippet: string;
      rank: number;
    })[];
    return {
      hits: rows.map((r) => ({
        message: fromRow(r),
        snippet: r.snippet,
        rank: r.rank,
      })),
      mutedCount,
    };
  }

  async searchTranscriptSegments(
    query: string,
    limit: number,
  ): Promise<SearchTranscriptSegmentsResult> {
    const phrase = toFts5Phrase(query);
    if (phrase === null) return { hits: [] };
    const rows = this.db
      .prepare(
        `
        SELECT s.account, s.event_id, s.transcript_id, s.sequence,
               s.speaker_email, s.speaker_display_name, s.start_offset_ms, s.end_offset_ms, s.text,
               snippet(transcript_segments_fts, 0, '[', ']', '…', 16) AS snippet,
               bm25(transcript_segments_fts) AS rank
        FROM transcript_segments_fts
        JOIN transcript_segments s ON s.rowid = transcript_segments_fts.rowid
        WHERE transcript_segments_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `,
      )
      .all(phrase, limit) as (TranscriptSegmentRow & {
      snippet: string;
      rank: number;
    })[];
    return {
      hits: rows.map((r) => ({
        segment: segmentRowToTranscriptSegment(r),
        snippet: r.snippet,
        rank: r.rank,
      })),
    };
  }
}

function buildStructuredFilterSql(
  opts: SearchMessagesOptions | undefined,
): { clauses: string[]; params: (string | number)[]; hasAny: boolean } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts?.senderEmail !== undefined) {
    clauses.push("LOWER(m.sender_email) = LOWER(?)");
    params.push(opts.senderEmail);
  }
  if (opts?.senderName !== undefined) {
    clauses.push("LOWER(m.sender_name) LIKE LOWER(?)");
    params.push(`%${opts.senderName}%`);
  }
  if (opts?.after !== undefined) {
    clauses.push("m.sent_at >= ?");
    params.push(opts.after.getTime());
  }
  if (opts?.before !== undefined) {
    clauses.push("m.sent_at < ?");
    params.push(opts.before.getTime());
  }
  return { clauses, params, hasAny: clauses.length > 0 };
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
    ...(r.from_me === 1 && { fromMe: true as const }),
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
    from_me: m.fromMe === true ? 1 : 0,
  };
}

function eventToRow(e: CalendarEvent): EventRow {
  return {
    account: e.account,
    event_id: e.eventId,
    tenant_id: nullable(e.tenantId),
    subject: nullable(e.subject),
    organizer_name: nullable(e.organizerName),
    organizer_email: nullable(e.organizerEmail),
    start_at: e.startAt.toISOString(),
    end_at: e.endAt.toISOString(),
    is_all_day: e.isAllDay ? 1 : 0,
    is_cancelled: e.isCancelled ? 1 : 0,
    chat_id: nullable(e.chatId),
    online_meeting_url: nullable(e.onlineMeetingUrl),
    online_meeting_id: nullable(e.onlineMeetingId),
    last_modified_at: e.lastModifiedAt === undefined
      ? null
      : e.lastModifiedAt.toISOString(),
    raw_json: nullable(e.rawJson),
  };
}

function attendeeToRow(
  account: string,
  eventId: string,
  a: EventAttendee,
): EventAttendeeRow {
  return {
    account,
    event_id: eventId,
    // Case-folded so the (account, event_id, attendee_email) primary key
    // is reliable even when Graph sends mixed-case addresses.
    attendee_email: a.email.toLowerCase(),
    display_name: nullable(a.displayName),
    response_status: a.responseStatus,
    is_organizer: a.isOrganizer === true ? 1 : 0,
  };
}

function attendeeRowToEventAttendee(row: EventAttendeeRow): EventAttendee {
  return {
    email: row.attendee_email,
    ...(row.display_name !== null && { displayName: row.display_name }),
    responseStatus: row.response_status as EventResponseStatus,
    ...(row.is_organizer === 1 && { isOrganizer: true as const }),
  };
}

function transcriptToRow(t: Transcript): TranscriptRow {
  return {
    account: t.account,
    event_id: t.eventId,
    transcript_id: t.transcriptId,
    fetched_at: t.fetchedAt.toISOString(),
    vtt_bytes: nullable(t.vttBytes),
    segment_count: t.segmentCount,
    status: t.status,
    raw_json: nullable(t.rawJson),
  };
}

function transcriptRowToTranscript(row: TranscriptRow): Transcript {
  return {
    account: row.account,
    eventId: row.event_id,
    transcriptId: row.transcript_id,
    fetchedAt: new Date(row.fetched_at),
    ...(row.vtt_bytes !== null && { vttBytes: row.vtt_bytes }),
    segmentCount: row.segment_count,
    status: row.status as TranscriptStatus,
    ...(row.raw_json !== null && { rawJson: row.raw_json }),
  };
}

function segmentToRow(s: TranscriptSegment): TranscriptSegmentRow {
  return {
    account: s.account,
    event_id: s.eventId,
    transcript_id: s.transcriptId,
    sequence: s.sequence,
    speaker_email: nullable(s.speakerEmail),
    speaker_display_name: nullable(s.speakerDisplayName),
    start_offset_ms: s.startOffsetMs,
    end_offset_ms: s.endOffsetMs,
    text: s.text,
  };
}

function segmentRowToTranscriptSegment(
  row: TranscriptSegmentRow,
): TranscriptSegment {
  return {
    account: row.account,
    eventId: row.event_id,
    transcriptId: row.transcript_id,
    sequence: row.sequence,
    ...(row.speaker_email !== null && { speakerEmail: row.speaker_email }),
    ...(row.speaker_display_name !== null && {
      speakerDisplayName: row.speaker_display_name,
    }),
    startOffsetMs: row.start_offset_ms,
    endOffsetMs: row.end_offset_ms,
    text: row.text,
  };
}
