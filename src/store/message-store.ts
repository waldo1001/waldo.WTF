import type {
  AccountRecord,
  CalendarEvent,
  ChatCursorEntry,
  EventKey,
  Message,
  MessageSource,
  SearchHit,
  SyncLogEntry,
  SyncStateEntry,
  SyncStatusRow,
  ThreadSummary,
  Transcript,
  TranscriptKey,
  TranscriptSearchHit,
  TranscriptSegment,
  TranscriptStatus,
} from "./types.js";

export interface FindEventsOptions {
  readonly from: Date;
  readonly to: Date;
  readonly accounts?: readonly string[];
  readonly subjectContains?: string;
  readonly attendee?: string;
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly includeMuted?: boolean;
}

export interface UpsertTranscriptInput {
  readonly transcript: Transcript;
  readonly segments: readonly TranscriptSegment[];
}

export interface TranscriptWithSegments {
  readonly transcript: Transcript;
  readonly segments: readonly TranscriptSegment[];
}

export interface FindEventsResult {
  readonly events: readonly CalendarEvent[];
  readonly truncated: boolean;
  readonly mutedCount: number;
}

export type ActivityKind = "message" | "event";

export type RecentItem =
  | { readonly kind: "message"; readonly at: Date; readonly message: Message }
  | {
      readonly kind: "event";
      readonly at: Date;
      readonly event: CalendarEvent;
    };

export interface GetRecentItemsOptions {
  readonly from: Date;
  readonly to: Date;
  readonly kinds: readonly ActivityKind[];
  readonly sources?: readonly MessageSource[];
  readonly accounts?: readonly string[];
  readonly includeMuted?: boolean;
}

export interface GetRecentItemsResult {
  readonly items: readonly RecentItem[];
  readonly mutedCount: number;
}

// Every individual sub-fetch (messages, events) is capped at this many
// candidates before merging — large enough that, combined with
// RECENT_ITEMS_CAP, the final "most recent N overall" selection is always
// correct even in a worst-case window that's all-messages or all-events.
const RECENT_ITEMS_FETCH_CAP = 500;
export const RECENT_ITEMS_CAP = 500;

// `combined` below is always built as [...messages, ...events], and
// Array.prototype.sort is spec-guaranteed stable (ES2019+), so ties
// (same `at`) naturally keep messages before events — matching this
// tool's historical (messages-only) ordering — with no explicit
// kind-tiebreak needed here.
function compareByAtThenKind(a: RecentItem, b: RecentItem): number {
  return a.at.getTime() - b.at.getTime();
}

// Shared by every MessageStore implementation — composes the existing
// getRecentMessages + findEvents methods rather than a raw SQL UNION,
// because messages.sent_at (INTEGER ms) and events.start_at (TEXT ISO)
// use genuinely different storage representations; merging in JS after
// two well-understood, already-tested queries is simpler and more
// correct than reconciling that mismatch inside SQL.
export async function composeRecentItems(
  store: Pick<MessageStore, "getRecentMessages" | "findEvents">,
  opts: GetRecentItemsOptions,
): Promise<GetRecentItemsResult> {
  let messages: readonly Message[] = [];
  let mutedCount = 0;
  if (opts.kinds.includes("message")) {
    const r = await store.getRecentMessages({
      since: opts.from,
      ...(opts.sources !== undefined && { sources: opts.sources }),
      ...(opts.accounts !== undefined && { accounts: opts.accounts }),
      limit: RECENT_ITEMS_FETCH_CAP,
      ...(opts.includeMuted !== undefined && {
        includeMuted: opts.includeMuted,
      }),
    });
    messages = r.messages;
    mutedCount = r.mutedCount;
  }

  let events: readonly CalendarEvent[] = [];
  if (opts.kinds.includes("event")) {
    const r = await store.findEvents({
      from: opts.from,
      to: opts.to,
      ...(opts.accounts !== undefined && { accounts: opts.accounts }),
      order: "desc",
      limit: RECENT_ITEMS_FETCH_CAP,
      ...(opts.includeMuted !== undefined && {
        includeMuted: opts.includeMuted,
      }),
    });
    events = r.events;
    mutedCount += r.mutedCount;
  }

  const combined: RecentItem[] = [
    ...messages.map((message) => ({
      kind: "message" as const,
      at: message.sentAt,
      message,
    })),
    ...events.map((event) => ({
      kind: "event" as const,
      at: event.startAt,
      event,
    })),
  ];
  // Select the most-recent RECENT_ITEMS_CAP by sorting descending first...
  combined.sort((a, b) => -compareByAtThenKind(a, b));
  const capped =
    combined.length > RECENT_ITEMS_CAP
      ? combined.slice(0, RECENT_ITEMS_CAP)
      : combined;
  // ...then re-sort ascending for the final chronological feed.
  capped.sort(compareByAtThenKind);

  return { items: capped, mutedCount };
}

export interface UpsertResult {
  readonly added: number;
  readonly updated: number;
}

export interface DeleteResult {
  readonly deleted: number;
}

export interface GetRecentMessagesOptions {
  readonly since: Date;
  readonly sources?: readonly MessageSource[];
  readonly accounts?: readonly string[];
  readonly limit: number;
  readonly includeMuted?: boolean;
}

export interface GetRecentMessagesResult {
  readonly messages: readonly Message[];
  readonly mutedCount: number;
}

export interface SearchMessagesOptions {
  readonly includeMuted?: boolean;
  readonly senderEmail?: string;
  readonly senderName?: string;
  readonly after?: Date;
  readonly before?: Date;
}

export interface SearchMessagesResult {
  readonly hits: readonly SearchHit[];
  readonly mutedCount: number;
}

export interface SearchTranscriptSegmentsResult {
  readonly hits: readonly TranscriptSearchHit[];
}

export interface GetThreadOptions {
  readonly threadId: string;
  readonly limit?: number;
  // Default false → return the LATEST `limit` messages of the thread,
  // sorted chronologically (asc) within the returned slice.
  // True → return the FIRST `limit` messages, oldest-first (the original
  // start of the conversation). Use only when the caller explicitly
  // wants the beginning of a long thread.
  readonly fromStart?: boolean;
}

export interface ListThreadSummariesOptions {
  readonly source: MessageSource;
}

export const DEFAULT_GET_THREAD_LIMIT = 200;
export const MAX_GET_THREAD_LIMIT = 500;

export interface MessageStore {
  upsertMessages(messages: readonly Message[]): Promise<UpsertResult>;
  deleteMessages(ids: readonly string[]): Promise<DeleteResult>;
  getSyncState(
    account: string,
    source: MessageSource,
    folder?: string,
  ): Promise<SyncStateEntry | null>;
  setSyncState(entry: SyncStateEntry): Promise<void>;
  appendSyncLog(entry: SyncLogEntry): Promise<void>;
  upsertAccount(account: AccountRecord): Promise<void>;
  listAccounts(): Promise<readonly AccountRecord[]>;
  searchMessages(
    query: string,
    limit: number,
    opts?: SearchMessagesOptions,
  ): Promise<SearchMessagesResult>;
  // No steering: transcripts attach to events, which already have their
  // own steering predicates — no separate carve-out needed (mirrors
  // get_event/get_event_transcript's existing no-steering stance).
  searchTranscriptSegments(
    query: string,
    limit: number,
  ): Promise<SearchTranscriptSegmentsResult>;
  getRecentMessages(
    opts: GetRecentMessagesOptions,
  ): Promise<GetRecentMessagesResult>;
  getThread(opts: GetThreadOptions): Promise<readonly Message[]>;
  listThreadSummaries(
    opts: ListThreadSummariesOptions,
  ): Promise<readonly ThreadSummary[]>;
  getSyncStatus(now: Date): Promise<readonly SyncStatusRow[]>;
  getSyncLogRecent(limit: number): Promise<readonly SyncLogEntry[]>;
  getChatCursor(
    account: string,
    chatId: string,
  ): Promise<string | undefined>;
  setChatCursor(entry: ChatCursorEntry): Promise<void>;
  listChatCursors(account: string): Promise<readonly ChatCursorEntry[]>;
  upsertEvents(events: readonly CalendarEvent[]): Promise<void>;
  deleteEvents(keys: readonly EventKey[]): Promise<void>;
  getEventsInRange(
    account: string,
    from: Date,
    to: Date,
  ): Promise<readonly CalendarEvent[]>;
  getEventByKey(key: EventKey): Promise<CalendarEvent | null>;
  findEvents(opts: FindEventsOptions): Promise<FindEventsResult>;
  getRecentItems(opts: GetRecentItemsOptions): Promise<GetRecentItemsResult>;
  upsertTranscript(input: UpsertTranscriptInput): Promise<void>;
  getTranscriptByKey(key: TranscriptKey): Promise<TranscriptWithSegments | null>;
  listTranscriptsForEvent(
    account: string,
    eventId: string,
  ): Promise<readonly Transcript[]>;
  markTranscriptStatus(
    key: TranscriptKey,
    status: TranscriptStatus,
    fetchedAt: Date,
  ): Promise<void>;
}
