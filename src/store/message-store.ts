import type {
  AccountRecord,
  Message,
  MessageSource,
  SyncLogEntry,
  SyncStateEntry,
} from "./types.js";

export interface UpsertResult {
  readonly added: number;
  readonly updated: number;
}

export interface DeleteResult {
  readonly deleted: number;
}

export interface MessageStore {
  upsertMessages(messages: readonly Message[]): Promise<UpsertResult>;
  deleteMessages(ids: readonly string[]): Promise<DeleteResult>;
  getSyncState(
    account: string,
    source: MessageSource,
  ): Promise<SyncStateEntry | null>;
  setSyncState(entry: SyncStateEntry): Promise<void>;
  appendSyncLog(entry: SyncLogEntry): Promise<void>;
  upsertAccount(account: AccountRecord): Promise<void>;
  listAccounts(): Promise<readonly AccountRecord[]>;
}
