import { describe, expect, it } from "vitest";
import type {
  GetRecentMessagesOptions,
  MessageStore,
} from "./message-store.js";
import type {
  AccountRecord,
  Message,
  SearchHit,
  SyncLogEntry,
  SyncStateEntry,
} from "./types.js";

async function recentIds(
  store: MessageStore,
  opts: GetRecentMessagesOptions,
): Promise<string[]> {
  const { messages } = await store.getRecentMessages(opts);
  return messages.map((m) => m.id);
}

async function recent(
  store: MessageStore,
  opts: GetRecentMessagesOptions,
): Promise<readonly Message[]> {
  const { messages } = await store.getRecentMessages(opts);
  return messages;
}

async function search(
  store: MessageStore,
  query: string,
  limit: number,
): Promise<readonly SearchHit[]> {
  const { hits } = await store.searchMessages(query, limit);
  return hits;
}

function msg(overrides: Partial<Message> & Pick<Message, "id">): Message {
  return {
    source: "outlook",
    account: "a@example.test",
    nativeId: `native-${overrides.id}`,
    sentAt: new Date("2026-04-13T10:00:00Z"),
    importedAt: new Date("2026-04-13T10:05:00Z"),
    ...overrides,
  };
}

export interface MessageStoreTestHarness {
  readonly store: MessageStore;
  readSyncLog(): readonly SyncLogEntry[];
}

export type MessageStoreFactory = () =>
  | MessageStoreTestHarness
  | Promise<MessageStoreTestHarness>;

export function runMessageStoreContract(
  label: string,
  factory: MessageStoreFactory,
): void {
  describe(`MessageStore contract (${label})`, () => {
    it("upsertMessages on an empty store adds all rows", async () => {
      const { store } = await factory();
      const result = await store.upsertMessages([
        msg({ id: "1" }),
        msg({ id: "2" }),
        msg({ id: "3" }),
      ]);
      expect(result).toEqual({ added: 3, updated: 0 });
    });

    it("upsertMessages updates an existing id in place", async () => {
      const { store } = await factory();
      await store.upsertMessages([msg({ id: "1", body: "first" })]);
      const result = await store.upsertMessages([
        msg({ id: "1", body: "second" }),
      ]);
      expect(result).toEqual({ added: 0, updated: 1 });
    });

    it("upsertMessages reports mixed added/updated counts", async () => {
      const { store } = await factory();
      await store.upsertMessages([msg({ id: "1" }), msg({ id: "2" })]);
      const result = await store.upsertMessages([
        msg({ id: "2" }),
        msg({ id: "3" }),
        msg({ id: "4" }),
      ]);
      expect(result).toEqual({ added: 2, updated: 1 });
    });

    it("upsertMessages with empty array is a no-op", async () => {
      const { store } = await factory();
      const result = await store.upsertMessages([]);
      expect(result).toEqual({ added: 0, updated: 0 });
    });

    it("deleteMessages removes listed ids and returns actual deleted count", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1" }),
        msg({ id: "2" }),
        msg({ id: "3" }),
      ]);
      const result = await store.deleteMessages(["1", "3", "missing"]);
      expect(result).toEqual({ deleted: 2 });
      const reAdd = await store.upsertMessages([msg({ id: "1" })]);
      expect(reAdd).toEqual({ added: 1, updated: 0 });
    });

    it("deleteMessages with empty array is a no-op", async () => {
      const { store } = await factory();
      const result = await store.deleteMessages([]);
      expect(result).toEqual({ deleted: 0 });
    });

    it("getSyncState returns null when no entry exists", async () => {
      const { store } = await factory();
      expect(await store.getSyncState("a@example.test", "outlook")).toBeNull();
    });

    it("setSyncState then getSyncState round-trips the entry", async () => {
      const { store } = await factory();
      const entry: SyncStateEntry = {
        account: "a@example.test",
        source: "outlook",
        deltaToken: "delta-abc",
        lastSyncAt: new Date("2026-04-13T09:00:00Z"),
      };
      await store.setSyncState(entry);
      expect(await store.getSyncState("a@example.test", "outlook")).toEqual(
        entry,
      );
    });

    it("setSyncState overwrites an existing entry for the same key", async () => {
      const { store } = await factory();
      await store.setSyncState({
        account: "a@example.test",
        source: "outlook",
        deltaToken: "first",
      });
      await store.setSyncState({
        account: "a@example.test",
        source: "outlook",
        deltaToken: "second",
      });
      const got = await store.getSyncState("a@example.test", "outlook");
      expect(got?.deltaToken).toBe("second");
    });

    it("sync state is isolated by (account, source) pair", async () => {
      const { store } = await factory();
      await store.setSyncState({
        account: "a@example.test",
        source: "outlook",
        deltaToken: "A-out",
      });
      await store.setSyncState({
        account: "a@example.test",
        source: "teams",
        deltaToken: "A-teams",
      });
      await store.setSyncState({
        account: "b@example.test",
        source: "outlook",
        deltaToken: "B-out",
      });
      expect(
        (await store.getSyncState("a@example.test", "outlook"))?.deltaToken,
      ).toBe("A-out");
      expect(
        (await store.getSyncState("a@example.test", "teams"))?.deltaToken,
      ).toBe("A-teams");
      expect(
        (await store.getSyncState("b@example.test", "outlook"))?.deltaToken,
      ).toBe("B-out");
    });

    it("appendSyncLog round-trips an ok entry with messagesAdded", async () => {
      const harness = await factory();
      const entry: SyncLogEntry = {
        ts: new Date("2026-04-13T10:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 5,
      };
      await harness.store.appendSyncLog(entry);
      const rows = harness.readSyncLog();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(entry);
      expect(rows[0]?.errorMessage).toBeUndefined();
    });

    it("appendSyncLog round-trips an error entry with errorMessage", async () => {
      const harness = await factory();
      const entry: SyncLogEntry = {
        ts: new Date("2026-04-13T10:05:00Z"),
        account: "a@example.test",
        source: "teams",
        status: "error",
        errorMessage: "graph 429",
      };
      await harness.store.appendSyncLog(entry);
      const rows = harness.readSyncLog();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(entry);
      expect(rows[0]?.messagesAdded).toBeUndefined();
    });

    it("upsertAccount inserts a new account visible to listAccounts", async () => {
      const { store } = await factory();
      const account: AccountRecord = {
        username: "a@example.test",
        displayName: "Eric",
        tenantId: "tenant-1",
        addedAt: new Date("2026-04-13T08:00:00Z"),
      };
      await store.upsertAccount(account);
      expect(await store.listAccounts()).toEqual([account]);
    });

    it("upsertAccount updates an existing username in place", async () => {
      const { store } = await factory();
      await store.upsertAccount({
        username: "a@example.test",
        displayName: "Old",
        addedAt: new Date("2026-04-13T08:00:00Z"),
      });
      await store.upsertAccount({
        username: "a@example.test",
        displayName: "New",
        tenantId: "tenant-2",
        addedAt: new Date("2026-04-13T08:00:00Z"),
      });
      const rows = await store.listAccounts();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.displayName).toBe("New");
      expect(rows[0]?.tenantId).toBe("tenant-2");
    });

    it("listAccounts returns rows ordered by addedAt ASC, tie-break by username", async () => {
      const { store } = await factory();
      await store.upsertAccount({
        username: "b@example.test",
        addedAt: new Date("2026-04-13T09:00:00Z"),
      });
      await store.upsertAccount({
        username: "a@example.test",
        addedAt: new Date("2026-04-13T08:00:00Z"),
      });
      await store.upsertAccount({
        username: "c@example.test",
        addedAt: new Date("2026-04-13T08:00:00Z"),
      });
      const rows = await store.listAccounts();
      expect(rows.map((r) => r.username)).toEqual([
        "a@example.test",
        "c@example.test",
        "b@example.test",
      ]);
    });

    it("listAccounts on an empty store returns []", async () => {
      const { store } = await factory();
      expect(await store.listAccounts()).toEqual([]);
    });

    it("searchMessages returns empty hits on an empty store", async () => {
      const { store } = await factory();
      const res = await store.searchMessages("anything", 10);
      expect(res.hits).toEqual([]);
      expect(res.mutedCount).toBe(0);
    });

    it("searchMessages finds a message by a body term", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", body: "lorem ipsum dolor" }),
        msg({ id: "2", body: "completely unrelated text" }),
      ]);
      const hits = await search(store, "ipsum", 10);
      expect(hits.map((h) => h.message.id)).toEqual(["1"]);
    });

    it("searchMessages finds a message by a threadName term", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", threadName: "Project Falcon", body: "hello" }),
      ]);
      const hits = await search(store, "Falcon", 10);
      expect(hits.map((h) => h.message.id)).toEqual(["1"]);
    });

    it("searchMessages finds a message by a senderName term", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", senderName: "Alice Example", body: "hello" }),
      ]);
      const hits = await search(store, "Example", 10);
      expect(hits.map((h) => h.message.id)).toEqual(["1"]);
    });

    it("searchMessages respects the limit argument", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", body: "kangaroo" }),
        msg({ id: "2", body: "kangaroo" }),
        msg({ id: "3", body: "kangaroo" }),
        msg({ id: "4", body: "kangaroo" }),
        msg({ id: "5", body: "kangaroo" }),
      ]);
      const hits = await search(store, "kangaroo", 2);
      expect(hits).toHaveLength(2);
    });

    it("searchMessages returns empty hits for an empty query", async () => {
      const { store } = await factory();
      await store.upsertMessages([msg({ id: "1", body: "lorem ipsum" })]);
      expect((await store.searchMessages("", 10)).hits).toEqual([]);
      expect((await store.searchMessages("   ", 10)).hits).toEqual([]);
    });

    it("searchMessages filters by senderEmail case-insensitively, ignoring body-only matches", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "from-gunter",
          senderEmail: "gunter@example.test",
          senderName: "Gunter Peeters",
          body: "project update",
        }),
        msg({
          id: "from-gunter-mixed",
          senderEmail: "Gunter@Example.TEST",
          body: "another",
        }),
        msg({
          id: "body-mentions",
          senderEmail: "bot@devops.example",
          body: "branch owned by gunter@example.test merged",
        }),
      ]);
      const { hits } = await store.searchMessages("", 10, {
        senderEmail: "gunter@example.test",
      });
      const ids = hits.map((h) => h.message.id).sort();
      expect(ids).toEqual(["from-gunter", "from-gunter-mixed"]);
    });

    it("searchMessages senderName does a case-insensitive substring match", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "lastname-first", senderName: "Peeters, Gunter", body: "one" }),
        msg({ id: "firstname-first", senderName: "Gunter Peeters", body: "two" }),
        msg({ id: "unrelated", senderName: "Gunther Muller", body: "three" }),
      ]);
      const { hits } = await store.searchMessages("", 10, {
        senderName: "peeters",
      });
      const ids = hits.map((h) => h.message.id).sort();
      expect(ids).toEqual(["firstname-first", "lastname-first"]);
    });

    it("searchMessages composes FTS query and senderEmail via AND", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "lunch-from-gunter",
          senderEmail: "gunter@example.test",
          body: "lunch tomorrow",
        }),
        msg({
          id: "deploy-from-gunter",
          senderEmail: "gunter@example.test",
          body: "deploy done",
        }),
        msg({
          id: "lunch-from-other",
          senderEmail: "someone@x.test",
          body: "lunch plans",
        }),
      ]);
      const { hits } = await store.searchMessages("lunch", 10, {
        senderEmail: "gunter@example.test",
      });
      expect(hits.map((h) => h.message.id)).toEqual(["lunch-from-gunter"]);
    });

    it("searchMessages after is inclusive and before is exclusive", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "too-early",
          senderEmail: "p@x.test",
          sentAt: new Date("2026-03-31T23:59:59Z"),
        }),
        msg({
          id: "at-after",
          senderEmail: "p@x.test",
          sentAt: new Date("2026-04-01T00:00:00Z"),
        }),
        msg({
          id: "mid",
          senderEmail: "p@x.test",
          sentAt: new Date("2026-04-10T12:00:00Z"),
        }),
        msg({
          id: "at-before",
          senderEmail: "p@x.test",
          sentAt: new Date("2026-04-15T00:00:00Z"),
        }),
      ]);
      const { hits } = await store.searchMessages("", 10, {
        senderEmail: "p@x.test",
        after: new Date("2026-04-01T00:00:00Z"),
        before: new Date("2026-04-15T00:00:00Z"),
      });
      const ids = hits.map((h) => h.message.id).sort();
      expect(ids).toEqual(["at-after", "mid"]);
    });

    it("searchMessages orders by sent_at DESC when the FTS query is empty", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "oldest",
          senderEmail: "p@x.test",
          sentAt: new Date("2026-04-01T00:00:00Z"),
        }),
        msg({
          id: "newest",
          senderEmail: "p@x.test",
          sentAt: new Date("2026-04-10T00:00:00Z"),
        }),
        msg({
          id: "middle",
          senderEmail: "p@x.test",
          sentAt: new Date("2026-04-05T00:00:00Z"),
        }),
      ]);
      const { hits } = await store.searchMessages("", 10, {
        senderEmail: "p@x.test",
      });
      expect(hits.map((h) => h.message.id)).toEqual([
        "newest",
        "middle",
        "oldest",
      ]);
    });

    it("getRecentMessages returns empty on an empty store", async () => {
      const { store } = await factory();
      const got = await store.getRecentMessages({
        since: new Date("2026-04-13T00:00:00Z"),
        limit: 50,
      });
      expect(got.messages).toEqual([]);
      expect(got.mutedCount).toBe(0);
    });

    it("getRecentMessages filters out messages older than since", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "old", sentAt: new Date("2026-04-10T12:00:00Z") }),
        msg({ id: "edge", sentAt: new Date("2026-04-13T00:00:00Z") }),
        msg({ id: "new", sentAt: new Date("2026-04-13T09:00:00Z") }),
      ]);
      const ids = await recentIds(store, {
        since: new Date("2026-04-13T00:00:00Z"),
        limit: 50,
      });
      expect(ids.sort()).toEqual(["edge", "new"]);
    });

    it("getRecentMessages orders by sentAt DESC with id DESC tiebreak", async () => {
      const { store } = await factory();
      const ts = new Date("2026-04-13T10:00:00Z");
      await store.upsertMessages([
        msg({ id: "a", sentAt: ts }),
        msg({ id: "b", sentAt: ts }),
        msg({ id: "c", sentAt: new Date("2026-04-13T11:00:00Z") }),
      ]);
      const ids = await recentIds(store, {
        since: new Date("2026-04-13T00:00:00Z"),
        limit: 50,
      });
      expect(ids).toEqual(["c", "b", "a"]);
    });

    it("getRecentMessages filters by sources", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", source: "outlook" }),
        msg({ id: "2", source: "teams" }),
        msg({ id: "3", source: "whatsapp" }),
      ]);
      const ids = await recentIds(store, {
        since: new Date("2026-04-01T00:00:00Z"),
        sources: ["teams", "whatsapp"],
        limit: 50,
      });
      expect(ids.sort()).toEqual(["2", "3"]);
    });

    it("getRecentMessages filters by accounts", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", account: "a@example.test" }),
        msg({ id: "2", account: "b@example.test" }),
        msg({ id: "3", account: "c@example.test" }),
      ]);
      const ids = await recentIds(store, {
        since: new Date("2026-04-01T00:00:00Z"),
        accounts: ["a@example.test", "c@example.test"],
        limit: 50,
      });
      expect(ids.sort()).toEqual(["1", "3"]);
    });

    it("getRecentMessages applies sources and accounts together", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", source: "outlook", account: "a@example.test" }),
        msg({ id: "2", source: "teams", account: "a@example.test" }),
        msg({ id: "3", source: "outlook", account: "b@example.test" }),
      ]);
      const ids = await recentIds(store, {
        since: new Date("2026-04-01T00:00:00Z"),
        sources: ["outlook"],
        accounts: ["a@example.test"],
        limit: 50,
      });
      expect(ids).toEqual(["1"]);
    });

    it("getSyncStatus on an empty store returns []", async () => {
      const { store } = await factory();
      expect(
        await store.getSyncStatus(new Date("2026-04-13T12:00:00Z")),
      ).toEqual([]);
    });

    it("getSyncStatus returns one row per (account, source) seen in sync_state", async () => {
      const { store } = await factory();
      await store.setSyncState({
        account: "a@example.test",
        source: "outlook",
        deltaToken: "tok",
        lastSyncAt: new Date("2026-04-13T11:55:00Z"),
      });
      const rows = await store.getSyncStatus(new Date("2026-04-13T12:00:00Z"));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.account).toBe("a@example.test");
      expect(rows[0]?.source).toBe("outlook");
      expect(rows[0]?.lastSyncAt).toEqual(new Date("2026-04-13T11:55:00Z"));
      expect(rows[0]?.lastStatus).toBeUndefined();
      expect(rows[0]?.lastOkAt).toBeUndefined();
      expect(rows[0]?.messagesAddedLast24h).toBe(0);
    });

    it("getSyncStatus includes a row for a pair with only sync_log entries", async () => {
      const { store } = await factory();
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "teams",
        status: "ok",
        messagesAdded: 3,
      });
      const rows = await store.getSyncStatus(new Date("2026-04-13T12:00:00Z"));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe("teams");
      expect(rows[0]?.lastStatus).toBe("ok");
      expect(rows[0]?.lastSyncAt).toBeUndefined();
    });

    it("getSyncStatus.lastStatus reflects the most recent sync_log row (error after ok)", async () => {
      const { store } = await factory();
      await store.appendSyncLog({
        ts: new Date("2026-04-13T10:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 7,
      });
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "error",
        errorMessage: "graph 429",
      });
      const rows = await store.getSyncStatus(new Date("2026-04-13T12:00:00Z"));
      expect(rows[0]?.lastStatus).toBe("error");
      expect(rows[0]?.lastError).toBe("graph 429");
      expect(rows[0]?.lastOkAt).toEqual(new Date("2026-04-13T10:00:00Z"));
      expect(rows[0]?.messagesAddedLastOk).toBe(7);
    });

    it("getSyncStatus.lastStatus reflects the most recent sync_log row (ok after error)", async () => {
      const { store } = await factory();
      await store.appendSyncLog({
        ts: new Date("2026-04-13T10:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "error",
        errorMessage: "transient",
      });
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 4,
      });
      const rows = await store.getSyncStatus(new Date("2026-04-13T12:00:00Z"));
      expect(rows[0]?.lastStatus).toBe("ok");
      expect(rows[0]?.lastError).toBeUndefined();
      expect(rows[0]?.lastOkAt).toEqual(new Date("2026-04-13T11:00:00Z"));
      expect(rows[0]?.messagesAddedLastOk).toBe(4);
    });

    it("getSyncStatus.messagesAddedLast24h sums ok rows within 24h of now", async () => {
      const { store } = await factory();
      const now = new Date("2026-04-13T12:00:00Z");
      // Outside window (25h old) — excluded
      await store.appendSyncLog({
        ts: new Date("2026-04-12T11:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 1000,
      });
      // Inside window (23h old)
      await store.appendSyncLog({
        ts: new Date("2026-04-12T13:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 5,
      });
      // Inside window, but error — excluded from sum
      await store.appendSyncLog({
        ts: new Date("2026-04-13T09:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "error",
        errorMessage: "x",
      });
      // Inside window
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 8,
      });
      const rows = await store.getSyncStatus(now);
      expect(rows[0]?.messagesAddedLast24h).toBe(13);
    });

    it("getSyncStatus rows are ordered by account ASC, source ASC", async () => {
      const { store } = await factory();
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "b@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 1,
      });
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "teams",
        status: "ok",
        messagesAdded: 1,
      });
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 1,
      });
      const rows = await store.getSyncStatus(new Date("2026-04-13T12:00:00Z"));
      expect(rows.map((r) => `${r.account}/${r.source}`)).toEqual([
        "a@example.test/outlook",
        "a@example.test/teams",
        "b@example.test/outlook",
      ]);
    });

    it("getSyncStatus unions sync_state and sync_log rows for the same pair", async () => {
      const { store } = await factory();
      await store.setSyncState({
        account: "a@example.test",
        source: "outlook",
        deltaToken: "t",
        lastSyncAt: new Date("2026-04-13T11:55:00Z"),
      });
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 2,
      });
      const rows = await store.getSyncStatus(new Date("2026-04-13T12:00:00Z"));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.lastSyncAt).toEqual(new Date("2026-04-13T11:55:00Z"));
      expect(rows[0]?.lastOkAt).toEqual(new Date("2026-04-13T11:00:00Z"));
      expect(rows[0]?.lastStatus).toBe("ok");
      expect(rows[0]?.messagesAddedLastOk).toBe(2);
    });

    it("upsertMessages round-trips Teams-specific fields (chatType/replyToId/mentions)", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "t1",
          source: "teams",
          chatType: "channel",
          replyToId: "root-msg-1",
          mentions: ["alice@example.test", "bob@example.test"],
          sentAt: new Date("2026-04-13T10:00:00Z"),
          body: "hi",
        }),
      ]);
      const got = await recent(store, {
        since: new Date("2026-04-01T00:00:00Z"),
        limit: 10,
      });
      expect(got).toHaveLength(1);
      const m = got[0]!;
      expect(m.source).toBe("teams");
      expect(m.chatType).toBe("channel");
      expect(m.replyToId).toBe("root-msg-1");
      expect(m.mentions).toEqual(["alice@example.test", "bob@example.test"]);
    });

    it("upsertMessages leaves Teams fields undefined when omitted", async () => {
      const { store } = await factory();
      await store.upsertMessages([msg({ id: "plain", body: "plain" })]);
      const got = await recent(store, {
        since: new Date("2026-04-01T00:00:00Z"),
        limit: 10,
      });
      const m = got[0]!;
      expect(m.chatType).toBeUndefined();
      expect(m.replyToId).toBeUndefined();
      expect(m.mentions).toBeUndefined();
    });

    it("upsertMessages preserves an empty mentions array distinct from undefined", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "empty-mentions", source: "teams", mentions: [] }),
      ]);
      const got = await recent(store, {
        since: new Date("2026-04-01T00:00:00Z"),
        limit: 10,
      });
      expect(got[0]?.mentions).toEqual([]);
    });

    it("getChatCursor returns undefined when no cursor is set", async () => {
      const { store } = await factory();
      expect(
        await store.getChatCursor("a@example.test", "chat-1"),
      ).toBeUndefined();
    });

    it("setChatCursor then getChatCursor round-trips the ISO value", async () => {
      const { store } = await factory();
      await store.setChatCursor({
        account: "a@example.test",
        chatId: "chat-1",
        cursor: "2026-04-13T10:00:00.000Z",
      });
      expect(await store.getChatCursor("a@example.test", "chat-1")).toBe(
        "2026-04-13T10:00:00.000Z",
      );
    });

    it("setChatCursor overwrites an existing cursor for the same (account, chatId)", async () => {
      const { store } = await factory();
      await store.setChatCursor({
        account: "a@example.test",
        chatId: "chat-1",
        cursor: "2026-04-13T10:00:00.000Z",
      });
      await store.setChatCursor({
        account: "a@example.test",
        chatId: "chat-1",
        cursor: "2026-04-13T11:00:00.000Z",
      });
      expect(await store.getChatCursor("a@example.test", "chat-1")).toBe(
        "2026-04-13T11:00:00.000Z",
      );
    });

    it("listChatCursors returns [] when the account has no cursors", async () => {
      const { store } = await factory();
      expect(await store.listChatCursors("a@example.test")).toEqual([]);
    });

    it("listChatCursors returns all cursors for the given account", async () => {
      const { store } = await factory();
      await store.setChatCursor({
        account: "a@example.test",
        chatId: "chat-1",
        cursor: "2026-04-13T10:00:00.000Z",
      });
      await store.setChatCursor({
        account: "a@example.test",
        chatId: "chat-2",
        cursor: "2026-04-13T11:00:00.000Z",
      });
      const rows = await store.listChatCursors("a@example.test");
      const map = new Map(rows.map((r) => [r.chatId, r.cursor]));
      expect(map.get("chat-1")).toBe("2026-04-13T10:00:00.000Z");
      expect(map.get("chat-2")).toBe("2026-04-13T11:00:00.000Z");
      expect(rows).toHaveLength(2);
    });

    it("chat cursors are isolated by account", async () => {
      const { store } = await factory();
      await store.setChatCursor({
        account: "a@example.test",
        chatId: "chat-1",
        cursor: "2026-04-13T10:00:00.000Z",
      });
      await store.setChatCursor({
        account: "b@example.test",
        chatId: "chat-1",
        cursor: "2026-04-13T11:00:00.000Z",
      });
      expect(await store.getChatCursor("a@example.test", "chat-1")).toBe(
        "2026-04-13T10:00:00.000Z",
      );
      expect(await store.getChatCursor("b@example.test", "chat-1")).toBe(
        "2026-04-13T11:00:00.000Z",
      );
      expect(await store.listChatCursors("a@example.test")).toHaveLength(1);
      expect(await store.listChatCursors("b@example.test")).toHaveLength(1);
    });

    it("getThread returns [] for an unknown thread id", async () => {
      const { store } = await factory();
      expect(await store.getThread({ threadId: "nope" })).toEqual([]);
    });

    it("getThread resolves a Teams chat by thread_id, ordered sent_at ASC", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "teams:a@example.test:3",
          source: "teams",
          threadId: "chat-1",
          sentAt: new Date("2026-04-13T12:00:00Z"),
          body: "third",
        }),
        msg({
          id: "teams:a@example.test:1",
          source: "teams",
          threadId: "chat-1",
          sentAt: new Date("2026-04-13T10:00:00Z"),
          body: "first",
        }),
        msg({
          id: "teams:a@example.test:2",
          source: "teams",
          threadId: "chat-1",
          sentAt: new Date("2026-04-13T11:00:00Z"),
          body: "second",
        }),
        msg({
          id: "teams:a@example.test:other",
          source: "teams",
          threadId: "chat-2",
          body: "unrelated",
        }),
      ]);
      const rows = await store.getThread({ threadId: "chat-1" });
      expect(rows.map((m) => m.body)).toEqual(["first", "second", "third"]);
    });

    it("getThread respects an explicit limit and returns oldest rows first", async () => {
      const { store } = await factory();
      const seeded: Message[] = [];
      for (let i = 0; i < 10; i++) {
        seeded.push(
          msg({
            id: `teams:a@example.test:${i.toString().padStart(2, "0")}`,
            source: "teams",
            threadId: "chat-big",
            sentAt: new Date(
              Date.UTC(2026, 3, 13, 10, i, 0),
            ),
            body: `m${i}`,
          }),
        );
      }
      await store.upsertMessages(seeded);
      const rows = await store.getThread({ threadId: "chat-big", limit: 3 });
      expect(rows.map((m) => m.body)).toEqual(["m0", "m1", "m2"]);
    });

    it("getThread defaults to 200 when limit omitted", async () => {
      const { store } = await factory();
      const seeded: Message[] = [];
      for (let i = 0; i < 205; i++) {
        seeded.push(
          msg({
            id: `teams:a@example.test:${i.toString().padStart(3, "0")}`,
            source: "teams",
            threadId: "chat-huge",
            sentAt: new Date(Date.UTC(2026, 3, 13, 0, 0, i)),
            body: `m${i}`,
          }),
        );
      }
      await store.upsertMessages(seeded);
      const rows = await store.getThread({ threadId: "chat-huge" });
      expect(rows).toHaveLength(200);
      expect(rows[0]?.body).toBe("m0");
      expect(rows[199]?.body).toBe("m199");
    });

    it("getThread honours Teams-specific fields on the round-trip", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "teams:a@example.test:1",
          source: "teams",
          threadId: "chat-1",
          chatType: "group",
          replyToId: "root",
          mentions: ["alice@example.test"],
          body: "hi",
        }),
      ]);
      const rows = await store.getThread({ threadId: "chat-1" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.chatType).toBe("group");
      expect(rows[0]?.replyToId).toBe("root");
      expect(rows[0]?.mentions).toEqual(["alice@example.test"]);
    });

    it("listThreadSummaries returns one row per distinct (source, thread_id) with counts and date range, ordered newestSentAt desc", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "w1",
          source: "whatsapp",
          threadId: "General chat",
          threadName: "General chat",
          sentAt: new Date("2026-04-09T10:00:00Z"),
          body: "old a",
        }),
        msg({
          id: "w2",
          source: "whatsapp",
          threadId: "General chat",
          threadName: "General chat",
          sentAt: new Date("2026-04-09T11:00:00Z"),
          body: "old b",
        }),
        msg({
          id: "w3",
          source: "whatsapp",
          threadId: "General chat (BC Dev Talk)",
          threadName: "General chat (BC Dev Talk)",
          sentAt: new Date("2026-04-20T09:00:00Z"),
          body: "new a",
        }),
        msg({
          id: "w4",
          source: "whatsapp",
          threadId: "General chat (BC Dev Talk)",
          threadName: "General chat (BC Dev Talk)",
          sentAt: new Date("2026-04-21T08:00:00Z"),
          body: "new b",
        }),
        msg({
          id: "w5",
          source: "whatsapp",
          threadId: "General chat (BC Dev Talk)",
          threadName: "General chat (BC Dev Talk)",
          sentAt: new Date("2026-04-21T12:00:00Z"),
          body: "new c",
        }),
      ]);
      const rows = await store.listThreadSummaries({ source: "whatsapp" });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        source: "whatsapp",
        threadId: "General chat (BC Dev Talk)",
        threadName: "General chat (BC Dev Talk)",
        messageCount: 3,
        newestSentAt: new Date("2026-04-21T12:00:00Z"),
        oldestSentAt: new Date("2026-04-20T09:00:00Z"),
      });
      expect(rows[1]).toEqual({
        source: "whatsapp",
        threadId: "General chat",
        threadName: "General chat",
        messageCount: 2,
        newestSentAt: new Date("2026-04-09T11:00:00Z"),
        oldestSentAt: new Date("2026-04-09T10:00:00Z"),
      });
    });

    it("listThreadSummaries scopes by source and ignores other sources", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "t1",
          source: "teams",
          threadId: "chat-teams-1",
          threadName: "Team Chat",
          sentAt: new Date("2026-04-13T10:00:00Z"),
        }),
        msg({
          id: "w1",
          source: "whatsapp",
          threadId: "chat-whatsapp-1",
          threadName: "WhatsApp Chat",
          sentAt: new Date("2026-04-13T10:00:00Z"),
        }),
      ]);
      const teams = await store.listThreadSummaries({ source: "teams" });
      expect(teams).toHaveLength(1);
      expect(teams[0]?.threadId).toBe("chat-teams-1");
      const whatsapp = await store.listThreadSummaries({ source: "whatsapp" });
      expect(whatsapp).toHaveLength(1);
      expect(whatsapp[0]?.threadId).toBe("chat-whatsapp-1");
    });

    it("listThreadSummaries skips messages with NULL thread_id", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "orphan",
          source: "outlook",
          sentAt: new Date("2026-04-13T10:00:00Z"),
        }),
        msg({
          id: "grouped",
          source: "outlook",
          threadId: "thread-x",
          threadName: "Subject X",
          sentAt: new Date("2026-04-13T10:00:00Z"),
        }),
      ]);
      const rows = await store.listThreadSummaries({ source: "outlook" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.threadId).toBe("thread-x");
    });

    it("listThreadSummaries picks threadName from the latest message in each thread", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "x1",
          source: "whatsapp",
          threadId: "General chat",
          threadName: "General chat",
          sentAt: new Date("2026-04-09T10:00:00Z"),
        }),
        msg({
          id: "x2",
          source: "whatsapp",
          threadId: "General chat",
          threadName: "General chat (renamed)",
          sentAt: new Date("2026-04-21T10:00:00Z"),
        }),
      ]);
      const rows = await store.listThreadSummaries({ source: "whatsapp" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.threadName).toBe("General chat (renamed)");
    });

    it("listThreadSummaries returns [] for a source with no messages", async () => {
      const { store } = await factory();
      expect(await store.listThreadSummaries({ source: "teams" })).toEqual([]);
    });

    it("listThreadSummaries returns threadName=undefined when every row in the thread has a NULL thread_name", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "bare",
          source: "outlook",
          threadId: "bare-thread",
          sentAt: new Date("2026-04-13T10:00:00Z"),
        }),
      ]);
      const rows = await store.listThreadSummaries({ source: "outlook" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.threadName).toBeUndefined();
    });

    it("getRecentMessages honours the limit", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", sentAt: new Date("2026-04-13T01:00:00Z") }),
        msg({ id: "2", sentAt: new Date("2026-04-13T02:00:00Z") }),
        msg({ id: "3", sentAt: new Date("2026-04-13T03:00:00Z") }),
        msg({ id: "4", sentAt: new Date("2026-04-13T04:00:00Z") }),
      ]);
      const ids = await recentIds(store, {
        since: new Date("2026-04-01T00:00:00Z"),
        limit: 2,
      });
      expect(ids).toEqual(["4", "3"]);
    });
  });
}
