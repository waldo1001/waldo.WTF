import type {
  DeleteResult,
  MessageStore,
  UpsertResult,
} from "../store/message-store.js";
import type {
  AccountRecord,
  Message,
  MessageSource,
  SyncLogEntry,
  SyncStateEntry,
} from "../store/types.js";

export type InMemoryMessageStoreCall =
  | { method: "upsertMessages"; messages: readonly Message[] }
  | { method: "deleteMessages"; ids: readonly string[] }
  | { method: "getSyncState"; account: string; source: MessageSource }
  | { method: "setSyncState"; entry: SyncStateEntry }
  | { method: "appendSyncLog"; entry: SyncLogEntry }
  | { method: "upsertAccount"; account: AccountRecord }
  | { method: "listAccounts" };

export interface InMemoryMessageStoreOptions {
  seed?: {
    messages?: readonly Message[];
    syncState?: readonly SyncStateEntry[];
    accounts?: readonly AccountRecord[];
  };
}

const syncKey = (account: string, source: MessageSource): string =>
  `${account}::${source}`;

export class InMemoryMessageStore implements MessageStore {
  readonly calls: InMemoryMessageStoreCall[] = [];
  readonly syncLog: SyncLogEntry[] = [];
  private readonly messages = new Map<string, Message>();
  private readonly syncState = new Map<string, SyncStateEntry>();
  private readonly accounts = new Map<string, AccountRecord>();

  constructor(opts: InMemoryMessageStoreOptions = {}) {
    for (const m of opts.seed?.messages ?? []) {
      this.messages.set(m.id, m);
    }
    for (const s of opts.seed?.syncState ?? []) {
      this.syncState.set(syncKey(s.account, s.source), s);
    }
    for (const a of opts.seed?.accounts ?? []) {
      this.accounts.set(a.username, a);
    }
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
  ): Promise<SyncStateEntry | null> {
    this.calls.push({ method: "getSyncState", account, source });
    return this.syncState.get(syncKey(account, source)) ?? null;
  }

  async setSyncState(entry: SyncStateEntry): Promise<void> {
    this.calls.push({ method: "setSyncState", entry });
    this.syncState.set(syncKey(entry.account, entry.source), entry);
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
}
