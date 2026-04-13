import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMessageStoreContract } from "./message-store-contract.js";
import { SqliteMessageStore } from "./sqlite-message-store.js";
import type { Message } from "./types.js";

runMessageStoreContract("SqliteMessageStore", () => {
  const db = new Database(":memory:");
  const store = new SqliteMessageStore(db);
  return {
    store,
    readSyncLog: () => {
      const rows = db
        .prepare(
          "SELECT ts, account, source, status, messages_added, error_message FROM sync_log ORDER BY ts ASC",
        )
        .all() as {
        ts: number;
        account: string;
        source: string;
        status: string;
        messages_added: number | null;
        error_message: string | null;
      }[];
      return rows.map((r) => ({
        ts: new Date(r.ts),
        account: r.account,
        source: r.source as "outlook" | "teams" | "whatsapp",
        status: r.status as "ok" | "error",
        ...(r.messages_added !== null && { messagesAdded: r.messages_added }),
        ...(r.error_message !== null && { errorMessage: r.error_message }),
      }));
    },
  };
});

function baseMsg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    source: "outlook",
    account: "a@example.test",
    nativeId: `native-${id}`,
    sentAt: new Date("2026-04-13T10:00:00.123Z"),
    importedAt: new Date("2026-04-13T10:05:00.456Z"),
    ...overrides,
  };
}

describe("SqliteMessageStore — sqlite-specific behavior", () => {
  it("writes are visible to a second store built over the same handle", async () => {
    const db = new Database(":memory:");
    const a = new SqliteMessageStore(db);
    await a.upsertMessages([baseMsg("1"), baseMsg("2")]);
    await a.setSyncState({
      account: "a@example.test",
      source: "outlook",
      deltaToken: "tok",
      lastSyncAt: new Date("2026-04-13T09:00:00Z"),
    });

    const b = new SqliteMessageStore(db);
    const reAdd = await b.upsertMessages([baseMsg("1"), baseMsg("3")]);
    expect(reAdd).toEqual({ added: 1, updated: 1 });
    const sync = await b.getSyncState("a@example.test", "outlook");
    expect(sync).toEqual({
      account: "a@example.test",
      source: "outlook",
      deltaToken: "tok",
      lastSyncAt: new Date("2026-04-13T09:00:00Z"),
    });
  });

  it("upsertMessages rolls back the whole batch on mid-batch failure", async () => {
    const db = new Database(":memory:");
    const store = new SqliteMessageStore(db);
    const bad = { ...baseMsg("2"), account: null as unknown as string };
    await expect(
      store.upsertMessages([baseMsg("1"), bad, baseMsg("3")]),
    ).rejects.toThrow();

    const reAdd = await store.upsertMessages([
      baseMsg("1"),
      baseMsg("2"),
      baseMsg("3"),
    ]);
    expect(reAdd).toEqual({ added: 3, updated: 0 });
  });

  it("nullable fields round-trip as undefined", async () => {
    const db = new Database(":memory:");
    const store = new SqliteMessageStore(db);
    const bare = baseMsg("bare");
    await store.upsertMessages([bare]);

    const row = db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get("bare") as Record<string, unknown>;
    expect(row.thread_id).toBeNull();
    expect(row.thread_name).toBeNull();
    expect(row.sender_name).toBeNull();
    expect(row.sender_email).toBeNull();
    expect(row.is_read).toBeNull();
    expect(row.body).toBeNull();
    expect(row.body_html).toBeNull();
    expect(row.raw_json).toBeNull();

    const reUpsert = await store.upsertMessages([bare]);
    expect(reUpsert).toEqual({ added: 0, updated: 1 });
  });

  it("Date columns round-trip with millisecond precision", async () => {
    const db = new Database(":memory:");
    const store = new SqliteMessageStore(db);
    const sentAt = new Date("2026-04-13T10:00:00.123Z");
    const importedAt = new Date("2026-04-13T10:05:00.456Z");
    await store.upsertMessages([baseMsg("1", { sentAt, importedAt })]);

    const row = db
      .prepare("SELECT sent_at, imported_at FROM messages WHERE id = ?")
      .get("1") as { sent_at: number; imported_at: number };
    expect(row.sent_at).toBe(sentAt.getTime());
    expect(row.imported_at).toBe(importedAt.getTime());

    const lastSyncAt = new Date("2026-04-13T09:00:00.789Z");
    await store.setSyncState({
      account: "a@example.test",
      source: "outlook",
      deltaToken: "t",
      lastSyncAt,
    });
    const entry = await store.getSyncState("a@example.test", "outlook");
    expect(entry?.lastSyncAt?.getTime()).toBe(lastSyncAt.getTime());
  });

  it("getSyncState distinguishes missing row from row with undefined deltaToken", async () => {
    const db = new Database(":memory:");
    const store = new SqliteMessageStore(db);
    expect(await store.getSyncState("a@example.test", "outlook")).toBeNull();

    await store.setSyncState({
      account: "a@example.test",
      source: "outlook",
    });
    const entry = await store.getSyncState("a@example.test", "outlook");
    expect(entry).not.toBeNull();
    expect(entry?.deltaToken).toBeUndefined();
    expect(entry?.lastSyncAt).toBeUndefined();
  });

  it("sync_log rows persist across re-construction over the same handle", async () => {
    const db = new Database(":memory:");
    const a = new SqliteMessageStore(db);
    await a.appendSyncLog({
      ts: new Date("2026-04-13T10:00:00Z"),
      account: "a@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 7,
    });

    new SqliteMessageStore(db); // second construction must not wipe data
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM sync_log").get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("ranks messages with more term occurrences higher (lower bm25)", async () => {
    const db = new Database(":memory:");
    const store = new SqliteMessageStore(db);
    await store.upsertMessages([
      baseMsg("once", { body: "kangaroo grass field" }),
      baseMsg("thrice", { body: "kangaroo kangaroo kangaroo grass field" }),
    ]);
    const hits = await store.searchMessages("kangaroo", 10);
    expect(hits.map((h) => h.message.id)).toEqual(["thrice", "once"]);
    expect(hits[0]?.rank).toBeLessThan(hits[1]?.rank ?? 0);
  });

  it("returns a snippet wrapping the matched term", async () => {
    const db = new Database(":memory:");
    const store = new SqliteMessageStore(db);
    await store.upsertMessages([
      baseMsg("1", { body: "the quick brown kangaroo jumps" }),
    ]);
    const hits = await store.searchMessages("kangaroo", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toMatch(/\[kangaroo\]/i);
  });

  it("sanitises FTS5 metacharacters in user input", async () => {
    const db = new Database(":memory:");
    const store = new SqliteMessageStore(db);
    await store.upsertMessages([
      baseMsg("1", { body: "alpha bravo charlie" }),
      baseMsg("2", { body: "completely unrelated content" }),
    ]);
    await expect(
      store.searchMessages('foo" OR 1=1', 10),
    ).resolves.toEqual([]);
    await expect(store.searchMessages("alp*", 10)).resolves.toEqual([]);
    await expect(store.searchMessages("alpha", 10)).resolves.toHaveLength(1);
  });

  it("searchMessages round-trips all optional fields on a hit", async () => {
    const db = new Database(":memory:");
    const store = new SqliteMessageStore(db);
    const full: Message = {
      id: "full",
      source: "outlook",
      account: "a@example.test",
      nativeId: "n-full",
      threadId: "thr-1",
      threadName: "Project Falcon",
      senderName: "Eric",
      senderEmail: "eric@example.test",
      sentAt: new Date("2026-04-13T10:00:00Z"),
      importedAt: new Date("2026-04-13T10:05:00Z"),
      isRead: true,
      body: "kangaroo body",
      bodyHtml: "<p>kangaroo</p>",
      rawJson: '{"x":1}',
    };
    await store.upsertMessages([full]);
    const hits = await store.searchMessages("kangaroo", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.message).toEqual(full);
  });

  it("searchMessages survives store reconstruction", async () => {
    const db = new Database(":memory:");
    const a = new SqliteMessageStore(db);
    await a.upsertMessages([baseMsg("1", { body: "kangaroo" })]);
    const b = new SqliteMessageStore(db);
    const hits = await b.searchMessages("kangaroo", 10);
    expect(hits.map((h) => h.message.id)).toEqual(["1"]);
  });

  it("isRead boolean round-trips through INTEGER column", async () => {
    const db = new Database(":memory:");
    const store = new SqliteMessageStore(db);
    await store.upsertMessages([
      baseMsg("read", { isRead: true }),
      baseMsg("unread", { isRead: false }),
    ]);
    const rows = db
      .prepare("SELECT id, is_read FROM messages ORDER BY id")
      .all() as { id: string; is_read: number | null }[];
    expect(rows).toEqual([
      { id: "read", is_read: 1 },
      { id: "unread", is_read: 0 },
    ]);
  });
});
