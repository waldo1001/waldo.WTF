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
} from "../store/message-store.js";
import {
  buildSteeringPredicate,
  type SteeringPredicate,
} from "../store/steering-filter.js";
import type { SteeringStore } from "../store/steering-store.js";
import type {
  AccountRecord,
  CalendarEvent,
  ChatCursorEntry,
  EventKey,
  Message,
  MessageSource,
  SearchHit,
  SyncLogEntry,
  SyncLogSource,
  SyncStateEntry,
  SyncStatusRow,
  ThreadSummary,
  Transcript,
  TranscriptKey,
  TranscriptSearchHit,
  TranscriptStatus,
} from "../store/types.js";

export type InMemoryMessageStoreCall =
  | { method: "upsertMessages"; messages: readonly Message[] }
  | { method: "deleteMessages"; ids: readonly string[] }
  | { method: "getSyncState"; account: string; source: MessageSource }
  | { method: "setSyncState"; entry: SyncStateEntry }
  | { method: "appendSyncLog"; entry: SyncLogEntry }
  | { method: "upsertAccount"; account: AccountRecord }
  | { method: "listAccounts" }
  | {
      method: "searchMessages";
      query: string;
      limit: number;
      opts?: SearchMessagesOptions;
    }
  | { method: "searchTranscriptSegments"; query: string; limit: number }
  | { method: "getRecentMessages"; opts: GetRecentMessagesOptions }
  | { method: "getThread"; opts: GetThreadOptions }
  | {
      method: "listThreadSummaries";
      opts: ListThreadSummariesOptions;
    }
  | { method: "getSyncStatus"; now: Date }
  | { method: "getChatCursor"; account: string; chatId: string }
  | { method: "setChatCursor"; entry: ChatCursorEntry }
  | { method: "listChatCursors"; account: string }
  | { method: "upsertEvents"; events: readonly CalendarEvent[] }
  | { method: "deleteEvents"; keys: readonly EventKey[] }
  | {
      method: "getEventsInRange";
      account: string;
      from: Date;
      to: Date;
    }
  | { method: "getEventByKey"; key: EventKey }
  | { method: "findEvents"; opts: FindEventsOptions }
  | { method: "upsertTranscript"; input: UpsertTranscriptInput }
  | { method: "getTranscriptByKey"; key: TranscriptKey }
  | { method: "listTranscriptsForEvent"; account: string; eventId: string }
  | {
      method: "markTranscriptStatus";
      key: TranscriptKey;
      status: TranscriptStatus;
      fetchedAt: Date;
    };

export interface InMemoryMessageStoreOptions {
  seed?: {
    messages?: readonly Message[];
    syncState?: readonly SyncStateEntry[];
    accounts?: readonly AccountRecord[];
  };
  steeringStore?: SteeringStore;
}

const syncKey = (
  account: string,
  source: SyncLogSource,
  folder: string,
): string => `${account}::${source}::${folder}`;

const eventKey = (account: string, eventId: string): string =>
  `${account}::${eventId}`;

const transcriptKey = (
  account: string,
  eventId: string,
  transcriptId: string,
): string => `${account}::${eventId}::${transcriptId}`;

export class InMemoryMessageStore implements MessageStore {
  readonly calls: InMemoryMessageStoreCall[] = [];
  readonly syncLog: SyncLogEntry[] = [];
  private readonly messages = new Map<string, Message>();
  private readonly syncState = new Map<string, SyncStateEntry>();
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly chatCursors = new Map<string, ChatCursorEntry>();
  private readonly events = new Map<string, CalendarEvent>();
  private readonly transcripts = new Map<string, TranscriptWithSegments>();
  private readonly steeringStore: SteeringStore | undefined;

  constructor(opts: InMemoryMessageStoreOptions = {}) {
    for (const m of opts.seed?.messages ?? []) {
      this.messages.set(m.id, m);
    }
    for (const s of opts.seed?.syncState ?? []) {
      this.syncState.set(syncKey(s.account, s.source, s.folder ?? ""), s);
    }
    for (const a of opts.seed?.accounts ?? []) {
      this.accounts.set(a.username, a);
    }
    this.steeringStore = opts.steeringStore;
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

  async upsertMessages(messages: readonly Message[]): Promise<UpsertResult> {
    this.calls.push({ method: "upsertMessages", messages });
    let added = 0;
    let updated = 0;
    for (const m of messages) {
      if (this.messages.has(m.id)) updated++;
      else added++;
      this.messages.set(m.id, m);
    }
    return { added, updated };
  }

  async deleteMessages(ids: readonly string[]): Promise<DeleteResult> {
    this.calls.push({ method: "deleteMessages", ids });
    let deleted = 0;
    for (const id of ids) {
      if (this.messages.delete(id)) deleted++;
    }
    return { deleted };
  }

  async getSyncState(
    account: string,
    source: MessageSource,
    folder?: string,
  ): Promise<SyncStateEntry | null> {
    this.calls.push({ method: "getSyncState", account, source });
    return this.syncState.get(syncKey(account, source, folder ?? "")) ?? null;
  }

  async setSyncState(entry: SyncStateEntry): Promise<void> {
    this.calls.push({ method: "setSyncState", entry });
    this.syncState.set(
      syncKey(entry.account, entry.source, entry.folder ?? ""),
      entry,
    );
  }

  async appendSyncLog(entry: SyncLogEntry): Promise<void> {
    this.calls.push({ method: "appendSyncLog", entry });
    this.syncLog.push(entry);
  }

  async upsertAccount(account: AccountRecord): Promise<void> {
    this.calls.push({ method: "upsertAccount", account });
    this.accounts.set(account.username, account);
  }

  async listAccounts(): Promise<readonly AccountRecord[]> {
    this.calls.push({ method: "listAccounts" });
    return [...this.accounts.values()].sort((a, b) => {
      const t = a.addedAt.getTime() - b.addedAt.getTime();
      return t !== 0 ? t : a.username.localeCompare(b.username);
    });
  }

  async searchMessages(
    query: string,
    limit: number,
    opts?: SearchMessagesOptions,
  ): Promise<SearchMessagesResult> {
    this.calls.push({
      method: "searchMessages",
      query,
      limit,
      ...(opts !== undefined && { opts }),
    });
    const needle = query.trim().toLowerCase();
    const hasQuery = needle !== "";
    const senderEmailNeedle = opts?.senderEmail?.toLowerCase();
    const senderNameNeedle = opts?.senderName?.toLowerCase();
    const afterMs = opts?.after?.getTime();
    const beforeMs = opts?.before?.getTime();
    const hasStructuredFilter =
      senderEmailNeedle !== undefined ||
      senderNameNeedle !== undefined ||
      afterMs !== undefined ||
      beforeMs !== undefined;
    if (!hasQuery && !hasStructuredFilter) {
      return { hits: [], mutedCount: 0 };
    }
    const predicate = await this.loadPredicate(opts?.includeMuted);
    const hits: SearchHit[] = [];
    let mutedCount = 0;
    for (const m of this.messages.values()) {
      if (hasQuery) {
        const haystack =
          `${m.body ?? ""}\n${m.threadName ?? ""}\n${m.senderName ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      if (senderEmailNeedle !== undefined) {
        if ((m.senderEmail ?? "").toLowerCase() !== senderEmailNeedle) continue;
      }
      if (senderNameNeedle !== undefined) {
        if (!(m.senderName ?? "").toLowerCase().includes(senderNameNeedle))
          continue;
      }
      if (afterMs !== undefined && m.sentAt.getTime() < afterMs) continue;
      if (beforeMs !== undefined && m.sentAt.getTime() >= beforeMs) continue;
      if (predicate.matches(m)) {
        mutedCount++;
        continue;
      }
      hits.push({
        message: m,
        snippet: m.body ?? "",
        rank: hasQuery ? 0 : -m.sentAt.getTime(),
      });
    }
    hits.sort((a, b) => {
      if (hasQuery) return a.rank - b.rank;
      return b.message.sentAt.getTime() - a.message.sentAt.getTime();
    });
    return { hits: hits.slice(0, limit), mutedCount };
  }

  async searchTranscriptSegments(
    query: string,
    limit: number,
  ): Promise<SearchTranscriptSegmentsResult> {
    this.calls.push({ method: "searchTranscriptSegments", query, limit });
    const needle = query.trim().toLowerCase();
    if (needle === "") return { hits: [] };
    const hits: TranscriptSearchHit[] = [];
    for (const { segments } of this.transcripts.values()) {
      for (const s of segments) {
        if (!s.text.toLowerCase().includes(needle)) continue;
        hits.push({ segment: s, snippet: s.text, rank: 0 });
      }
    }
    return { hits: hits.slice(0, limit) };
  }

  async getSyncLogRecent(limit: number): Promise<readonly SyncLogEntry[]> {
    if (limit <= 0) return [];
    const sorted = this.syncLog
      .map((entry, idx) => ({ entry, idx }))
      .sort((a, b) => {
        const t = b.entry.ts.getTime() - a.entry.ts.getTime();
        if (t !== 0) return t;
        return b.idx - a.idx;
      });
    return sorted.slice(0, limit).map((x) => x.entry);
  }

  async getSyncStatus(now: Date): Promise<readonly SyncStatusRow[]> {
    this.calls.push({ method: "getSyncStatus", now });
    const pairs = new Map<string, { account: string; source: SyncLogSource }>();
    const pairKey = (account: string, source: SyncLogSource): string =>
      `${account}::${source}`;
    for (const s of this.syncState.values()) {
      pairs.set(pairKey(s.account, s.source), {
        account: s.account,
        source: s.source,
      });
    }
    for (const entry of this.syncLog) {
      pairs.set(pairKey(entry.account, entry.source), {
        account: entry.account,
        source: entry.source,
      });
    }
    const since24h = now.getTime() - 24 * 3600 * 1000;
    const rows: SyncStatusRow[] = [];
    for (const { account, source } of pairs.values()) {
      const state = this.syncState.get(syncKey(account, source, ""));
      const logs = this.syncLog
        .filter((e) => e.account === account && e.source === source)
        .slice()
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());
      const latest = logs.length > 0 ? logs[logs.length - 1] : undefined;
      const latestOk = [...logs].reverse().find((e) => e.status === "ok");
      let sum = 0;
      for (const e of logs) {
        if (e.status !== "ok") continue;
        if (e.ts.getTime() < since24h) continue;
        sum += e.messagesAdded ?? 0;
      }
      const row: SyncStatusRow = {
        account,
        source,
        ...(state?.lastSyncAt !== undefined && { lastSyncAt: state.lastSyncAt }),
        ...(latestOk?.ts !== undefined && { lastOkAt: latestOk.ts }),
        ...(latest !== undefined && { lastStatus: latest.status }),
        ...(latest?.status === "error" &&
          latest.errorMessage !== undefined && { lastError: latest.errorMessage }),
        ...(latestOk?.messagesAdded !== undefined && {
          messagesAddedLastOk: latestOk.messagesAdded,
        }),
        messagesAddedLast24h: sum,
      };
      rows.push(row);
    }
    rows.sort((a, b) => {
      const c = a.account.localeCompare(b.account);
      return c !== 0 ? c : a.source.localeCompare(b.source);
    });
    return rows;
  }

  async getChatCursor(
    account: string,
    chatId: string,
  ): Promise<string | undefined> {
    this.calls.push({ method: "getChatCursor", account, chatId });
    return this.chatCursors.get(`${account}::${chatId}`)?.cursor;
  }

  async setChatCursor(entry: ChatCursorEntry): Promise<void> {
    this.calls.push({ method: "setChatCursor", entry });
    this.chatCursors.set(`${entry.account}::${entry.chatId}`, entry);
  }

  async listChatCursors(
    account: string,
  ): Promise<readonly ChatCursorEntry[]> {
    this.calls.push({ method: "listChatCursors", account });
    return [...this.chatCursors.values()]
      .filter((c) => c.account === account)
      .sort((a, b) => a.chatId.localeCompare(b.chatId));
  }

  async getThread(opts: GetThreadOptions): Promise<readonly Message[]> {
    this.calls.push({ method: "getThread", opts });
    const limit = opts.limit ?? DEFAULT_GET_THREAD_LIMIT;
    const rows: Message[] = [];
    for (const m of this.messages.values()) {
      if (m.threadId === opts.threadId) rows.push(m);
    }
    rows.sort((a, b) => {
      const t = a.sentAt.getTime() - b.sentAt.getTime();
      return t !== 0 ? t : a.id.localeCompare(b.id);
    });
    if (opts.fromStart === true) {
      return rows.slice(0, limit);
    }
    return rows.slice(Math.max(0, rows.length - limit));
  }

  async listThreadSummaries(
    opts: ListThreadSummariesOptions,
  ): Promise<readonly ThreadSummary[]> {
    this.calls.push({ method: "listThreadSummaries", opts });
    const groups = new Map<
      string,
      {
        threadId: string;
        messages: Message[];
      }
    >();
    for (const m of this.messages.values()) {
      if (m.source !== opts.source) continue;
      if (m.threadId === undefined) continue;
      const g = groups.get(m.threadId);
      if (g === undefined) {
        groups.set(m.threadId, { threadId: m.threadId, messages: [m] });
      } else {
        g.messages.push(m);
      }
    }
    const out: ThreadSummary[] = [];
    for (const g of groups.values()) {
      const sorted = g.messages
        .slice()
        .sort((a, b) => {
          const t = b.sentAt.getTime() - a.sentAt.getTime();
          if (t !== 0) return t;
          return b.id.localeCompare(a.id);
        });
      const latest = sorted[0]!;
      const oldest = sorted[sorted.length - 1]!;
      out.push({
        source: opts.source,
        threadId: g.threadId,
        ...(latest.threadName !== undefined && {
          threadName: latest.threadName,
        }),
        messageCount: sorted.length,
        newestSentAt: latest.sentAt,
        oldestSentAt: oldest.sentAt,
      });
    }
    out.sort((a, b) => b.newestSentAt.getTime() - a.newestSentAt.getTime());
    return out;
  }

  async getRecentMessages(
    opts: GetRecentMessagesOptions,
  ): Promise<GetRecentMessagesResult> {
    this.calls.push({ method: "getRecentMessages", opts });
    const sinceMs = opts.since.getTime();
    const sources =
      opts.sources && opts.sources.length > 0 ? new Set(opts.sources) : null;
    const accounts =
      opts.accounts && opts.accounts.length > 0 ? new Set(opts.accounts) : null;
    const predicate = await this.loadPredicate(opts.includeMuted);
    const rows: Message[] = [];
    let mutedCount = 0;
    for (const m of this.messages.values()) {
      if (m.sentAt.getTime() < sinceMs) continue;
      if (sources !== null && !sources.has(m.source)) continue;
      if (accounts !== null && !accounts.has(m.account)) continue;
      if (predicate.matches(m)) {
        mutedCount++;
        continue;
      }
      rows.push(m);
    }
    rows.sort((a, b) => {
      const t = b.sentAt.getTime() - a.sentAt.getTime();
      if (t !== 0) return t;
      return b.id.localeCompare(a.id);
    });
    return { messages: rows.slice(0, opts.limit), mutedCount };
  }

  async upsertEvents(events: readonly CalendarEvent[]): Promise<void> {
    this.calls.push({ method: "upsertEvents", events });
    for (const e of events) {
      const attendees = e.attendees.map((a) => ({
        ...a,
        email: a.email.toLowerCase(),
      }));
      this.events.set(eventKey(e.account, e.eventId), { ...e, attendees });
    }
  }

  async deleteEvents(keys: readonly EventKey[]): Promise<void> {
    this.calls.push({ method: "deleteEvents", keys });
    for (const k of keys) {
      this.events.delete(eventKey(k.account, k.eventId));
    }
  }

  async getEventsInRange(
    account: string,
    from: Date,
    to: Date,
  ): Promise<readonly CalendarEvent[]> {
    this.calls.push({ method: "getEventsInRange", account, from, to });
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const rows = [...this.events.values()].filter(
      (e) =>
        e.account === account &&
        e.startAt.getTime() <= toMs &&
        e.endAt.getTime() >= fromMs,
    );
    rows.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    return rows;
  }

  async getEventByKey(key: EventKey): Promise<CalendarEvent | null> {
    this.calls.push({ method: "getEventByKey", key });
    return this.events.get(eventKey(key.account, key.eventId)) ?? null;
  }

  async findEvents(opts: FindEventsOptions): Promise<FindEventsResult> {
    this.calls.push({ method: "findEvents", opts });
    const fromMs = opts.from.getTime();
    const toMs = opts.to.getTime();
    const accountsSet =
      opts.accounts && opts.accounts.length > 0 ? new Set(opts.accounts) : null;
    const subjectNeedle = opts.subjectContains?.toLowerCase();
    const attendeeNeedle = opts.attendee?.toLowerCase();

    const rows = [...this.events.values()].filter((e) => {
      if (accountsSet !== null && !accountsSet.has(e.account)) return false;
      if (e.startAt.getTime() > toMs || e.endAt.getTime() < fromMs) return false;
      if (
        subjectNeedle !== undefined &&
        !(e.subject ?? "").toLowerCase().includes(subjectNeedle)
      ) {
        return false;
      }
      if (attendeeNeedle !== undefined) {
        const organizerMatch =
          (e.organizerName ?? "").toLowerCase().includes(attendeeNeedle) ||
          (e.organizerEmail ?? "").toLowerCase().includes(attendeeNeedle);
        const attendeeMatch = e.attendees.some(
          (a) =>
            (a.displayName ?? "").toLowerCase().includes(attendeeNeedle) ||
            a.email.toLowerCase().includes(attendeeNeedle),
        );
        if (!organizerMatch && !attendeeMatch) return false;
      }
      return true;
    });

    const predicate = await this.loadEventPredicate(opts.includeMuted);
    let mutedCount = 0;
    const visible = rows.filter((e) => {
      if (predicate.matches(e)) {
        mutedCount++;
        return false;
      }
      return true;
    });

    visible.sort((a, b) => {
      const diff = a.startAt.getTime() - b.startAt.getTime();
      return opts.order === "desc" ? -diff : diff;
    });

    const truncated = visible.length > opts.limit;
    return { events: visible.slice(0, opts.limit), truncated, mutedCount };
  }

  async getRecentItems(
    opts: GetRecentItemsOptions,
  ): Promise<GetRecentItemsResult> {
    return composeRecentItems(this, opts);
  }

  async upsertTranscript(input: UpsertTranscriptInput): Promise<void> {
    this.calls.push({ method: "upsertTranscript", input });
    const { transcript, segments } = input;
    this.transcripts.set(
      transcriptKey(transcript.account, transcript.eventId, transcript.transcriptId),
      { transcript, segments: [...segments].sort((a, b) => a.sequence - b.sequence) },
    );
  }

  async getTranscriptByKey(
    key: TranscriptKey,
  ): Promise<TranscriptWithSegments | null> {
    this.calls.push({ method: "getTranscriptByKey", key });
    return (
      this.transcripts.get(
        transcriptKey(key.account, key.eventId, key.transcriptId),
      ) ?? null
    );
  }

  async listTranscriptsForEvent(
    account: string,
    eventId: string,
  ): Promise<readonly Transcript[]> {
    this.calls.push({ method: "listTranscriptsForEvent", account, eventId });
    const rows = [...this.transcripts.values()]
      .filter(
        (t) => t.transcript.account === account && t.transcript.eventId === eventId,
      )
      .map((t) => t.transcript);
    rows.sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime());
    return rows;
  }

  async markTranscriptStatus(
    key: TranscriptKey,
    status: TranscriptStatus,
    fetchedAt: Date,
  ): Promise<void> {
    this.calls.push({ method: "markTranscriptStatus", key, status, fetchedAt });
    const k = transcriptKey(key.account, key.eventId, key.transcriptId);
    const existing = this.transcripts.get(k);
    if (existing !== undefined) {
      this.transcripts.set(k, {
        transcript: { ...existing.transcript, status, fetchedAt },
        segments: existing.segments,
      });
      return;
    }
    // No existing row for this key — insert a status-only marker so a
    // retry-cooldown policy (a later slice) has something to key off of
    // without a real transcript ever existing, mirroring SqliteMessageStore.
    this.transcripts.set(k, {
      transcript: {
        account: key.account,
        eventId: key.eventId,
        transcriptId: key.transcriptId,
        fetchedAt,
        segmentCount: 0,
        status,
      },
      segments: [],
    });
  }
}
