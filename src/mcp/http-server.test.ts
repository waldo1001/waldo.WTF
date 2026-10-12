import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMcpHttpServer, runSafely } from "./http-server.js";
import type { ServerResponse } from "node:http";
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
  let logLines: string[];

  beforeEach(async () => {
    store = new InMemoryMessageStore();
    authStore = new InMemoryAuthStore();
    clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    logLines = [];
    server = createMcpHttpServer({
      bearerToken: BEARER,
      store,
      steering: new InMemorySteeringStore(),
      clock,
      logger: {
        info: (m) => logLines.push(m),
        error: (m) => logLines.push(m),
      },
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
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        client_name: "Claude.ai",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBe("z".repeat(64));
    expect(body.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    expect(await authStore.getClient("z".repeat(64))).toBeDefined();
  });

  it("POST /oauth/register rejects a non-allowlisted redirect and answers no-store", async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://evil.example/cb"],
        client_name: "Claude",
      }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await authStore.listClients()).toHaveLength(0);
  });

  it("logs a rejected DCR redirect as one escaped line so the operator can extend the allowlist", async () => {
    await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://new.example/cb\nFAKE log_line"],
      }),
    });
    const line = logLines.find((l) => l.startsWith("oauth_dcr_redirect_rejected"));
    expect(line).toBeDefined();
    expect(line).toContain("new.example");
    expect(line).not.toContain("\n");
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
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
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
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      response_type: "code",
      code_challenge: "ccccccccccccccccccccccccccccccccccccccccccc",
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
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: "ccccccccccccccccccccccccccccccccccccccccccc",
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
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: "ccccccccccccccccccccccccccccccccccccccccccc",
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

  const expectHardenedHtmlHeaders = (res: Response): void => {
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  };

  it("consent page carries anti-framing / no-store / no-referrer headers", async () => {
    const res = await fetch(authorizeUrl());
    expect(res.status).toBe(200);
    expectHardenedHtmlHeaders(res);
  });

  it("authorize error page carries the same hardening headers", async () => {
    const res = await fetch(`${baseUrl}/oauth/authorize?client_id=nope`);
    expect(res.status).toBe(400);
    expectHardenedHtmlHeaders(res);
  });

  it("wrong-password page carries the same hardening headers", async () => {
    const params = new URLSearchParams({
      client_id: "cl-1",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: "ccccccccccccccccccccccccccccccccccccccccccc",
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
    expectHardenedHtmlHeaders(res);
  });

  it("POST /oauth/authorize with a tampered client_id mints no code even with the right password", async () => {
    const params = new URLSearchParams({
      client_id: "attacker",
      redirect_uri: "https://evil.example/cb",
      code_challenge: "ccccccccccccccccccccccccccccccccccccccccccc",
      code_challenge_method: "S256",
      password: "hunter2",
    });
    const res = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
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
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      createdAt: new Date("2026-04-20T09:00:00Z"),
    });
    await authStore.saveAuthCode({
      code: "auth-code-fixed",
      clientId: "cl-token",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
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
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
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

  it("POST /oauth/token responses are no-store", async () => {
    const body = new URLSearchParams({ grant_type: "authorization_code", code: "x" });
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("POST /oauth/token with bad code returns 400 invalid_grant", async () => {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: "wrong-code",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
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

  const makeServer = async (): Promise<void> => {
    store = new InMemoryMessageStore();
    authStore = new InMemoryAuthStore();
    clock = new FakeClock(NOW);

    await authStore.registerClient({
      clientId: "cl-guard",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
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

  it("rejects the static bearer on a listener with OAuth configured (public path is OAuth-only)", async () => {
    await makeServer();
    const res = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BEARER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });
});

describe("createMcpHttpServer server timeouts", () => {
  it("applies default request/headers/keepAlive timeouts when no options provided", () => {
    const server = createMcpHttpServer({
      bearerToken: BEARER,
      store: new InMemoryMessageStore(),
      steering: new InMemorySteeringStore(),
      clock: new FakeClock(new Date("2026-04-25T00:00:00Z")),
    });
    expect(server.requestTimeout).toBe(60_000);
    expect(server.headersTimeout).toBe(30_000);
    expect(server.keepAliveTimeout).toBe(65_000);
    expect(server.timeout).toBe(0);
  });

  it("applies caller-overridden timeouts", () => {
    const server = createMcpHttpServer({
      bearerToken: BEARER,
      store: new InMemoryMessageStore(),
      steering: new InMemorySteeringStore(),
      clock: new FakeClock(new Date("2026-04-25T00:00:00Z")),
      timeouts: { requestMs: 1000, headersMs: 500, keepAliveMs: 2000 },
    });
    expect(server.requestTimeout).toBe(1000);
    expect(server.headersTimeout).toBe(500);
    expect(server.keepAliveTimeout).toBe(2000);
    expect(server.timeout).toBe(0);
  });
});

describe("createMcpHttpServer abuse limits (body caps, rate limits, crash safety)", () => {
  const ADMIN_HASH = "plain:hunter2";
  const CB = "https://claude.ai/api/mcp/auth_callback";
  const CHALLENGE = "c".repeat(43);
  let server: Server;
  let baseUrl: string;
  let verifyCalls: number;
  const logs: string[] = [];

  const start = async (
    oauthOverrides: Record<string, unknown> = {},
    authStore: InMemoryAuthStore = new InMemoryAuthStore(),
  ): Promise<InMemoryAuthStore> => {
    verifyCalls = 0;
    const plain = new PlaintextPasswordHasher();
    await authStore.registerClient({
      clientId: "cl-1",
      redirectUris: [CB],
      createdAt: new Date("2026-04-20T09:00:00Z"),
    });
    server = createMcpHttpServer({
      bearerToken: BEARER,
      store: new InMemoryMessageStore(),
      steering: new InMemorySteeringStore(),
      clock: new FakeClock(new Date("2026-04-20T10:00:00Z")),
      logger: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
      oauth: {
        publicUrl: PUBLIC_URL,
        authStore,
        ids: fixedIds("id-fixed"),
        adminPasswordHash: ADMIN_HASH,
        hasher: {
          hash: plain.hash.bind(plain),
          verify: async (pw: string, h: string) => {
            verifyCalls += 1;
            return plain.verify(pw, h);
          },
        },
        ...oauthOverrides,
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return authStore;
  };

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  const big = "x".repeat(64 * 1024 + 1);
  const authorizeForm = (password = "wrong", ip?: string) =>
    fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(ip !== undefined ? { "X-Forwarded-For": ip } : {}),
      },
      body: new URLSearchParams({
        client_id: "cl-1",
        redirect_uri: CB,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        password,
      }).toString(),
      redirect: "manual",
    });

  it.each([
    ["/oauth/register", "application/json"],
    ["/oauth/token", "application/x-www-form-urlencoded"],
    ["/oauth/authorize", "application/x-www-form-urlencoded"],
  ])("POST %s over 64 KB → 413 and the connection is closed", async (path, ct) => {
    const authStore = await start();
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": ct },
      body: big,
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
    expect(await res.json()).toEqual({
      error: "invalid_request",
      error_description: "request body too large",
    });
    expect(await authStore.countClients()).toBe(1);
  });

  it("POST /mcp over 1 MiB → 413 even with a valid credential", async () => {
    await start(); // keeps afterEach symmetric
    const bare = createMcpHttpServer({
      bearerToken: BEARER,
      store: new InMemoryMessageStore(),
      steering: new InMemorySteeringStore(),
      clock: new FakeClock(new Date("2026-04-20T10:00:00Z")),
    });
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", () => resolve()));
    try {
      const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}/mcp`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${BEARER}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(1024 * 1024) }),
      });
      expect(res.status).toBe(413);
    } finally {
      await new Promise<void>((r) => bare.close(() => r()));
    }
  });

  it("the 11th authorize POST from one IP within a minute → 429 + Retry-After, without running the password hash", async () => {
    await start();
    for (let i = 0; i < 10; i++) {
      expect((await authorizeForm("wrong", "203.0.113.9")).status).toBe(401);
    }
    const limited = await authorizeForm("wrong", "203.0.113.9");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(verifyCalls).toBe(10);
    // Another client IP (behind the loopback proxy) has its own bucket.
    expect((await authorizeForm("wrong", "198.51.100.4")).status).toBe(401);
  });

  it("rate-limits /oauth/register and /oauth/token per client IP", async () => {
    await start({
      rateLimits: {
        register: { windowMs: 3_600_000, perKey: 1, global: 100 },
        token: { windowMs: 60_000, perKey: 1, global: 100 },
      },
    });
    const register = () =>
      fetch(`${baseUrl}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [CB] }),
      });
    expect((await register()).status).toBe(201);
    const r2 = await register();
    expect(r2.status).toBe(429);
    expect(await r2.json()).toEqual({
      error: "rate_limited",
      error_description: "too many requests",
    });

    const token = () =>
      fetch(`${baseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=x&code_verifier=y",
      });
    expect((await token()).status).toBe(400);
    expect((await token()).status).toBe(429);
  });

  it("caps registered clients via oauth.maxClients", async () => {
    await start({ maxClients: 1 });
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CB] }),
    });
    expect(res.status).toBe(503);
  });

  it("a throwing store yields 500 on every OAuth route instead of an unhandled rejection", async () => {
    const authStore = new InMemoryAuthStore();
    await start({}, authStore);
    const boom = (): never => {
      throw new Error("db exploded");
    };
    authStore.countClients = boom;
    authStore.getClient = boom;
    authStore.consumeAuthCode = boom;
    const rejections: unknown[] = [];
    const onRejection = (r: unknown): void => {
      rejections.push(r);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const reg = await fetch(`${baseUrl}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [CB] }),
      });
      expect(reg.status).toBe(500);
      expect(await reg.json()).toEqual({ error: "server_error" });
      const get = await fetch(
        `${baseUrl}/oauth/authorize?client_id=cl-1&redirect_uri=${encodeURIComponent(CB)}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
      );
      expect(get.status).toBe(500);
      expect((await authorizeForm("hunter2")).status).toBe(500);
      const tok = await fetch(`${baseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=x&code_verifier=y",
      });
      expect(tok.status).toBe(500);
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
      expect(logs.some((l) => l.startsWith("http_handler_failed") && l.includes("db exploded"))).toBe(true);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

describe("runSafely", () => {
  it("destroys the socket when the handler throws after headers were sent", async () => {
    let destroyed = false;
    const res = {
      headersSent: true,
      destroy: () => {
        destroyed = true;
      },
    } as unknown as ServerResponse;
    const logs: string[] = [];
    runSafely(res, { info: () => {}, error: (m) => logs.push(m) }, async () => {
      throw new Error("mid-stream failure");
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(destroyed).toBe(true);
    expect(logs[0]).toContain("mid-stream failure");
  });

  it("truncates long error messages in the log line and tolerates a missing logger", async () => {
    const res = {
      headersSent: false,
      writeHead: () => {},
      end: () => {},
    } as unknown as ServerResponse;
    const logs: string[] = [];
    runSafely(res, { info: () => {}, error: (m) => logs.push(m) }, async () => {
      throw new Error("y".repeat(1000));
    });
    runSafely(res, undefined, async () => {
      throw new Error("no logger");
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(logs[0]).not.toContain("y".repeat(400));
    expect(logs[0]).toContain("y".repeat(250));
  });

  it("logs a non-Error throw as unknown without crashing", async () => {
    const written: number[] = [];
    const res = {
      headersSent: false,
      writeHead: (status: number) => {
        written.push(status);
      },
      end: () => {},
    } as unknown as ServerResponse;
    const logs: string[] = [];
    runSafely(res, { info: () => {}, error: (m) => logs.push(m) }, async () => {
      throw "a string";
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual([500]);
    expect(logs[0]).toContain("unknown");
  });
});
