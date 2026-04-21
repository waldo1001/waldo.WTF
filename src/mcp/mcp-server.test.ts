import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp-server.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { InMemorySteeringStore } from "../testing/in-memory-steering-store.js";
import { FakeClock } from "../testing/fake-clock.js";
import { SqliteMessageStore } from "../store/sqlite-message-store.js";
import { SqliteSteeringStore } from "../store/steering-store.js";
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
  let steering: InMemorySteeringStore;
  let clock: FakeClock;
  let client: Client;

  beforeEach(async () => {
    clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    steering = new InMemorySteeringStore(clock);
    store = new InMemoryMessageStore({ steeringStore: steering });
    const server = createMcpServer({ store, steering, clock });
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

  it("lists the v1 MCP tools + steering tools with their inputSchema", async () => {
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "add_steering_rule",
      "get_recent_activity",
      "get_steering",
      "get_sync_status",
      "get_thread",
      "list_accounts",
      "list_threads",
      "remove_steering_rule",
      "search",
      "set_steering_enabled",
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
    const add = res.tools.find((t) => t.name === "add_steering_rule");
    expect(add?.inputSchema).toMatchObject({
      type: "object",
      required: ["rule_type", "pattern"],
    });
  });

  it("wraps list_threads result in a text content block with ISO timestamps", async () => {
    await store.upsertMessages([
      mkMessage({
        id: "w1",
        source: "whatsapp",
        threadId: "General chat",
        threadName: "General chat",
        sentAt: new Date("2026-04-09T10:00:00Z"),
      }),
      mkMessage({
        id: "w2",
        source: "whatsapp",
        threadId: "General chat (BC Dev Talk)",
        threadName: "General chat (BC Dev Talk)",
        sentAt: new Date("2026-04-21T08:00:00Z"),
      }),
    ]);
    const res = await client.callTool({
      name: "list_threads",
      arguments: { source: "whatsapp" },
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as {
      count: number;
      threads: Array<{ threadId: string; newestSentAt: string }>;
    };
    expect(parsed.count).toBe(2);
    expect(parsed.threads[0]?.threadId).toBe("General chat (BC Dev Talk)");
    expect(parsed.threads[0]?.newestSentAt).toBe("2026-04-21T08:00:00.000Z");
    expect(parsed.threads[1]?.threadId).toBe("General chat");
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
    const throwingSteering = new InMemorySteeringStore(clock);
    const server = createMcpServer({
      store: throwing,
      steering: throwingSteering,
      clock,
    });
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

  it("logs the original error and tool name when a handler throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const throwing = new InMemoryMessageStore();
      const boom = new Error("kaboom original");
      throwing.getRecentMessages = async () => {
        throw boom;
      };
      const server = createMcpServer({
        store: throwing,
        steering: new InMemorySteeringStore(clock),
        clock,
      });
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
      const logged = errSpy.mock.calls.map((a) => a.join(" ")).join("\n");
      expect(logged).toContain("get_recent_activity");
      expect(logged).toContain("kaboom original");
      expect(logged).toMatch(/\n\s+at /); // stack trace frame present
    } finally {
      errSpy.mockRestore();
    }
  });

  it("does NOT log InvalidParamsError (caller error, not server fault)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        client.callTool({ name: "search", arguments: { query: "" } }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      const logged = errSpy.mock.calls.map((a) => a.join(" ")).join("\n");
      expect(logged).not.toContain("search");
      expect(logged).not.toMatch(/mcp tool handler/i);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("logs non-Error throws (string/number) with the tool name", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const throwing = new InMemoryMessageStore();
      throwing.getRecentMessages = async () => {
        throw "stringy-boom";
      };
      const server = createMcpServer({
        store: throwing,
        steering: new InMemorySteeringStore(clock),
        clock,
      });
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
      const logged = errSpy.mock.calls.map((a) => a.join(" ")).join("\n");
      expect(logged).toContain("get_recent_activity");
      expect(logged).toContain("stringy-boom");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("server provides multilingual search + steering instructions", () => {
    const instructions = client.getInstructions();
    expect(instructions).toContain("multilingual");
    expect(instructions).toContain("get_sync_status");
    expect(instructions).toContain("Steering rules");
  });

  it("add_steering_rule + get_recent_activity hides muted messages and emits hint", async () => {
    await store.upsertMessages([
      mkMessage({
        id: "muted",
        senderEmail: "noisy@bar.com",
        body: "please ignore",
        sentAt: new Date("2026-04-13T11:45:00Z"),
      }),
      mkMessage({
        id: "keep",
        senderEmail: "alice@example.test",
        body: "real work",
        sentAt: new Date("2026-04-13T11:50:00Z"),
      }),
    ]);
    const added = await client.callTool({
      name: "add_steering_rule",
      arguments: { rule_type: "sender_email", pattern: "noisy@bar.com" },
    });
    const addedBody = JSON.parse(
      (added.content as Array<{ text: string }>)[0]!.text,
    ) as { rule: { id: number; pattern: string; enabled: boolean } };
    expect(addedBody.rule.pattern).toBe("noisy@bar.com");
    expect(addedBody.rule.enabled).toBe(true);

    const recent = await client.callTool({
      name: "get_recent_activity",
      arguments: { hours: 2 },
    });
    const recentBody = JSON.parse(
      (recent.content as Array<{ text: string }>)[0]!.text,
    ) as {
      messages: Array<{ id: string }>;
      muted_count: number;
      steering_hint?: string;
    };
    expect(recentBody.messages.map((m) => m.id)).toEqual(["keep"]);
    expect(recentBody.muted_count).toBe(1);
    expect(recentBody.steering_hint).toBeDefined();

    const withMuted = await client.callTool({
      name: "get_recent_activity",
      arguments: { hours: 2, include_muted: true },
    });
    const withMutedBody = JSON.parse(
      (withMuted.content as Array<{ text: string }>)[0]!.text,
    ) as { muted_count: number; steering_hint?: string };
    expect(withMutedBody.muted_count).toBe(0);
    expect(withMutedBody.steering_hint).toBeUndefined();
  });

  it("set_steering_enabled(false) makes muted messages reappear", async () => {
    await store.upsertMessages([
      mkMessage({
        id: "m1",
        senderEmail: "noisy@bar.com",
        sentAt: new Date("2026-04-13T11:45:00Z"),
      }),
    ]);
    const added = await client.callTool({
      name: "add_steering_rule",
      arguments: { rule_type: "sender_email", pattern: "noisy@bar.com" },
    });
    const ruleId = (
      JSON.parse((added.content as Array<{ text: string }>)[0]!.text) as {
        rule: { id: number };
      }
    ).rule.id;

    await client.callTool({
      name: "set_steering_enabled",
      arguments: { id: ruleId, enabled: false },
    });
    const recent = await client.callTool({
      name: "get_recent_activity",
      arguments: { hours: 2 },
    });
    const body = JSON.parse(
      (recent.content as Array<{ text: string }>)[0]!.text,
    ) as { messages: Array<{ id: string }>; muted_count: number };
    expect(body.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(body.muted_count).toBe(0);
  });

  it("remove_steering_rule deletes the rule", async () => {
    const added = await client.callTool({
      name: "add_steering_rule",
      arguments: { rule_type: "sender_email", pattern: "a@b.test" },
    });
    const ruleId = (
      JSON.parse((added.content as Array<{ text: string }>)[0]!.text) as {
        rule: { id: number };
      }
    ).rule.id;
    const rm = await client.callTool({
      name: "remove_steering_rule",
      arguments: { id: ruleId },
    });
    const rmBody = JSON.parse(
      (rm.content as Array<{ text: string }>)[0]!.text,
    ) as { removed: boolean };
    expect(rmBody.removed).toBe(true);
    const listed = await client.callTool({
      name: "get_steering",
      arguments: {},
    });
    const listedBody = JSON.parse(
      (listed.content as Array<{ text: string }>)[0]!.text,
    ) as { count: number };
    expect(listedBody.count).toBe(0);
  });
});

describe("createMcpServer — read-only contract (sqlite-backed)", () => {
  it("steering tools only write to the steering_rules table; messages/sync_state/sync_log/accounts untouched", async () => {
    const db = new Database(":memory:");
    const steering = new SqliteSteeringStore(db);
    const store = new SqliteMessageStore(db, steering);
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    await store.upsertMessages([
      mkMessage({
        id: "seed",
        senderEmail: "alice@example.test",
        sentAt: new Date("2026-04-13T11:45:00Z"),
      }),
    ]);

    const server = createMcpServer({ store, steering, clock });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "c", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(st), c.connect(ct)]);

    const snapshot = () => ({
      messages: db.prepare("SELECT * FROM messages ORDER BY id").all(),
      sync_state: db.prepare("SELECT * FROM sync_state").all(),
      sync_log: db.prepare("SELECT * FROM sync_log").all(),
      accounts: db.prepare("SELECT * FROM accounts").all(),
    });
    const before = snapshot();

    const added = await c.callTool({
      name: "add_steering_rule",
      arguments: { rule_type: "sender_email", pattern: "bob@noise.test" },
    });
    const ruleId = (
      JSON.parse((added.content as Array<{ text: string }>)[0]!.text) as {
        rule: { id: number };
      }
    ).rule.id;
    await c.callTool({
      name: "set_steering_enabled",
      arguments: { id: ruleId, enabled: false },
    });
    await c.callTool({
      name: "set_steering_enabled",
      arguments: { id: ruleId, enabled: true },
    });
    await c.callTool({
      name: "remove_steering_rule",
      arguments: { id: ruleId },
    });

    const after = snapshot();
    expect(after).toEqual(before);
  });
});
