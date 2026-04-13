import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp-server.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { FakeClock } from "../testing/fake-clock.js";
import type { Message } from "../store/types.js";

const mkMessage = (
  overrides: Partial<Message> & Pick<Message, "id">,
): Message => ({
  source: "outlook",
  account: "a@example.test",
  nativeId: `native-${overrides.id}`,
  sentAt: new Date("2026-04-13T11:30:00Z"),
  importedAt: new Date("2026-04-13T11:35:00Z"),
  ...overrides,
});

describe("createMcpServer (SDK, in-memory transport)", () => {
  let store: InMemoryMessageStore;
  let clock: FakeClock;
  let client: Client;

  beforeEach(async () => {
    store = new InMemoryMessageStore();
    clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const server = createMcpServer({ store, clock });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client(
      { name: "waldo-test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  it("lists the v1 MCP tools with their inputSchema", async () => {
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_recent_activity",
      "get_sync_status",
      "get_thread",
      "list_accounts",
      "search",
    ]);
    const rec = res.tools.find((t) => t.name === "get_recent_activity");
    expect(rec?.inputSchema).toMatchObject({
      type: "object",
      required: ["hours"],
    });
    const thread = res.tools.find((t) => t.name === "get_thread");
    expect(thread?.inputSchema).toMatchObject({
      type: "object",
      required: ["thread_id"],
    });
  });

  it("wraps get_recent_activity result in a text content block", async () => {
    await store.upsertMessages([
      mkMessage({
        id: "hi",
        body: "hello world",
        sentAt: new Date("2026-04-13T11:45:00Z"),
      }),
    ]);
    const res = await client.callTool({
      name: "get_recent_activity",
      arguments: { hours: 2 },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    const parsed = JSON.parse(content[0]!.text) as {
      count: number;
      messages: Array<{ id: string }>;
    };
    expect(parsed.count).toBe(1);
    expect(parsed.messages[0]?.id).toBe("hi");
  });

  it("wraps get_sync_status result in a text content block", async () => {
    const res = await client.callTool({
      name: "get_sync_status",
      arguments: {},
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      generatedAt: string;
      accountsTracked: number;
      staleCount: number;
    };
    expect(parsed.generatedAt).toBe("2026-04-13T12:00:00.000Z");
    expect(parsed.accountsTracked).toBe(0);
    expect(parsed.staleCount).toBe(0);
  });

  it("maps InvalidParamsError to MCP InvalidParams on search empty query", async () => {
    await expect(
      client.callTool({ name: "search", arguments: { query: "" } }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it("maps hours<=0 to InvalidParams on get_recent_activity", async () => {
    await expect(
      client.callTool({
        name: "get_recent_activity",
        arguments: { hours: -1 },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it("unknown tool name surfaces MethodNotFound", async () => {
    await expect(
      client.callTool({ name: "nope", arguments: {} }),
    ).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });

  it("maps unexpected store errors to InternalError", async () => {
    const throwing = new InMemoryMessageStore();
    throwing.getRecentMessages = async () => {
      throw new Error("boom");
    };
    const server = createMcpServer({ store: throwing, clock });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client(
      { name: "c", version: "0.0.0" },
      { capabilities: {} },
    );
    await Promise.all([server.connect(st), c.connect(ct)]);
    await expect(
      c.callTool({
        name: "get_recent_activity",
        arguments: { hours: 1 },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError });
  });
});
