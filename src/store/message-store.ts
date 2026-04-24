import type {
  AccountRecord,
  ChatCursorEntry,
  Message,
  MessageSource,
  SearchHit,
  SyncLogEntry,
  SyncStateEntry,
  SyncStatusRow,
  ThreadSummary,
} from "./types.js";

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

export interface GetThreadOptions {
  readonly threadId: string;
  readonly limit?: number;
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
}
