import { describe, expect, it, beforeEach } from "vitest";
import { handleAuthorizeGet, handleAuthorizePost } from "./authorize.js";
import { InMemoryAuthStore } from "../../testing/in-memory-auth-store.js";
import { PlaintextPasswordHasher } from "./password.js";
import { FakeClock } from "../../testing/fake-clock.js";
import type { RandomIdSource } from "./ids.js";

const ADMIN_HASH = "plain:hunter2";
const hasher = new PlaintextPasswordHasher();
const fixedId = (id: string): RandomIdSource => ({ next: () => id });

const NOW = new Date("2026-04-20T10:00:00Z");

const makeStore = async (): Promise<InMemoryAuthStore> => {
  const store = new InMemoryAuthStore();
  await store.registerClient({
    clientId: "client-abc",
    redirectUris: ["https://claude.ai/callback"],
    createdAt: new Date("2026-04-20T09:00:00Z"),
    clientName: "Claude.ai",
  });
  return store;
};

const validGetParams = {
  client_id: "client-abc",
  redirect_uri: "https://claude.ai/callback",
  response_type: "code",
  code_challenge: "abc123_challenge",
  code_challenge_method: "S256",
  scope: "mcp",
  state: "some-state",
};

describe("handleAuthorizeGet", () => {
  it("returns 200 HTML with consent form for valid params", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({ store, params: validGetParams });
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
    expect(res.body).toContain("<form");
    expect(res.body).toContain("client-abc");
  });

  it("returns 400 for unknown client_id", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({
      store,
      params: { ...validGetParams, client_id: "unknown" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("unknown client");
  });

  it("returns 400 for unregistered redirect_uri", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({
      store,
      params: { ...validGetParams, redirect_uri: "https://evil.example/cb" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("redirect_uri");
  });

  it("returns 400 for missing code_challenge", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({
      store,
      params: { ...validGetParams, code_challenge: "" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for code_challenge_method != S256", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({
      store,
      params: { ...validGetParams, code_challenge_method: "plain" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("S256");
  });

  it("returns 400 for response_type != code", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({
      store,
      params: { ...validGetParams, response_type: "token" },
    });
    expect(res.status).toBe(400);
  });

  it("renders client_name in the consent form", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({ store, params: validGetParams });
    expect(res.body).toContain("Claude.ai");
  });

  it("falls back to client_id when client_name is absent", async () => {
    const store = new InMemoryAuthStore();
    await store.registerClient({
      clientId: "no-name-client",
      redirectUris: ["https://claude.ai/callback"],
      createdAt: new Date("2026-04-20T09:00:00Z"),
    });
    const res = await handleAuthorizeGet({
      store,
      params: { ...validGetParams, client_id: "no-name-client" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("no-name-client");
  });

  it("renders default scope when scope param is absent", async () => {
    const store = await makeStore();
    const { scope: _unused, ...paramsWithoutScope } = validGetParams;
    const res = await handleAuthorizeGet({
      store,
      params: { ...paramsWithoutScope, scope: undefined },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("mcp");
  });

  it("renders form without state hidden field when state is absent", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({
      store,
      params: { ...validGetParams, state: undefined },
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('name="state"');
  });
});

describe("handleAuthorizePost", () => {
  let store: InMemoryAuthStore;
  let clock: FakeClock;

  beforeEach(async () => {
    store = await makeStore();
    clock = new FakeClock(NOW);
  });

  it("with correct password redirects 302 with code in Location", async () => {
    const res = await handleAuthorizePost({
      store,
      hasher,
      adminPasswordHash: ADMIN_HASH,
      ids: fixedId("code-xyz"),
      clock,
      formBody: {
        client_id: "client-abc",
        redirect_uri: "https://claude.ai/callback",
        code_challenge: "abc123_challenge",
        code_challenge_method: "S256",
        scope: "mcp",
        state: "some-state",
        password: "hunter2",
      },
    });
    expect(res.status).toBe(302);
    const loc = res.headers["Location"] ?? res.headers["location"];
    expect(loc).toBeDefined();
    expect(loc).toContain("code=code-xyz");
    expect(loc).toContain("state=some-state");
  });

  it("includes state in redirect when present", async () => {
    const res = await handleAuthorizePost({
      store,
      hasher,
      adminPasswordHash: ADMIN_HASH,
      ids: fixedId("code-xyz"),
      clock,
      formBody: {
        client_id: "client-abc",
        redirect_uri: "https://claude.ai/callback",
        code_challenge: "abc123_challenge",
        code_challenge_method: "S256",
        scope: "mcp",
        state: "my-state",
        password: "hunter2",
      },
    });
    const loc = res.headers["Location"] ?? res.headers["location"];
    expect(loc).toContain("state=my-state");
  });

  it("omits state from redirect when absent", async () => {
    const res = await handleAuthorizePost({
      store,
      hasher,
      adminPasswordHash: ADMIN_HASH,
      ids: fixedId("code-xyz"),
      clock,
      formBody: {
        client_id: "client-abc",
        redirect_uri: "https://claude.ai/callback",
        code_challenge: "abc123_challenge",
        code_challenge_method: "S256",
        scope: "mcp",
        password: "hunter2",
      },
    });
    const loc = res.headers["Location"] ?? res.headers["location"];
    expect(loc).not.toContain("state=");
  });

  it("stores the auth code in the store", async () => {
    await handleAuthorizePost({
      store,
      hasher,
      adminPasswordHash: ADMIN_HASH,
      ids: fixedId("stored-code"),
      clock,
      formBody: {
        client_id: "client-abc",
        redirect_uri: "https://claude.ai/callback",
        code_challenge: "challenge-xyz",
        code_challenge_method: "S256",
        scope: "mcp",
        password: "hunter2",
      },
    });
    const record = await store.consumeAuthCode("stored-code", NOW);
    expect(record).toBeDefined();
    expect(record?.codeChallenge).toBe("challenge-xyz");
  });

  it("with wrong password returns 401 HTML", async () => {
    const res = await handleAuthorizePost({
      store,
      hasher,
      adminPasswordHash: ADMIN_HASH,
      ids: fixedId("code-xyz"),
      clock,
      formBody: {
        client_id: "client-abc",
        redirect_uri: "https://claude.ai/callback",
        code_challenge: "abc123_challenge",
        code_challenge_method: "S256",
        scope: "mcp",
        password: "wrong-password",
      },
    });
    expect(res.status).toBe(401);
    expect(res.headers["Content-Type"] ?? res.headers["content-type"]).toMatch(
      /text\/html/,
    );
    expect(res.body).toContain("Incorrect password");
  });

  it("with missing adminPasswordHash returns 503", async () => {
    const res = await handleAuthorizePost({
      store,
      hasher,
      adminPasswordHash: undefined,
      ids: fixedId("code-xyz"),
      clock,
      formBody: {
        client_id: "client-abc",
        redirect_uri: "https://claude.ai/callback",
        code_challenge: "abc123_challenge",
        code_challenge_method: "S256",
        scope: "mcp",
        password: "hunter2",
      },
    });
    expect(res.status).toBe(503);
  });
});
