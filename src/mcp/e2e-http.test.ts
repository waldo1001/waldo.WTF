import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMcpHttpServer } from "./http-server.js";
import { SqliteMessageStore } from "../store/sqlite-message-store.js";
import { FakeClock } from "../testing/fake-clock.js";
import type { Message } from "../store/types.js";

const BEARER = "e2e-bearer-token";

const mkMessage = (
  overrides: Partial<Message> & Pick<Message, "id">,
): Message => ({
  source: "outlook",
  account: "alice@example.test",
  nativeId: `native-${overrides.id}`,
  sentAt: new Date("2026-04-13T11:00:00Z"),
  importedAt: new Date("2026-04-13T11:05:00Z"),
  ...overrides,
});

interface JsonRpcResult<T> {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result: T;
}

describe("MCP HTTP server end-to-end (SQLite + real fetch)", () => {
  let db: Database.Database;
  let store: SqliteMessageStore;
  let clock: FakeClock;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    store = new SqliteMessageStore(db);
    clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));

    await store.upsertMessages([
      mkMessage({
        id: "in-1",
        body: "Quarterly board meeting recap — numbers look great",
        threadName: "Board",
        senderName: "Alice",
        senderEmail: "alice@example.test",
        sentAt: new Date("2026-04-13T10:00:00Z"),
      }),
      mkMessage({
        id: "in-2",
        body: "Lunch plans tomorrow? Pizza at noon.",
        threadName: "Lunch",
        senderName: "Bob",
        senderEmail: "bob@example.test",
        sentAt: new Date("2026-04-13T08:00:00Z"),
      }),
      mkMessage({
        id: "out-of-window",
        body: "ancient message",
        sentAt: new Date("2026-04-11T00:00:00Z"),
      }),
    ]);

    await store.appendSyncLog({
      ts: new Date("2026-04-13T11:55:00Z"),
      account: "alice@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 3,
    });
    await store.setSyncState({
      account: "alice@example.test",
      source: "outlook",
      deltaToken: "delta-abc",
      lastSyncAt: new Date("2026-04-13T11:55:00Z"),
    });

    server = createMcpHttpServer({ bearerToken: BEARER, store, clock });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    db.close();
  });

  const rpc = async <T,>(
    method: string,
    params?: unknown,
    headers: Record<string, string> = {},
  ): Promise<JsonRpcResult<T>> => {
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BEARER}`,
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as JsonRpcResult<T>;
  };

  it("tools/list returns all three Weekend 3 tools", async () => {
    const result = await rpc<{ tools: { name: string }[] }>("tools/list");
    const names = result.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_recent_activity", "get_sync_status", "search"]);
  });

  it("rejects unauthenticated tools/call at the e2e layer", async () => {
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_recent_activity", arguments: { hours: 24 } },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("get_recent_activity over HTTP returns the in-window messages from SQLite", async () => {
    const result = await rpc<{
      count: number;
      messages: {
        id: string;
        source: string;
        account: string;
        senderName?: string;
        sentAt: string;
        snippet?: string;
        body?: string;
        rawJson?: string;
      }[];
    }>("tools/call", {
      name: "get_recent_activity",
      arguments: { hours: 24 },
    });
    const ids = result.result.messages.map((m) => m.id).sort();
    expect(result.result.count).toBe(2);
    expect(ids).toEqual(["in-1", "in-2"]);
    const boardMsg = result.result.messages.find((m) => m.id === "in-1");
    expect(boardMsg?.snippet).toContain("Quarterly board meeting");
    // body / rawJson must never leak.
    expect(boardMsg?.body).toBeUndefined();
    expect(boardMsg?.rawJson).toBeUndefined();
  });

  it("search over HTTP returns FTS5 hits with snippet and rank", async () => {
    const result = await rpc<{
      count: number;
      hits: {
        message: { id: string };
        snippet: string;
        rank: number;
      }[];
    }>("tools/call", {
      name: "search",
      arguments: { query: "board" },
    });
    expect(result.result.count).toBe(1);
    const first = result.result.hits[0];
    expect(first?.message.id).toBe("in-1");
    expect(first?.snippet.length).toBeGreaterThan(0);
    expect(typeof first?.rank).toBe("number");
  });

  it("get_sync_status over HTTP surfaces the seeded sync_log row", async () => {
    const result = await rpc<{
      generatedAt: string;
      accountsTracked: number;
      staleCount: number;
      rows: {
        account: string;
        source: string;
        lastStatus?: string;
        messagesAddedLast24h: number;
        stale: boolean;
      }[];
    }>("tools/call", { name: "get_sync_status", arguments: {} });
    expect(result.result.generatedAt).toBe("2026-04-13T12:00:00.000Z");
    expect(result.result.accountsTracked).toBe(1);
    const row = result.result.rows[0];
    expect(row?.account).toBe("alice@example.test");
    expect(row?.source).toBe("outlook");
    expect(row?.lastStatus).toBe("ok");
    expect(row?.messagesAddedLast24h).toBe(3);
    expect(row?.stale).toBe(false);
    expect(result.result.staleCount).toBe(0);
  });
});
