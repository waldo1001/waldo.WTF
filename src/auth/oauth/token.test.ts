import { describe, expect, it, beforeEach } from "vitest";
import { handleTokenRequest } from "./token.js";
import { InMemoryAuthStore } from "../../testing/in-memory-auth-store.js";
import { FakeClock } from "../../testing/fake-clock.js";
import { createHash } from "node:crypto";

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

const makeChallenge = (verifier: string): string =>
  b64url(createHash("sha256").update(verifier).digest());

const VERIFIER = "my-pkce-verifier-long-enough-for-rfc7636-minimum-43-chars";
const CHALLENGE = makeChallenge(VERIFIER);
const NOW = new Date("2026-04-20T10:00:00Z");
const EXPIRES_IN_10 = new Date(NOW.getTime() + 10 * 60 * 1000);

let idCounter = 0;
const seqIds = { next: () => `token-${++idCounter}` };

describe("handleTokenRequest – authorization_code grant", () => {
  let store: InMemoryAuthStore;
  let clock: FakeClock;

  beforeEach(async () => {
    idCounter = 0;
    store = new InMemoryAuthStore();
    clock = new FakeClock(NOW);
    await store.registerClient({
      clientId: "client-1",
      redirectUris: ["https://claude.ai/cb"],
      createdAt: NOW,
    });
    await store.saveAuthCode({
      code: "auth-code-1",
      clientId: "client-1",
      redirectUri: "https://claude.ai/cb",
      scope: "mcp",
      codeChallenge: CHALLENGE,
      expiresAt: EXPIRES_IN_10,
      createdAt: NOW,
    });
  });

  it("issues an access token with a 24h TTL on a valid code", async () => {
    const res = await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "authorization_code",
        code: "auth-code-1",
        redirect_uri: "https://claude.ai/cb",
        code_verifier: VERIFIER,
        client_id: "client-1",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe("token-1");
    expect(res.body.token_type).toBe("Bearer");
    expect(res.body.expires_in).toBe(86400);
    expect(res.body.refresh_token).toBe("token-2");

    // access token expires 24h after issuance
    const stored = await store.getAccessToken(
      "token-1",
      new Date(NOW.getTime() + 24 * 3600 * 1000 - 1),
    );
    expect(stored?.accessExpiresAt).toEqual(
      new Date(NOW.getTime() + 24 * 3600 * 1000),
    );
  });

  it("fails PKCE check → 400 invalid_grant", async () => {
    const res = await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "authorization_code",
        code: "auth-code-1",
        redirect_uri: "https://claude.ai/cb",
        code_verifier: "wrong-verifier-that-does-not-match-the-challenge",
        client_id: "client-1",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("unknown code → 400 invalid_grant", async () => {
    const res = await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "authorization_code",
        code: "no-such-code",
        redirect_uri: "https://claude.ai/cb",
        code_verifier: VERIFIER,
        client_id: "client-1",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("expired code → 400 invalid_grant", async () => {
    const afterExpiry = new FakeClock(
      new Date(EXPIRES_IN_10.getTime() + 1),
    );
    const res = await handleTokenRequest({
      store,
      ids: seqIds,
      clock: afterExpiry,
      body: {
        grant_type: "authorization_code",
        code: "auth-code-1",
        redirect_uri: "https://claude.ai/cb",
        code_verifier: VERIFIER,
        client_id: "client-1",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("redirect_uri mismatch → 400 invalid_grant", async () => {
    const res = await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "authorization_code",
        code: "auth-code-1",
        redirect_uri: "https://evil.example/cb",
        code_verifier: VERIFIER,
        client_id: "client-1",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("code can only be used once (second use returns 400)", async () => {
    await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "authorization_code",
        code: "auth-code-1",
        redirect_uri: "https://claude.ai/cb",
        code_verifier: VERIFIER,
        client_id: "client-1",
      },
    });
    const second = await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "authorization_code",
        code: "auth-code-1",
        redirect_uri: "https://claude.ai/cb",
        code_verifier: VERIFIER,
        client_id: "client-1",
      },
    });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe("invalid_grant");
  });
});

describe("handleTokenRequest – refresh_token grant", () => {
  let store: InMemoryAuthStore;
  let clock: FakeClock;

  beforeEach(async () => {
    idCounter = 0;
    store = new InMemoryAuthStore();
    clock = new FakeClock(NOW);
    await store.registerClient({
      clientId: "client-1",
      redirectUris: ["https://claude.ai/cb"],
      createdAt: NOW,
    });
    await store.saveAuthCode({
      code: "auth-code-1",
      clientId: "client-1",
      redirectUri: "https://claude.ai/cb",
      scope: "mcp",
      codeChallenge: CHALLENGE,
      expiresAt: EXPIRES_IN_10,
      createdAt: NOW,
    });
    await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "authorization_code",
        code: "auth-code-1",
        redirect_uri: "https://claude.ai/cb",
        code_verifier: VERIFIER,
        client_id: "client-1",
      },
    });
  });

  it("refresh issues a new access token and keeps the same refresh token", async () => {
    const res = await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "refresh_token",
        refresh_token: "token-2",
        client_id: "client-1",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.expires_in).toBe(86400);
    // new access token, minted fresh...
    expect(res.body.access_token).toBe("token-3");
    expect(res.body.access_token).not.toBe("token-1");
    // ...but the refresh token is reused, not rotated
    expect(res.body.refresh_token).toBe("token-2");
  });

  it("the same refresh token still works after a refresh (non-bricking)", async () => {
    const first = await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "refresh_token",
        refresh_token: "token-2",
        client_id: "client-1",
      },
    });
    expect(first.status).toBe(200);
    const second = await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "refresh_token",
        refresh_token: "token-2",
        client_id: "client-1",
      },
    });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).toBe("token-2");
    // each refresh mints a distinct new access token
    expect(second.body.access_token).not.toBe(first.body.access_token);
  });

  it("old access token stops validating after a refresh", async () => {
    const res = await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "refresh_token",
        refresh_token: "token-2",
        client_id: "client-1",
      },
    });
    // token-1 was the access token from the authorization_code grant
    expect(await store.getAccessToken("token-1", NOW)).toBeUndefined();
    const fresh = await store.getAccessToken(
      String(res.body.access_token),
      NOW,
    );
    expect(fresh?.accessToken).toBe(res.body.access_token);
  });

  it("unknown refresh_token → 400 invalid_grant", async () => {
    const res = await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "refresh_token",
        refresh_token: "no-such-refresh",
        client_id: "client-1",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("expired refresh_token → 400 invalid_grant", async () => {
    const farFuture = new FakeClock(
      new Date(NOW.getTime() + 31 * 24 * 3600 * 1000),
    );
    const res = await handleTokenRequest({
      store,
      ids: seqIds,
      clock: farFuture,
      body: {
        grant_type: "refresh_token",
        refresh_token: "token-2",
        client_id: "client-1",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });
});

describe("handleTokenRequest – missing required fields", () => {
  const store = new InMemoryAuthStore();
  const clock = new FakeClock(NOW);

  it("authorization_code with empty code → 400 invalid_request", async () => {
    const res = await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "authorization_code",
        code: "",
        redirect_uri: "https://claude.ai/cb",
        code_verifier: VERIFIER,
        client_id: "client-1",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("refresh_token grant with empty refresh_token → 400 invalid_request", async () => {
    const res = await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "refresh_token",
        refresh_token: "",
        client_id: "client-1",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });
});

describe("handleTokenRequest – unsupported grant", () => {
  it("unknown grant_type → 400 unsupported_grant_type", async () => {
    const store = new InMemoryAuthStore();
    const clock = new FakeClock(NOW);
    const res = await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {
        grant_type: "client_credentials",
        client_id: "x",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_grant_type");
  });

  it("missing grant_type → 400 invalid_request", async () => {
    const store = new InMemoryAuthStore();
    const clock = new FakeClock(NOW);
    const res = await handleTokenRequest({
      store,
      ids: seqIds,
      clock,
      body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });
});
