import { describe, expect, it, beforeEach } from "vitest";
import { handleAuthorizeGet, handleAuthorizePost } from "./authorize.js";
import { InMemoryAuthStore } from "../../testing/in-memory-auth-store.js";
import { PlaintextPasswordHasher } from "./password.js";
import { FakeClock } from "../../testing/fake-clock.js";
import type { RandomIdSource } from "./ids.js";
import { DEFAULT_REDIRECT_ALLOWLIST } from "./redirect-allowlist.js";

const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
// RFC 7636: a base64url SHA-256 digest is 43 chars.
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const OTHER_CHALLENGE = "x".repeat(43);
const redirectAllowlist = DEFAULT_REDIRECT_ALLOWLIST;

const ADMIN_HASH = "plain:hunter2";
const hasher = new PlaintextPasswordHasher();
const fixedId = (id: string): RandomIdSource => ({ next: () => id });

const NOW = new Date("2026-04-20T10:00:00Z");

const makeStore = async (): Promise<InMemoryAuthStore> => {
  const store = new InMemoryAuthStore();
  await store.registerClient({
    clientId: "client-abc",
    redirectUris: [CLAUDE_CB],
    createdAt: new Date("2026-04-20T09:00:00Z"),
    clientName: "Claude.ai",
  });
  return store;
};

const validGetParams = {
  client_id: "client-abc",
  redirect_uri: CLAUDE_CB,
  response_type: "code",
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  scope: "mcp",
  state: "some-state",
};

describe("handleAuthorizeGet", () => {
  it("returns 200 HTML with consent form for valid params", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({ store, redirectAllowlist, params: validGetParams });
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
    expect(res.body).toContain("<form");
    expect(res.body).toContain("client-abc");
  });

  it("returns 400 for unknown client_id", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({
      store,
      redirectAllowlist,
      params: { ...validGetParams, client_id: "attacker-client-id" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("unknown client");
    expect(res.body).not.toContain("attacker-client-id");
  });

  it("returns 400 for unregistered redirect_uri", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({
      store,
      redirectAllowlist,
      params: { ...validGetParams, redirect_uri: "https://evil.example/cb" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("redirect_uri");
    expect(res.body).not.toContain("evil.example");
  });

  it("returns 400 for missing code_challenge", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({
      store,
      redirectAllowlist,
      params: { ...validGetParams, code_challenge: "" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for code_challenge_method != S256", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({
      store,
      redirectAllowlist,
      params: { ...validGetParams, code_challenge_method: "plain" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("S256");
  });

  it("returns 400 for response_type != code", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({
      store,
      redirectAllowlist,
      params: { ...validGetParams, response_type: "token" },
    });
    expect(res.status).toBe(400);
  });

  it("renders client_name in the consent form", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({ store, redirectAllowlist, params: validGetParams });
    expect(res.body).toContain("Claude.ai");
  });

  it("falls back to client_id when client_name is absent", async () => {
    const store = new InMemoryAuthStore();
    await store.registerClient({
      clientId: "no-name-client",
      redirectUris: [CLAUDE_CB],
      createdAt: new Date("2026-04-20T09:00:00Z"),
    });
    const res = await handleAuthorizeGet({
      store,
      redirectAllowlist,
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
      redirectAllowlist,
      params: { ...paramsWithoutScope, scope: undefined },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("mcp");
  });

  it("renders form without state hidden field when state is absent", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({
      store,
      redirectAllowlist,
      params: { ...validGetParams, state: undefined },
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('name="state"');
  });

  it("rejects a pre-existing client whose registered redirect is no longer allowlisted", async () => {
    const store = new InMemoryAuthStore();
    await store.registerClient({
      clientId: "legacy-client",
      clientName: "Claude",
      redirectUris: ["https://evil.example/cb"],
      createdAt: new Date("2026-04-20T09:00:00Z"),
    });
    const res = await handleAuthorizeGet({
      store,
      redirectAllowlist,
      params: {
        ...validGetParams,
        client_id: "legacy-client",
        redirect_uri: "https://evil.example/cb",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body).not.toContain("<form");
  });

  it("rejects a malformed code_challenge (not 43-128 base64url chars)", async () => {
    const store = await makeStore();
    for (const bad of ["short", "a".repeat(129), "+".repeat(43)]) {
      const res = await handleAuthorizeGet({
        store,
        redirectAllowlist,
        params: { ...validGetParams, code_challenge: bad },
      });
      expect(res.status).toBe(400);
    }
  });

  it("shows the redirect host prominently and labels the client name as self-declared", async () => {
    const store = await makeStore();
    const res = await handleAuthorizeGet({ store, redirectAllowlist, params: validGetParams });
    expect(res.body).toMatch(/sent to:(?:\s|<[^>]*>)*https:\/\/claude\.ai</i);
    expect(res.body).toMatch(/self-declared/i);
  });

  it("shows the loopback port for native-client callbacks", async () => {
    const store = new InMemoryAuthStore();
    await store.registerClient({
      clientId: "desktop",
      redirectUris: ["http://127.0.0.1:53682/callback"],
      createdAt: new Date("2026-04-20T09:00:00Z"),
    });
    const res = await handleAuthorizeGet({
      store,
      redirectAllowlist,
      params: {
        ...validGetParams,
        client_id: "desktop",
        redirect_uri: "http://127.0.0.1:53682/callback",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("http://127.0.0.1:53682");
  });

  it("escapes a hostile client_name", async () => {
    const store = new InMemoryAuthStore();
    await store.registerClient({
      clientId: "xss",
      clientName: '<script>alert(1)</script>',
      redirectUris: [CLAUDE_CB],
      createdAt: new Date("2026-04-20T09:00:00Z"),
    });
    const res = await handleAuthorizeGet({
      store,
      redirectAllowlist,
      params: { ...validGetParams, client_id: "xss" },
    });
    expect(res.body).not.toContain("<script>");
    expect(res.body).toContain("&lt;script&gt;");
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
      redirectAllowlist,
      formBody: {
        client_id: "client-abc",
        redirect_uri: CLAUDE_CB,
        code_challenge: CHALLENGE,
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
      redirectAllowlist,
      formBody: {
        client_id: "client-abc",
        redirect_uri: CLAUDE_CB,
        code_challenge: CHALLENGE,
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
      redirectAllowlist,
      formBody: {
        client_id: "client-abc",
        redirect_uri: CLAUDE_CB,
        code_challenge: CHALLENGE,
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
      redirectAllowlist,
      formBody: {
        client_id: "client-abc",
        redirect_uri: CLAUDE_CB,
        code_challenge: OTHER_CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp",
        password: "hunter2",
      },
    });
    const record = await store.consumeAuthCode("stored-code", NOW);
    expect(record).toBeDefined();
    expect(record?.codeChallenge).toBe(OTHER_CHALLENGE);
  });

  it("with wrong password returns 401 HTML", async () => {
    const res = await handleAuthorizePost({
      store,
      hasher,
      adminPasswordHash: ADMIN_HASH,
      ids: fixedId("code-xyz"),
      clock,
      redirectAllowlist,
      formBody: {
        client_id: "client-abc",
        redirect_uri: CLAUDE_CB,
        code_challenge: CHALLENGE,
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
      redirectAllowlist,
      formBody: {
        client_id: "client-abc",
        redirect_uri: CLAUDE_CB,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        scope: "mcp",
        password: "hunter2",
      },
    });
    expect(res.status).toBe(503);
  });

  const goodForm = {
    client_id: "client-abc",
    redirect_uri: CLAUDE_CB,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "mcp",
    state: "s",
    password: "hunter2",
  };

  const tamperedCases: ReadonlyArray<[string, Partial<typeof goodForm>]> = [
    ["unknown client_id", { client_id: "attacker-client-id" }],
    ["redirect_uri not registered for the client", { redirect_uri: "https://evil.example/cb" }],
    ["code_challenge_method plain", { code_challenge_method: "plain" }],
    ["missing code_challenge", { code_challenge: "" }],
    ["malformed code_challenge", { code_challenge: "short" }],
  ];

  for (const [label, override] of tamperedCases) {
    it(`with the correct password still rejects a tampered POST: ${label}`, async () => {
      const res = await handleAuthorizePost({
        store,
        hasher,
        adminPasswordHash: ADMIN_HASH,
        ids: fixedId("minted-code"),
        clock,
        redirectAllowlist,
        formBody: { ...goodForm, ...override },
      });
      expect(res.status).toBe(400);
      expect(res.headers["Location"]).toBeUndefined();
      expect(await store.consumeAuthCode("minted-code", NOW)).toBeUndefined();
      expect(res.body).not.toContain("attacker-client-id");
      expect(res.body).not.toContain("evil.example");
    });
  }

  it("rejects a POST for a legacy client whose redirect is not allowlisted", async () => {
    await store.registerClient({
      clientId: "legacy",
      redirectUris: ["https://evil.example/cb"],
      createdAt: new Date("2026-04-20T09:00:00Z"),
    });
    const res = await handleAuthorizePost({
      store,
      hasher,
      adminPasswordHash: ADMIN_HASH,
      ids: fixedId("minted-code"),
      clock,
      redirectAllowlist,
      formBody: { ...goodForm, client_id: "legacy", redirect_uri: "https://evil.example/cb" },
    });
    expect(res.status).toBe(400);
    expect(await store.consumeAuthCode("minted-code", NOW)).toBeUndefined();
  });

  it("validates before checking the password (no scrypt work for a tampered POST)", async () => {
    let verifyCalls = 0;
    const countingHasher = {
      hash: hasher.hash.bind(hasher),
      verify: async (pw: string, h: string) => {
        verifyCalls += 1;
        return hasher.verify(pw, h);
      },
    };
    await handleAuthorizePost({
      store,
      hasher: countingHasher,
      adminPasswordHash: ADMIN_HASH,
      ids: fixedId("minted-code"),
      clock,
      redirectAllowlist,
      formBody: { ...goodForm, client_id: "attacker-client-id" },
    });
    expect(verifyCalls).toBe(0);
  });

  it("escapes &, double and single quotes in the consent page", async () => {
    await store.registerClient({
      clientId: "quotes",
      clientName: `a&b "c" 'd'`,
      redirectUris: [CLAUDE_CB],
      createdAt: new Date("2026-04-20T09:00:00Z"),
    });
    const res = await handleAuthorizeGet({
      store,
      redirectAllowlist,
      params: { ...validGetParams, client_id: "quotes" },
    });
    expect(res.body).toContain("a&amp;b &quot;c&quot; &#39;d&#39;");
  });

  it("wrong-password page round-trips every hidden field so a retry can succeed", async () => {
    const res = await handleAuthorizePost({
      store,
      hasher,
      adminPasswordHash: ADMIN_HASH,
      ids: fixedId("code-xyz"),
      clock,
      redirectAllowlist,
      formBody: { ...goodForm, state: "st-1", scope: "mcp", password: "nope" },
    });
    expect(res.status).toBe(401);
    for (const [name, value] of [
      ["client_id", "client-abc"],
      ["redirect_uri", CLAUDE_CB],
      ["code_challenge", CHALLENGE],
      ["code_challenge_method", "S256"],
      ["scope", "mcp"],
      ["state", "st-1"],
    ]) {
      expect(res.body).toContain(`<input type="hidden" name="${name}" value="${value}">`);
    }
    expect(res.body).toContain("Incorrect password");
  });

  it("the consent page shows no error banner on first render", async () => {
    const res = await handleAuthorizeGet({ store, redirectAllowlist, params: validGetParams });
    expect(res.body).not.toContain('style="color:red"');
  });

  it("stores scope 'mcp' and no state when the form omits both", async () => {
    const { scope: _s, state: _st, ...rest } = goodForm;
    const res = await handleAuthorizePost({
      store,
      hasher,
      adminPasswordHash: ADMIN_HASH,
      ids: fixedId("code-noscope"),
      clock,
      redirectAllowlist,
      formBody: rest,
    });
    expect(res.status).toBe(302);
    expect(res.body).toBe("");
    const rec = await store.consumeAuthCode("code-noscope", NOW);
    expect(rec?.scope).toBe("mcp");
    expect(rec?.state).toBeUndefined();
  });

  it("auth codes expire after 10 minutes", async () => {
    await handleAuthorizePost({
      store,
      hasher,
      adminPasswordHash: ADMIN_HASH,
      ids: fixedId("code-ttl"),
      clock,
      redirectAllowlist,
      formBody: goodForm,
    });
    const rec = await store.consumeAuthCode("code-ttl", NOW);
    expect(rec?.expiresAt).toEqual(new Date(NOW.getTime() + 10 * 60 * 1000));
  });

  it("error responses are HTML", async () => {
    const res = await handleAuthorizePost({
      store,
      hasher,
      adminPasswordHash: ADMIN_HASH,
      ids: fixedId("x"),
      clock,
      redirectAllowlist,
      formBody: { ...goodForm, client_id: "nope" },
    });
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    const res503 = await handleAuthorizePost({
      store,
      hasher,
      adminPasswordHash: undefined,
      ids: fixedId("x"),
      clock,
      redirectAllowlist,
      formBody: goodForm,
    });
    expect(res503.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res503.body).toContain("not configured");
  });
});
