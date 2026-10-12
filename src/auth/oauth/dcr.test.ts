import { describe, expect, it } from "vitest";
import { handleDynamicClientRegistration } from "./dcr.js";
import { InMemoryAuthStore } from "../../testing/in-memory-auth-store.js";
import type { RandomIdSource } from "./ids.js";
import { FakeClock } from "../../testing/fake-clock.js";
import { DEFAULT_REDIRECT_ALLOWLIST } from "./redirect-allowlist.js";

const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

const fixedIds = (id: string): RandomIdSource => ({ next: () => id });

describe("handleDynamicClientRegistration", () => {
  it("happy path: returns 201 + client_id + echoes redirect_uris", async () => {
    const store = new InMemoryAuthStore();
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const ids = fixedIds("a".repeat(64));

    const res = await handleDynamicClientRegistration({
      body: {
        redirect_uris: [CLAUDE_CB],
        client_name: "Claude.ai connector",
      },
      store,
      ids,
      clock,
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      client_id: "a".repeat(64),
      redirect_uris: [CLAUDE_CB],
      client_name: "Claude.ai connector",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(res.body.client_id_issued_at).toBe(
      Math.floor(new Date("2026-04-20T10:00:00Z").getTime() / 1000),
    );
    expect(await store.getClient("a".repeat(64))).toMatchObject({
      clientId: "a".repeat(64),
      clientName: "Claude.ai connector",
      redirectUris: [CLAUDE_CB],
    });
  });

  it("persists client_name when present, leaves undefined when absent", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("b".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    await handleDynamicClientRegistration({
      body: { redirect_uris: [CLAUDE_CB] },
      store,
      ids,
      clock,
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });
    const stored = await store.getClient("b".repeat(64));
    expect(stored?.clientName).toBeUndefined();
  });

  it("rejects body without redirect_uris with 400 invalid_client_metadata", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("c".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: {},
      store,
      ids,
      clock,
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "invalid_client_metadata",
      error_description: expect.stringContaining("redirect_uris"),
    });
    expect(await store.listClients()).toEqual([]);
  });

  it("rejects empty redirect_uris array", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("d".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: { redirect_uris: [] },
      store,
      ids,
      clock,
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_client_metadata");
  });

  it("rejects a non-https / non-localhost redirect_uri", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("e".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: { redirect_uris: ["http://evil.example/cb"] },
      store,
      ids,
      clock,
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_redirect_uri");
  });

  it("accepts http://localhost and http://127.0.0.1 redirect_uris", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("f".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: {
        redirect_uris: [
          "http://localhost:1234/cb",
          "http://127.0.0.1:5678/cb",
        ],
      },
      store,
      ids,
      clock,
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });
    expect(res.status).toBe(201);
  });

  it("rejects a malformed redirect_uri string", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("g".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: { redirect_uris: ["not a url"] },
      store,
      ids,
      clock,
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_redirect_uri");
  });

  it("rejects a non-http(s) protocol redirect_uri (e.g. ftp://)", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("p".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: { redirect_uris: ["ftp://files.example/cb"] },
      store,
      ids,
      clock,
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_redirect_uri");
  });

  it("rejects body=null with 400 invalid_client_metadata", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("n".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: null,
      store,
      ids,
      clock,
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_client_metadata");
  });

  it("rejects a string body with 400 invalid_client_metadata", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("s".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: "not an object",
      store,
      ids,
      clock,
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_client_metadata");
  });

  it("rejects redirect_uris that is not an array", async () => {
    const store = new InMemoryAuthStore();
    const ids = fixedIds("h".repeat(64));
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const res = await handleDynamicClientRegistration({
      body: { redirect_uris: CLAUDE_CB },
      store,
      ids,
      clock,
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_client_metadata");
  });

  it("rejects an https redirect_uri that is not on the allowlist (consent phishing)", async () => {
    const store = new InMemoryAuthStore();
    const res = await handleDynamicClientRegistration({
      body: { redirect_uris: [CLAUDE_CB, "https://evil.example/cb"], client_name: "Claude" },
      store,
      ids: fixedIds("e".repeat(64)),
      clock: new FakeClock(new Date("2026-04-20T10:00:00Z")),
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_redirect_uri");
    expect(await store.listClients()).toHaveLength(0);
  });

  it("rejects a client_name longer than 64 characters", async () => {
    const store = new InMemoryAuthStore();
    const res = await handleDynamicClientRegistration({
      body: { redirect_uris: [CLAUDE_CB], client_name: "x".repeat(65) },
      store,
      ids: fixedIds("f".repeat(64)),
      clock: new FakeClock(new Date("2026-04-20T10:00:00Z")),
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_client_metadata");
    expect(await store.listClients()).toHaveLength(0);
  });

  it("accepts a client_name of exactly 64 characters", async () => {
    const store = new InMemoryAuthStore();
    const res = await handleDynamicClientRegistration({
      body: { redirect_uris: [CLAUDE_CB], client_name: "x".repeat(64) },
      store,
      ids: fixedIds("g".repeat(64)),
      clock: new FakeClock(new Date("2026-04-20T10:00:00Z")),
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });
    expect(res.status).toBe(201);
  });

  it("ignores a non-string client_name", async () => {
    const store = new InMemoryAuthStore();
    const res = await handleDynamicClientRegistration({
      body: { redirect_uris: [CLAUDE_CB], client_name: 12345 },
      store,
      ids: fixedIds("h".repeat(64)),
      clock: new FakeClock(new Date("2026-04-20T10:00:00Z")),
      redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
      maxClients: 50,
    });
    expect(res.status).toBe(201);
    expect(res.body.client_name).toBeUndefined();
    expect((await store.getClient("h".repeat(64)))?.clientName).toBeUndefined();
  });

  describe("client cap", () => {
    const NOW = new Date("2026-04-20T10:00:00Z");
    let n = 0;
    const seqIds: RandomIdSource = { next: () => `id-${++n}` };
    const register = (store: InMemoryAuthStore, maxClients: number) =>
      handleDynamicClientRegistration({
        body: { redirect_uris: [CLAUDE_CB] },
        store,
        ids: seqIds,
        clock: new FakeClock(NOW),
        redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
        maxClients,
      });

    it("refuses registration with 503 temporarily_unavailable once the cap is reached", async () => {
      const store = new InMemoryAuthStore();
      expect((await register(store, 2)).status).toBe(201);
      expect((await register(store, 2)).status).toBe(201);
      const third = await register(store, 2);
      expect(third.status).toBe(503);
      expect(third.body.error).toBe("temporarily_unavailable");
      expect(await store.countClients()).toBe(2);
    });

    it("prunes clients unused for more than 24h before applying the cap", async () => {
      const store = new InMemoryAuthStore();
      await store.registerClient({
        clientId: "abandoned",
        redirectUris: [CLAUDE_CB],
        createdAt: new Date(NOW.getTime() - 24 * 3600 * 1000 - 1),
      });
      await store.registerClient({
        clientId: "recent",
        redirectUris: [CLAUDE_CB],
        createdAt: new Date(NOW.getTime() - 24 * 3600 * 1000 + 1),
      });
      expect((await register(store, 2)).status).toBe(201);
      expect(await store.getClient("abandoned")).toBeUndefined();
      expect(await store.getClient("recent")).toBeDefined();
    });
  });
});
