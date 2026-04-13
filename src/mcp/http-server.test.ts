import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMcpHttpServer } from "./http-server.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { FakeClock } from "../testing/fake-clock.js";
import type { Message } from "../store/types.js";

const BEARER = "bearer-xyz";

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

describe("createMcpHttpServer", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryMessageStore;
  let clock: FakeClock;

  beforeEach(async () => {
    store = new InMemoryMessageStore();
    clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
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
  });

  const rpcPost = async (body: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BEARER}`,
        ...headers,
      },
      body,
    });

  it("GET /health returns 200 { ok: true } without auth", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /anything without Authorization returns 401 unauthorized", async () => {
    const res = await fetch(`${baseUrl}/anything`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("GET /anything with malformed Authorization returns 401", async () => {
    const res = await fetch(`${baseUrl}/anything`, {
      headers: { Authorization: "Bearer" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /anything with empty bearer token returns 401", async () => {
    const res = await fetch(`${baseUrl}/anything`, {
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });

  it("GET /anything with wrong bearer returns 401", async () => {
    const res = await fetch(`${baseUrl}/anything`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /anything with correct bearer returns 404 not_found", async () => {
    const res = await fetch(`${baseUrl}/anything`, {
      headers: { Authorization: `Bearer ${BEARER}` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("shorter-than-expected bearer returns 401 without throwing", async () => {
    const res = await fetch(`${baseUrl}/anything`, {
      headers: { Authorization: "Bearer short" },
    });
    expect(res.status).toBe(401);
  });

  it("server starts on listen(0) and returns a closable http.Server", () => {
    const addr = server.address() as AddressInfo;
    expect(typeof addr.port).toBe("number");
    expect(addr.port).toBeGreaterThan(0);
    expect(typeof server.close).toBe("function");
  });

  it("POST / without auth returns 401", async () => {
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("POST / with invalid JSON returns -32700 parse error", async () => {
    const res = await rpcPost("not json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: unknown;
      error: { code: number };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32700);
  });

  it("POST / with unknown method returns -32601 method not found", async () => {
    const res = await rpcPost(
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "no/such" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      error: { code: number };
    };
    expect(body.id).toBe(7);
    expect(body.error.code).toBe(-32601);
  });

  it("POST / tools/list returns get_recent_activity tool schema", async () => {
    const res = await rpcPost(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("get_recent_activity");
  });

  it("POST / tools/call get_recent_activity returns count and messages", async () => {
    await store.upsertMessages([
      mkMessage({
        id: "hello",
        body: "hi there",
        sentAt: new Date("2026-04-13T11:45:00Z"),
      }),
    ]);
    const res = await rpcPost(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: {
          name: "get_recent_activity",
          arguments: { hours: 2 },
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      result: { count: number; messages: Array<{ id: string }> };
    };
    expect(body.id).toBe(42);
    expect(body.result.count).toBe(1);
    expect(body.result.messages[0]?.id).toBe("hello");
  });

  it("POST / tools/call with invalid params returns -32602", async () => {
    const res = await rpcPost(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "get_recent_activity", arguments: { hours: -1 } },
      }),
    );
    const body = (await res.json()) as {
      id: number;
      error: { code: number };
    };
    expect(body.id).toBe(8);
    expect(body.error.code).toBe(-32602);
  });

  it("POST / tools/call returns -32603 when the store throws unexpectedly", async () => {
    const throwingStore: InMemoryMessageStore = new InMemoryMessageStore();
    // Replace the method with one that throws a non-InvalidParams error.
    throwingStore.getRecentMessages = async () => {
      throw new Error("boom");
    };
    const altServer = createMcpHttpServer({
      bearerToken: BEARER,
      store: throwingStore,
      clock,
    });
    await new Promise<void>((r) => altServer.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (altServer.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BEARER}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_recent_activity", arguments: { hours: 1 } },
        }),
      });
      const body = (await res.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32603);
    } finally {
      await new Promise<void>((r) => altServer.close(() => r()));
    }
  });

  it("POST / with a valid-JSON but non-object body returns -32600 invalid request", async () => {
    const res = await rpcPost("42");
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });

  it("POST / with missing method field returns -32600 invalid request", async () => {
    const res = await rpcPost(JSON.stringify({ jsonrpc: "2.0", id: 1 }));
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });

  it("POST / tools/call with unknown tool name returns -32601", async () => {
    const res = await rpcPost(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "nope", arguments: {} },
      }),
    );
    const body = (await res.json()) as {
      error: { code: number };
    };
    expect(body.error.code).toBe(-32601);
  });
});
