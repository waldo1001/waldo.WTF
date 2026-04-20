import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMcpHttpServer } from "./http-server.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { InMemorySteeringStore } from "../testing/in-memory-steering-store.js";
import { InMemoryAuthStore } from "../testing/in-memory-auth-store.js";
import { FakeClock } from "../testing/fake-clock.js";
import type { RandomIdSource } from "../auth/oauth/ids.js";
import { PlaintextPasswordHasher } from "../auth/oauth/password.js";

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const TOKEN_VERIFIER = "test-verifier-long-enough-to-pass-any-rfc7636-min-length-yes";
const TOKEN_CHALLENGE = b64url(createHash("sha256").update(TOKEN_VERIFIER).digest());

const BEARER = "bearer-xyz";
const PUBLIC_URL = "https://nas.example.ts.net";
const fixedIds = (id: string): RandomIdSource => ({ next: () => id });

describe("createMcpHttpServer (HTTP shell around SDK transport)", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryMessageStore;
  let clock: FakeClock;

  beforeEach(async () => {
    store = new InMemoryMessageStore();
    clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    server = createMcpHttpServer({
      bearerToken: BEARER,
      store,
      steering: new InMemorySteeringStore(),
      clock,
    });
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

  it("GET /health returns 200 { ok: true } without auth", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET / without Authorization returns 401 unauthorized", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("GET / with malformed Authorization returns 401", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Authorization: "Bearer" },
    });
    expect(res.status).toBe(401);
  });

  it("GET / with empty bearer token returns 401", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });

  it("GET / with wrong bearer returns 401", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("shorter-than-expected bearer returns 401 without throwing", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Authorization: "Bearer short" },
    });
    expect(res.status).toBe(401);
  });

  it("POST / without auth returns 401", async () => {
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("server starts on listen(0) and returns a closable http.Server", () => {
    const addr = server.address() as AddressInfo;
    expect(typeof addr.port).toBe("number");
    expect(addr.port).toBeGreaterThan(0);
    expect(typeof server.close).toBe("function");
  });
});

describe("createMcpHttpServer + OAuth discovery & DCR routes", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryMessageStore;
  let authStore: InMemoryAuthStore;
  let clock: FakeClock;

  beforeEach(async () => {
    store = new InMemoryMessageStore();
    authStore = new InMemoryAuthStore();
    clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    server = createMcpHttpServer({
      bearerToken: BEARER,
      store,
      steering: new InMemorySteeringStore(),
      clock,
      oauth: {
        publicUrl: PUBLIC_URL,
        authStore,
        ids: fixedIds("z".repeat(64)),
      },
    });
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

  it("GET /.well-known/oauth-authorization-server returns JSON metadata without auth", async () => {
    const res = await fetch(
      `${baseUrl}/.well-known/oauth-authorization-server`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toMatchObject({
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
      token_endpoint: `${PUBLIC_URL}/oauth/token`,
      registration_endpoint: `${PUBLIC_URL}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("GET /.well-known/oauth-protected-resource returns JSON metadata without auth", async () => {
    const res = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      resource: PUBLIC_URL,
      authorization_servers: [PUBLIC_URL],
      bearer_methods_supported: ["header"],
    });
  });

  it("POST /oauth/register without auth returns 201 + client_id", async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://claude.ai/cb"],
        client_name: "Claude.ai",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBe("z".repeat(64));
    expect(body.redirect_uris).toEqual(["https://claude.ai/cb"]);
    expect(await authStore.getClient("z".repeat(64))).toBeDefined();
  });

  it("POST /oauth/register with malformed JSON returns 400", async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("POST /oauth/register without redirect_uris returns 400 invalid_client_metadata", async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("OAuth routes do not affect the bearer-gated POST / behavior", async () => {
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("GET /health still bypasses auth alongside oauth routes", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("createMcpHttpServer + OAuth authorize routes", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryMessageStore;
  let authStore: InMemoryAuthStore;
  let clock: FakeClock;
  const hasher = new PlaintextPasswordHasher();
  const ADMIN_HASH = "plain:hunter2";

  beforeEach(async () => {
    store = new InMemoryMessageStore();
    authStore = new InMemoryAuthStore();
    clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    await authStore.registerClient({
      clientId: "cl-1",
      redirectUris: ["https://claude.ai/callback"],
      createdAt: new Date("2026-04-20T09:00:00Z"),
      clientName: "Claude.ai",
    });
    server = createMcpHttpServer({
      bearerToken: BEARER,
      store,
      steering: new InMemorySteeringStore(),
      clock,
      oauth: {
        publicUrl: PUBLIC_URL,
        authStore,
        ids: fixedIds("code-fixed"),
        adminPasswordHash: ADMIN_HASH,
        hasher,
      },
    });
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

  const authorizeUrl = (): string =>
    `${baseUrl}/oauth/authorize?` +
    new URLSearchParams({
      client_id: "cl-1",
      redirect_uri: "https://claude.ai/callback",
      response_type: "code",
      code_challenge: "chal-xyz",
      code_challenge_method: "S256",
      scope: "mcp",
      state: "s1",
    }).toString();

  it("GET /oauth/authorize returns 200 HTML without bearer auth", async () => {
    const res = await fetch(authorizeUrl());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("<form");
    expect(body).toContain("cl-1");
  });

  it("POST /oauth/authorize with correct password returns 302", async () => {
    const params = new URLSearchParams({
      client_id: "cl-1",
      redirect_uri: "https://claude.ai/callback",
      code_challenge: "chal-xyz",
      code_challenge_method: "S256",
      scope: "mcp",
      state: "s1",
      password: "hunter2",
    });
    const res = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location");
    expect(loc).toContain("code=code-fixed");
    expect(loc).toContain("state=s1");
  });

  it("POST /oauth/authorize with wrong password returns 401", async () => {
    const params = new URLSearchParams({
      client_id: "cl-1",
      redirect_uri: "https://claude.ai/callback",
      code_challenge: "chal-xyz",
      code_challenge_method: "S256",
      scope: "mcp",
      password: "wrong",
    });
    const res = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    expect(res.status).toBe(401);
  });

  it("GET /oauth/authorize without oauth configured falls through to bearer check", async () => {
    const bareServer = createMcpHttpServer({
      bearerToken: BEARER,
      store,
      steering: new InMemorySteeringStore(),
      clock,
    });
    await new Promise<void>((resolve) => {
      bareServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = bareServer.address() as AddressInfo;
    try {
      const res = await fetch(
        `http://127.0.0.1:${addr.port}/oauth/authorize?client_id=x`,
      );
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((r, e) =>
        bareServer.close((err) => (err ? e(err) : r())),
      );
    }
  });
});

describe("createMcpHttpServer + OAuth token route", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryMessageStore;
  let authStore: InMemoryAuthStore;
  let clock: FakeClock;

  const VERIFIER = TOKEN_VERIFIER;
  const CHALLENGE = TOKEN_CHALLENGE;

  let tokenIdCounter = 0;
  const tokenIds = { next: () => `tok-${++tokenIdCounter}` };

  beforeEach(async () => {
    tokenIdCounter = 0;
    store = new InMemoryMessageStore();
    authStore = new InMemoryAuthStore();
    clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    await authStore.registerClient({
      clientId: "cl-token",
      redirectUris: ["https://claude.ai/callback"],
      createdAt: new Date("2026-04-20T09:00:00Z"),
    });
    await authStore.saveAuthCode({
      code: "auth-code-fixed",
      clientId: "cl-token",
      redirectUri: "https://claude.ai/callback",
      scope: "mcp",
      codeChallenge: CHALLENGE,
      expiresAt: new Date("2026-04-20T10:10:00Z"),
      createdAt: new Date("2026-04-20T10:00:00Z"),
    });
    server = createMcpHttpServer({
      bearerToken: BEARER,
      store,
      steering: new InMemorySteeringStore(),
      clock,
      oauth: {
        publicUrl: PUBLIC_URL,
        authStore,
        ids: tokenIds,
      },
    });
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

  it("POST /oauth/token with valid code returns 200 + access_token", async () => {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: "auth-code-fixed",
      redirect_uri: "https://claude.ai/callback",
      code_verifier: VERIFIER,
      client_id: "cl-token",
    });
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { access_token: string; token_type: string };
    expect(json.access_token).toBeDefined();
    expect(json.token_type).toBe("Bearer");
  });

  it("POST /oauth/token with bad code returns 400 invalid_grant", async () => {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: "wrong-code",
      redirect_uri: "https://claude.ai/callback",
      code_verifier: VERIFIER,
      client_id: "cl-token",
    });
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("invalid_grant");
  });
});

describe("createMcpHttpServer + OAuth resource guard", () => {
  let server: Server;
  let baseUrl: string;
  let store: InMemoryMessageStore;
  let authStore: InMemoryAuthStore;
  let clock: FakeClock;

  const NOW = new Date("2026-04-20T10:00:00Z");
  const ACCESS_EXPIRES = new Date(NOW.getTime() + 3600 * 1000);
  const REFRESH_EXPIRES = new Date(NOW.getTime() + 30 * 24 * 3600 * 1000);

  const makeServer = async (opts: { disableStaticBearer?: boolean } = {}): Promise<void> => {
    store = new InMemoryMessageStore();
    authStore = new InMemoryAuthStore();
    clock = new FakeClock(NOW);

    await authStore.registerClient({
      clientId: "cl-guard",
      redirectUris: ["https://claude.ai/callback"],
      createdAt: NOW,
    });
    await authStore.saveTokenPair({
      accessToken: "valid-access-token",
      refreshToken: "valid-refresh-token",
      clientId: "cl-guard",
      scope: "mcp",
      accessExpiresAt: ACCESS_EXPIRES,
      refreshExpiresAt: REFRESH_EXPIRES,
      createdAt: NOW,
    });
    await authStore.saveTokenPair({
      accessToken: "expired-access-token",
      refreshToken: "expired-refresh-token",
      clientId: "cl-guard",
      scope: "mcp",
      accessExpiresAt: new Date(NOW.getTime() - 1),
      refreshExpiresAt: REFRESH_EXPIRES,
      createdAt: NOW,
    });

    server = createMcpHttpServer({
      bearerToken: BEARER,
      store,
      steering: new InMemorySteeringStore(),
      clock,
      oauth: {
        publicUrl: PUBLIC_URL,
        authStore,
        ids: fixedIds("unused"),
        disableStaticBearer: opts.disableStaticBearer,
      },
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  };

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("valid OAuth access token grants MCP access (GET /health passes as control)", async () => {
    await makeServer();
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it("valid OAuth access token grants MCP endpoint access (POST /)", async () => {
    await makeServer();
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-access-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
    });
    expect(res.status).not.toBe(401);
  });

  it("expired OAuth access token returns 401", async () => {
    await makeServer();
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        Authorization: "Bearer expired-access-token",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("unknown OAuth access token returns 401", async () => {
    await makeServer();
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        Authorization: "Bearer no-such-token",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("401 with OAuth configured includes WWW-Authenticate resource_metadata header", async () => {
    await makeServer();
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate");
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("resource_metadata");
    expect(wwwAuth).toContain(PUBLIC_URL);
  });

  it("static bearer still works when disableStaticBearer is false", async () => {
    await makeServer({ disableStaticBearer: false });
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BEARER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
    });
    expect(res.status).not.toBe(401);
  });

  it("static bearer rejected when disableStaticBearer is true", async () => {
    await makeServer({ disableStaticBearer: true });
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BEARER}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
