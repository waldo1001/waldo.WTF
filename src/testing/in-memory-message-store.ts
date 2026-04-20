import {
  DEFAULT_GET_THREAD_LIMIT,
  type DeleteResult,
  type GetRecentMessagesOptions,
  type GetRecentMessagesResult,
  type GetThreadOptions,
  type MessageStore,
  type SearchMessagesOptions,
  type SearchMessagesResult,
  type UpsertResult,
} from "../store/message-store.js";
import { buildSteeringPredicate } from "../store/steering-filter.js";
import type { SteeringStore } from "../store/steering-store.js";
import type {
  AccountRecord,
  ChatCursorEntry,
  Message,
  MessageSource,
  SearchHit,
  SyncLogEntry,
  SyncStateEntry,
  SyncStatusRow,
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
  | { method: "getRecentMessages"; opts: GetRecentMessagesOptions }
  | { method: "getThread"; opts: GetThreadOptions }
  | { method: "getSyncStatus"; now: Date }
  | { method: "getChatCursor"; account: string; chatId: string }
  | { method: "setChatCursor"; entry: ChatCursorEntry }
  | { method: "listChatCursors"; account: string };

export interface InMemoryMessageStoreOptions {
  seed?: {
    messages?: readonly Message[];
    syncState?: readonly SyncStateEntry[];
    accounts?: readonly AccountRecord[];
  };
  steeringStore?: SteeringStore;
}

const syncKey = (account: string, source: MessageSource): string =>
  `${account}::${source}`;

export class InMemoryMessageStore implements MessageStore {
  readonly calls: InMemoryMessageStoreCall[] = [];
  readonly syncLog: SyncLogEntry[] = [];
  private readonly messages = new Map<string, Message>();
  private readonly syncState = new Map<string, SyncStateEntry>();
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly chatCursors = new Map<string, ChatCursorEntry>();
  private readonly steeringStore: SteeringStore | undefined;

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
    this.steeringStore = opts.steeringStore;
  }

  private async loadPredicate(
    includeMuted: boolean | undefined,
  ): Promise<ReturnType<typeof buildSteeringPredicate>> {
    if (includeMuted === true || this.steeringStore === undefined) {
      return buildSteeringPredicate([]);
    }
    const rules = await this.steeringStore.listRules();
    return buildSteeringPredicate(rules);
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

  async getSyncStatus(now: Date): Promise<readonly SyncStatusRow[]> {
    this.calls.push({ method: "getSyncStatus", now });
    const pairs = new Map<string, { account: string; source: MessageSource }>();
    for (const s of this.syncState.values()) {
      pairs.set(syncKey(s.account, s.source), {
        account: s.account,
        source: s.source,
      });
    }
    for (const entry of this.syncLog) {
      pairs.set(syncKey(entry.account, entry.source), {
        account: entry.account,
        source: entry.source,
      });
    }
    const since24h = now.getTime() - 24 * 3600 * 1000;
    const rows: SyncStatusRow[] = [];
    for (const { account, source } of pairs.values()) {
      const state = this.syncState.get(syncKey(account, source));
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
    return rows.slice(0, limit);
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
}
