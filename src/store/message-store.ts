import type { Message, MessageSource, SyncStateEntry } from "./types.js";

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
}
