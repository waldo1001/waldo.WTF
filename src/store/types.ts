export type MessageSource = "teams" | "outlook" | "whatsapp" | "viva-engage";

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
  readonly source: MessageSource;
  readonly status: SyncLogStatus;
  readonly messagesAdded?: number;
  readonly errorMessage?: string;
}

export interface SyncStatusRow {
  readonly account: string;
  readonly source: MessageSource;
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

export const STEERING_RULE_TYPES = [
  "sender_email",
  "sender_domain",
  "thread_id",
  "thread_name_contains",
  "body_contains",
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
