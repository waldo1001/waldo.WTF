export type MessageSource = "teams" | "outlook" | "whatsapp";

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
}

export interface SyncStateEntry {
  readonly account: string;
  readonly source: MessageSource;
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
