import { describe, expect, it } from "vitest";
import type { MessageStore } from "./message-store.js";
import type {
  AccountRecord,
  Message,
  SyncLogEntry,
  SyncStateEntry,
} from "./types.js";

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

    it("searchMessages returns [] on an empty store", async () => {
      const { store } = await factory();
      expect(await store.searchMessages("anything", 10)).toEqual([]);
    });

    it("searchMessages finds a message by a body term", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", body: "lorem ipsum dolor" }),
        msg({ id: "2", body: "completely unrelated text" }),
      ]);
      const hits = await store.searchMessages("ipsum", 10);
      expect(hits.map((h) => h.message.id)).toEqual(["1"]);
    });

    it("searchMessages finds a message by a threadName term", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", threadName: "Project Falcon", body: "hello" }),
      ]);
      const hits = await store.searchMessages("Falcon", 10);
      expect(hits.map((h) => h.message.id)).toEqual(["1"]);
    });

    it("searchMessages finds a message by a senderName term", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", senderName: "Eric Wauters", body: "hello" }),
      ]);
      const hits = await store.searchMessages("Wauters", 10);
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
      const hits = await store.searchMessages("kangaroo", 2);
      expect(hits).toHaveLength(2);
    });

    it("searchMessages returns [] for an empty query", async () => {
      const { store } = await factory();
      await store.upsertMessages([msg({ id: "1", body: "lorem ipsum" })]);
      expect(await store.searchMessages("", 10)).toEqual([]);
      expect(await store.searchMessages("   ", 10)).toEqual([]);
    });

    it("getRecentMessages returns [] on an empty store", async () => {
      const { store } = await factory();
      const got = await store.getRecentMessages({
        since: new Date("2026-04-13T00:00:00Z"),
        limit: 50,
      });
      expect(got).toEqual([]);
    });

    it("getRecentMessages filters out messages older than since", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "old", sentAt: new Date("2026-04-10T12:00:00Z") }),
        msg({ id: "edge", sentAt: new Date("2026-04-13T00:00:00Z") }),
        msg({ id: "new", sentAt: new Date("2026-04-13T09:00:00Z") }),
      ]);
      const got = await store.getRecentMessages({
        since: new Date("2026-04-13T00:00:00Z"),
        limit: 50,
      });
      expect(got.map((m) => m.id).sort()).toEqual(["edge", "new"]);
    });

    it("getRecentMessages orders by sentAt DESC with id DESC tiebreak", async () => {
      const { store } = await factory();
      const ts = new Date("2026-04-13T10:00:00Z");
      await store.upsertMessages([
        msg({ id: "a", sentAt: ts }),
        msg({ id: "b", sentAt: ts }),
        msg({ id: "c", sentAt: new Date("2026-04-13T11:00:00Z") }),
      ]);
      const got = await store.getRecentMessages({
        since: new Date("2026-04-13T00:00:00Z"),
        limit: 50,
      });
      expect(got.map((m) => m.id)).toEqual(["c", "b", "a"]);
    });

    it("getRecentMessages filters by sources", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", source: "outlook" }),
        msg({ id: "2", source: "teams" }),
        msg({ id: "3", source: "whatsapp" }),
      ]);
      const got = await store.getRecentMessages({
        since: new Date("2026-04-01T00:00:00Z"),
        sources: ["teams", "whatsapp"],
        limit: 50,
      });
      expect(got.map((m) => m.id).sort()).toEqual(["2", "3"]);
    });

    it("getRecentMessages filters by accounts", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", account: "a@example.test" }),
        msg({ id: "2", account: "b@example.test" }),
        msg({ id: "3", account: "c@example.test" }),
      ]);
      const got = await store.getRecentMessages({
        since: new Date("2026-04-01T00:00:00Z"),
        accounts: ["a@example.test", "c@example.test"],
        limit: 50,
      });
      expect(got.map((m) => m.id).sort()).toEqual(["1", "3"]);
    });

    it("getRecentMessages applies sources and accounts together", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", source: "outlook", account: "a@example.test" }),
        msg({ id: "2", source: "teams", account: "a@example.test" }),
        msg({ id: "3", source: "outlook", account: "b@example.test" }),
      ]);
      const got = await store.getRecentMessages({
        since: new Date("2026-04-01T00:00:00Z"),
        sources: ["outlook"],
        accounts: ["a@example.test"],
        limit: 50,
      });
      expect(got.map((m) => m.id)).toEqual(["1"]);
    });

    it("getRecentMessages honours the limit", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", sentAt: new Date("2026-04-13T01:00:00Z") }),
        msg({ id: "2", sentAt: new Date("2026-04-13T02:00:00Z") }),
        msg({ id: "3", sentAt: new Date("2026-04-13T03:00:00Z") }),
        msg({ id: "4", sentAt: new Date("2026-04-13T04:00:00Z") }),
      ]);
      const got = await store.getRecentMessages({
        since: new Date("2026-04-01T00:00:00Z"),
        limit: 2,
      });
      expect(got.map((m) => m.id)).toEqual(["4", "3"]);
    });
  });
}
