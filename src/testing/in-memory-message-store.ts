import type {
  DeleteResult,
  GetRecentMessagesOptions,
  MessageStore,
  UpsertResult,
} from "../store/message-store.js";
import type {
  AccountRecord,
  Message,
  MessageSource,
  SearchHit,
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
  | { method: "listAccounts" }
  | { method: "searchMessages"; query: string; limit: number }
  | { method: "getRecentMessages"; opts: GetRecentMessagesOptions };

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

  async searchMessages(
    query: string,
    limit: number,
  ): Promise<readonly SearchHit[]> {
    this.calls.push({ method: "searchMessages", query, limit });
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    const hits: SearchHit[] = [];
    for (const m of this.messages.values()) {
      const haystack = `${m.body ?? ""}\n${m.threadName ?? ""}\n${m.senderName ?? ""}`.toLowerCase();
      if (haystack.includes(needle)) {
        hits.push({ message: m, snippet: m.body ?? "", rank: 0 });
      }
    }
    hits.sort((a, b) => b.message.sentAt.getTime() - a.message.sentAt.getTime());
    return hits.slice(0, limit);
  }

  async getRecentMessages(
    opts: GetRecentMessagesOptions,
  ): Promise<readonly Message[]> {
    this.calls.push({ method: "getRecentMessages", opts });
    const sinceMs = opts.since.getTime();
    const sources =
      opts.sources && opts.sources.length > 0 ? new Set(opts.sources) : null;
    const accounts =
      opts.accounts && opts.accounts.length > 0 ? new Set(opts.accounts) : null;
    const rows: Message[] = [];
    for (const m of this.messages.values()) {
      if (m.sentAt.getTime() < sinceMs) continue;
      if (sources !== null && !sources.has(m.source)) continue;
      if (accounts !== null && !accounts.has(m.account)) continue;
      rows.push(m);
    }
    rows.sort((a, b) => {
      const t = b.sentAt.getTime() - a.sentAt.getTime();
      if (t !== 0) return t;
      return b.id.localeCompare(a.id);
    });
    return rows.slice(0, opts.limit);
  }
}
