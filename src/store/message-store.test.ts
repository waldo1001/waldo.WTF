import { describe, expect, it } from "vitest";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import type { Message, SyncStateEntry } from "./types.js";

function msg(overrides: Partial<Message> & Pick<Message, "id">): Message {
  return {
    id: overrides.id,
    source: overrides.source ?? "outlook",
    account: overrides.account ?? "a@example.test",
    nativeId: overrides.nativeId ?? `native-${overrides.id}`,
    threadId: overrides.threadId,
    threadName: overrides.threadName,
    senderName: overrides.senderName,
    senderEmail: overrides.senderEmail,
    sentAt: overrides.sentAt ?? new Date("2026-04-13T10:00:00Z"),
    importedAt: overrides.importedAt ?? new Date("2026-04-13T10:05:00Z"),
    isRead: overrides.isRead,
    body: overrides.body,
    bodyHtml: overrides.bodyHtml,
    rawJson: overrides.rawJson,
  };
}

describe("MessageStore contract (InMemoryMessageStore)", () => {
  it("upsertMessages on an empty store adds all rows", async () => {
    const store = new InMemoryMessageStore();
    const result = await store.upsertMessages([
      msg({ id: "1" }),
      msg({ id: "2" }),
      msg({ id: "3" }),
    ]);
    expect(result).toEqual({ added: 3, updated: 0 });
  });

  it("upsertMessages updates an existing id in place", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertMessages([msg({ id: "1", body: "first" })]);
    const result = await store.upsertMessages([msg({ id: "1", body: "second" })]);
    expect(result).toEqual({ added: 0, updated: 1 });
  });

  it("upsertMessages reports mixed added/updated counts", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertMessages([msg({ id: "1" }), msg({ id: "2" })]);
    const result = await store.upsertMessages([
      msg({ id: "2" }),
      msg({ id: "3" }),
      msg({ id: "4" }),
    ]);
    expect(result).toEqual({ added: 2, updated: 1 });
  });

  it("upsertMessages with empty array is a no-op", async () => {
    const store = new InMemoryMessageStore();
    const result = await store.upsertMessages([]);
    expect(result).toEqual({ added: 0, updated: 0 });
  });

  it("deleteMessages removes listed ids and returns actual deleted count", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertMessages([msg({ id: "1" }), msg({ id: "2" }), msg({ id: "3" })]);
    const result = await store.deleteMessages(["1", "3", "missing"]);
    expect(result).toEqual({ deleted: 2 });
    const reAdd = await store.upsertMessages([msg({ id: "1" })]);
    expect(reAdd).toEqual({ added: 1, updated: 0 });
  });

  it("deleteMessages with empty array is a no-op", async () => {
    const store = new InMemoryMessageStore();
    const result = await store.deleteMessages([]);
    expect(result).toEqual({ deleted: 0 });
  });

  it("getSyncState returns null when no entry exists", async () => {
    const store = new InMemoryMessageStore();
    expect(await store.getSyncState("a@example.test", "outlook")).toBeNull();
  });

  it("setSyncState then getSyncState round-trips the entry", async () => {
    const store = new InMemoryMessageStore();
    const entry: SyncStateEntry = {
      account: "a@example.test",
      source: "outlook",
      deltaToken: "delta-abc",
      lastSyncAt: new Date("2026-04-13T09:00:00Z"),
    };
    await store.setSyncState(entry);
    expect(await store.getSyncState("a@example.test", "outlook")).toEqual(entry);
  });

  it("setSyncState overwrites an existing entry for the same key", async () => {
    const store = new InMemoryMessageStore();
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
    const store = new InMemoryMessageStore();
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
    expect((await store.getSyncState("a@example.test", "outlook"))?.deltaToken).toBe("A-out");
    expect((await store.getSyncState("a@example.test", "teams"))?.deltaToken).toBe("A-teams");
    expect((await store.getSyncState("b@example.test", "outlook"))?.deltaToken).toBe("B-out");
  });
});
