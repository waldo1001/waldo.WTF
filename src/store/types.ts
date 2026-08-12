export type MessageSource =
  | "teams"
  | "teams-channel"
  | "outlook"
  | "whatsapp"
  | "viva-engage"
  | "calendar";

// sync_state/sync_log also track sources that never produce Message rows
// (calendar events and transcripts live in their own tables) — this widens
// just the sync-bookkeeping surface rather than MessageSource itself, so
// callers of Message.source can't accidentally match on "transcripts".
export type SyncLogSource = MessageSource | "transcripts";

export type ChatType = "oneOnOne" | "group" | "channel";

export interface Message {
  readonly id: string;
  readonly source: MessageSource;
  readonly account: string;
  readonly nativeId: string;
  readonly threadId?: string;
  readonly threadName?: string;
  readonly senderName?: string;
  readonly senderEmail?: string;
  readonly sentAt: Date;
  readonly importedAt: Date;
  readonly isRead?: boolean;
  readonly body?: string;
  readonly bodyHtml?: string;
  readonly rawJson?: string;
  readonly chatType?: ChatType;
  readonly replyToId?: string;
  readonly mentions?: readonly string[];
  readonly fromMe?: boolean;
}

export interface SyncStateEntry {
  readonly account: string;
  readonly source: MessageSource;
  readonly folder?: string;
  readonly deltaToken?: string;
  readonly lastSyncAt?: Date;
}

export type SyncLogStatus = "ok" | "error";

export interface SyncLogEntry {
  readonly ts: Date;
  readonly account: string;
  readonly source: SyncLogSource;
  readonly status: SyncLogStatus;
  readonly messagesAdded?: number;
  readonly errorMessage?: string;
}

export interface SyncStatusRow {
  readonly account: string;
  readonly source: SyncLogSource;
  readonly lastSyncAt?: Date;
  readonly lastOkAt?: Date;
  readonly lastStatus?: SyncLogStatus;
  readonly lastError?: string;
  readonly messagesAddedLastOk?: number;
  readonly messagesAddedLast24h: number;
}

export interface ChatCursorEntry {
  readonly account: string;
  readonly chatId: string;
  readonly cursor: string;
}

export interface ThreadSummary {
  readonly source: MessageSource;
  readonly threadId: string;
  readonly threadName?: string;
  readonly messageCount: number;
  readonly newestSentAt: Date;
  readonly oldestSentAt: Date;
}

export interface AccountRecord {
  readonly username: string;
  readonly displayName?: string;
  readonly tenantId?: string;
  readonly addedAt: Date;
}

export interface SearchHit {
  readonly message: Message;
  readonly snippet: string;
  // bm25(messages_fts): lower score = better match (FTS5 convention).
  readonly rank: number;
}

export interface TranscriptSearchHit {
  readonly segment: TranscriptSegment;
  readonly snippet: string;
  // bm25(transcript_segments_fts): lower score = better match.
  readonly rank: number;
}

export const STEERING_RULE_TYPES = [
  "sender_email",
  "sender_domain",
  "thread_id",
  "thread_name_contains",
  "body_contains",
  "event_organizer_email",
  "event_subject_contains",
] as const;

export type SteeringRuleType = (typeof STEERING_RULE_TYPES)[number];

export interface RuleScope {
  readonly source?: MessageSource;
  readonly account?: string;
}

export interface SteeringRule {
  readonly id: number;
  readonly ruleType: SteeringRuleType;
  readonly pattern: string;
  readonly source?: MessageSource;
  readonly account?: string;
  readonly reason?: string;
  readonly enabled: boolean;
  readonly createdAt: Date;
}

export interface AddSteeringRuleInput {
  readonly ruleType: SteeringRuleType;
  readonly pattern: string;
  readonly source?: MessageSource;
  readonly account?: string;
  readonly reason?: string;
}

export interface VivaSubscription {
  readonly account: string;
  readonly tenantId?: string;
  readonly networkId: string;
  readonly networkName?: string;
  readonly communityId: string;
  readonly communityName?: string;
  readonly enabled: boolean;
  readonly subscribedAt: Date;
  readonly lastCursorAt?: Date;
}

export interface AddVivaSubscriptionInput {
  readonly account: string;
  readonly tenantId?: string;
  readonly networkId: string;
  readonly networkName?: string;
  readonly communityId: string;
  readonly communityName?: string;
}

export interface TeamsChannelSubscription {
  readonly account: string;
  readonly tenantId?: string;
  readonly teamId: string;
  readonly teamName?: string;
  readonly channelId: string;
  readonly channelName?: string;
  readonly enabled: boolean;
  readonly subscribedAt: Date;
  readonly lastCursorAt?: Date;
}

export interface AddTeamsChannelSubscriptionInput {
  readonly account: string;
  readonly tenantId?: string;
  readonly teamId: string;
  readonly teamName?: string;
  readonly channelId: string;
  readonly channelName?: string;
}

export const EVENT_RESPONSE_STATUSES = [
  "none",
  "accepted",
  "tentative",
  "declined",
  "notResponded",
  "organizer",
] as const;

export type EventResponseStatus = (typeof EVENT_RESPONSE_STATUSES)[number];

export interface EventAttendee {
  readonly email: string;
  readonly displayName?: string;
  readonly responseStatus: EventResponseStatus;
  readonly isOrganizer?: boolean;
}

export interface CalendarEvent {
  readonly account: string;
  readonly eventId: string;
  readonly tenantId?: string;
  readonly subject?: string;
  readonly organizerName?: string;
  readonly organizerEmail?: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly isAllDay: boolean;
  readonly isCancelled: boolean;
  readonly chatId?: string;
  readonly onlineMeetingUrl?: string;
  readonly onlineMeetingId?: string;
  readonly lastModifiedAt?: Date;
  readonly rawJson?: string;
  readonly attendees: readonly EventAttendee[];
}

export interface EventKey {
  readonly account: string;
  readonly eventId: string;
}

export interface CalendarAccount {
  readonly account: string;
  readonly tenantId?: string;
  readonly transcriptsEnabled: boolean;
  readonly enabledAt: Date;
}

export interface EnableCalendarAccountInput {
  readonly account: string;
  readonly tenantId?: string;
}

export type TranscriptStatus =
  | "ok"
  | "not-available"
  | "quota-exhausted"
  | "fetch-failed";

export interface Transcript {
  readonly account: string;
  readonly eventId: string;
  readonly transcriptId: string;
  readonly fetchedAt: Date;
  readonly vttBytes?: number;
  readonly segmentCount: number;
  readonly status: TranscriptStatus;
  readonly rawJson?: string;
}

export interface TranscriptSegment {
  readonly account: string;
  readonly eventId: string;
  readonly transcriptId: string;
  readonly sequence: number;
  readonly speakerEmail?: string;
  readonly speakerDisplayName?: string;
  readonly startOffsetMs: number;
  readonly endOffsetMs: number;
  readonly text: string;
}

export interface TranscriptKey {
  readonly account: string;
  readonly eventId: string;
  readonly transcriptId: string;
}

export type StoreErrorKind = "not-found" | "conflict" | "corrupt";

export class StoreError extends Error {
  constructor(
    readonly kind: StoreErrorKind,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(message ?? kind, options);
    this.name = "StoreError";
  }
}
