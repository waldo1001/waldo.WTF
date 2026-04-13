import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

describe("MCP HTTP server end-to-end (SQLite + SDK client over HTTP)", () => {
  let db: Database.Database;
  let store: SqliteMessageStore;
  let clock: FakeClock;
  let server: Server;
  let baseUrl: string;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

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

    transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/`), {
      requestInit: {
        headers: { Authorization: `Bearer ${BEARER}` },
      },
    });
    client = new Client(
      { name: "waldo-e2e", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    db.close();
  });

  const parse = <T>(text: string): T => JSON.parse(text) as T;

  it("lists the v1 MCP tools via SDK transport", async () => {
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_recent_activity",
      "get_sync_status",
      "get_thread",
      "list_accounts",
      "search",
    ]);
  });

  it("list_accounts over HTTP returns seeded accounts ordered by addedAt", async () => {
    await store.upsertAccount({
      username: "alice@example.test",
      displayName: "Alice",
      tenantId: "tenant-1",
      addedAt: new Date("2026-04-13T08:00:00Z"),
    });
    await store.upsertAccount({
      username: "bob@example.test",
      addedAt: new Date("2026-04-13T09:00:00Z"),
    });
    const res = await client.callTool({
      name: "list_accounts",
      arguments: {},
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const parsed = parse<{
      count: number;
      accounts: Array<{
        username: string;
        displayName?: string;
        addedAt: string;
        tenantId?: string;
      }>;
    }>(content[0]!.text);
    expect(parsed.count).toBe(2);
    expect(parsed.accounts.map((a) => a.username)).toEqual([
      "alice@example.test",
      "bob@example.test",
    ]);
    expect(parsed.accounts[0]?.displayName).toBe("Alice");
    expect(parsed.accounts[0]?.addedAt).toBe("2026-04-13T08:00:00.000Z");
    expect(parsed.accounts[0]?.tenantId).toBeUndefined();
  });

  it("rejects unauthenticated initialize at the transport boundary", async () => {
    const badTransport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/`),
    );
    const badClient = new Client(
      { name: "bad", version: "0.0.0" },
      { capabilities: {} },
    );
    await expect(badClient.connect(badTransport)).rejects.toThrow();
  });

  it("get_recent_activity over HTTP returns in-window messages with no body/rawJson", async () => {
    const res = await client.callTool({
      name: "get_recent_activity",
      arguments: { hours: 24 },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const parsed = parse<{
      count: number;
      messages: Array<{
        id: string;
        snippet?: string;
        body?: string;
        rawJson?: string;
      }>;
    }>(content[0]!.text);
    const ids = parsed.messages.map((m) => m.id).sort();
    expect(parsed.count).toBe(2);
    expect(ids).toEqual(["in-1", "in-2"]);
    const boardMsg = parsed.messages.find((m) => m.id === "in-1");
    expect(boardMsg?.snippet).toContain("Quarterly board meeting");
    expect(boardMsg?.body).toBeUndefined();
    expect(boardMsg?.rawJson).toBeUndefined();
  });

  it("search over HTTP returns FTS5 hits with snippet and rank", async () => {
    const res = await client.callTool({
      name: "search",
      arguments: { query: "board" },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const parsed = parse<{
      count: number;
      hits: Array<{
        message: { id: string };
        snippet: string;
        rank: number;
      }>;
    }>(content[0]!.text);
    expect(parsed.count).toBe(1);
    const first = parsed.hits[0];
    expect(first?.message.id).toBe("in-1");
    expect(first?.snippet.length).toBeGreaterThan(0);
    expect(typeof first?.rank).toBe("number");
  });

  it("get_thread over HTTP returns a Teams chat ordered oldest→newest", async () => {
    await store.upsertMessages([
      mkMessage({
        id: "teams:alice@example.test:m1",
        source: "teams",
        threadId: "chat-xyz",
        chatType: "group",
        senderName: "Carol",
        body: "first",
        sentAt: new Date("2026-04-13T09:00:00Z"),
      }),
      mkMessage({
        id: "teams:alice@example.test:m2",
        source: "teams",
        threadId: "chat-xyz",
        chatType: "group",
        senderName: "Dave",
        body: "second",
        sentAt: new Date("2026-04-13T09:05:00Z"),
      }),
      mkMessage({
        id: "teams:alice@example.test:other",
        source: "teams",
        threadId: "chat-other",
        body: "unrelated",
      }),
    ]);
    const res = await client.callTool({
      name: "get_thread",
      arguments: { thread_id: "chat-xyz" },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const parsed = parse<{
      count: number;
      messages: Array<{
        id: string;
        snippet?: string;
        body?: string;
        rawJson?: string;
        chatType?: string;
      }>;
    }>(content[0]!.text);
    expect(parsed.count).toBe(2);
    expect(parsed.messages.map((m) => m.id)).toEqual([
      "teams:alice@example.test:m1",
      "teams:alice@example.test:m2",
    ]);
    expect(parsed.messages[0]?.snippet).toBe("first");
    expect(parsed.messages[0]?.chatType).toBe("group");
    expect(parsed.messages[0]?.body).toBeUndefined();
    expect(parsed.messages[0]?.rawJson).toBeUndefined();
  });

  it("get_thread returns empty for an unknown thread id", async () => {
    const res = await client.callTool({
      name: "get_thread",
      arguments: { thread_id: "no-such-chat" },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const parsed = parse<{ count: number; messages: unknown[] }>(
      content[0]!.text,
    );
    expect(parsed.count).toBe(0);
    expect(parsed.messages).toEqual([]);
  });

  it("get_sync_status over HTTP surfaces the seeded sync_log row", async () => {
    const res = await client.callTool({
      name: "get_sync_status",
      arguments: {},
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const parsed = parse<{
      generatedAt: string;
      accountsTracked: number;
      staleCount: number;
      rows: Array<{
        account: string;
        source: string;
        lastStatus?: string;
        messagesAddedLast24h: number;
        stale: boolean;
      }>;
    }>(content[0]!.text);
    expect(parsed.generatedAt).toBe("2026-04-13T12:00:00.000Z");
    expect(parsed.accountsTracked).toBe(1);
    const row = parsed.rows[0];
    expect(row?.account).toBe("alice@example.test");
    expect(row?.source).toBe("outlook");
    expect(row?.lastStatus).toBe("ok");
    expect(row?.messagesAddedLast24h).toBe(3);
    expect(row?.stale).toBe(false);
    expect(parsed.staleCount).toBe(0);
  });
});
