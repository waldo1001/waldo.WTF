import { describe, expect, it } from "vitest";
import {
  DuplicateClientIdError,
  type AuthStore,
  type OAuthAuthCodeRecord,
  type OAuthClientRegistration,
  type OAuthGrant,
  type OAuthTokenPair,
  type RefreshRequest,
} from "./auth-store.js";

export type AuthStoreFactory = () => AuthStore | Promise<AuthStore>;

const reg = (
  overrides: Partial<OAuthClientRegistration> &
    Pick<OAuthClientRegistration, "clientId">,
): OAuthClientRegistration => ({
  redirectUris: ["https://claude.ai/cb"],
  createdAt: new Date("2026-04-20T10:00:00Z"),
  ...overrides,
});

export function runAuthStoreContract(
  label: string,
  factory: AuthStoreFactory,
): void {
  describe(`AuthStore contract (${label})`, () => {
    it("registerClient persists a record retrievable by getClient", async () => {
      const store = await factory();
      await store.registerClient(
        reg({
          clientId: "abc123",
          clientName: "Claude.ai",
          redirectUris: ["https://claude.ai/cb"],
        }),
      );
      const got = await store.getClient("abc123");
      expect(got).toEqual({
        clientId: "abc123",
        clientName: "Claude.ai",
        redirectUris: ["https://claude.ai/cb"],
        createdAt: new Date("2026-04-20T10:00:00Z"),
      });
    });

    it("getClient returns undefined for an unknown client_id", async () => {
      const store = await factory();
      expect(await store.getClient("missing")).toBeUndefined();
    });

    it("registerClient leaves clientName undefined when omitted", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "no-name" }));
      const got = await store.getClient("no-name");
      expect(got?.clientName).toBeUndefined();
    });

    it("registerClient throws DuplicateClientIdError on duplicate client_id", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "dup" }));
      await expect(
        store.registerClient(reg({ clientId: "dup" })),
      ).rejects.toBeInstanceOf(DuplicateClientIdError);
    });

    it("listClients returns rows ordered by createdAt ASC", async () => {
      const store = await factory();
      await store.registerClient(
        reg({
          clientId: "second",
          createdAt: new Date("2026-04-20T11:00:00Z"),
        }),
      );
      await store.registerClient(
        reg({
          clientId: "first",
          createdAt: new Date("2026-04-20T10:00:00Z"),
        }),
      );
      await store.registerClient(
        reg({
          clientId: "third",
          createdAt: new Date("2026-04-20T12:00:00Z"),
        }),
      );
      const rows = await store.listClients();
      expect(rows.map((r) => r.clientId)).toEqual(["first", "second", "third"]);
    });

    it("listClients returns [] on an empty store", async () => {
      const store = await factory();
      expect(await store.listClients()).toEqual([]);
    });

    const codeRec = (overrides?: Partial<OAuthAuthCodeRecord>): OAuthAuthCodeRecord => ({
      code: "test-code",
      clientId: "abc123",
      redirectUri: "https://claude.ai/cb",
      scope: "mcp",
      codeChallenge: "challenge-abc",
      expiresAt: new Date("2026-04-20T10:10:00Z"),
      createdAt: new Date("2026-04-20T10:00:00Z"),
      ...overrides,
    });

    const NOW = new Date("2026-04-20T10:05:00Z");

    it("saveAuthCode persists code retrievable via consumeAuthCode", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveAuthCode(codeRec());
      const got = await store.consumeAuthCode("test-code", NOW);
      expect(got).toBeDefined();
      expect(got?.code).toBe("test-code");
      expect(got?.codeChallenge).toBe("challenge-abc");
    });

    it("consumeAuthCode deletes the code (second call returns undefined)", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveAuthCode(codeRec());
      await store.consumeAuthCode("test-code", NOW);
      const second = await store.consumeAuthCode("test-code", NOW);
      expect(second).toBeUndefined();
    });

    it("consumeAuthCode returns undefined for unknown code", async () => {
      const store = await factory();
      const got = await store.consumeAuthCode("no-such-code", NOW);
      expect(got).toBeUndefined();
    });

    it("consumeAuthCode returns undefined for expired code", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveAuthCode(codeRec({ expiresAt: new Date("2026-04-20T09:00:00Z") }));
      const afterExpiry = new Date("2026-04-20T10:00:00Z");
      const got = await store.consumeAuthCode("test-code", afterExpiry);
      expect(got).toBeUndefined();
    });

    it("saveAuthCode round-trips state when present", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveAuthCode(codeRec({ state: "xyz-state" }));
      const got = await store.consumeAuthCode("test-code", NOW);
      expect(got?.state).toBe("xyz-state");
    });

    it("saveAuthCode stores undefined state as absent", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveAuthCode(codeRec({ state: undefined }));
      const got = await store.consumeAuthCode("test-code", NOW);
      expect(got?.state).toBeUndefined();
    });

    const TOKEN_NOW = new Date("2026-04-20T10:00:00Z");
    const HOUR_MS = 3600 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    const ACCESS_EXPIRES = new Date(TOKEN_NOW.getTime() + HOUR_MS);
    const REFRESH_EXPIRES = new Date(TOKEN_NOW.getTime() + 30 * DAY_MS);
    const MAX_GRANT_MS = 180 * DAY_MS;

    const tokenPair = (overrides?: Partial<OAuthTokenPair>): OAuthTokenPair => ({
      accessToken: "at-1",
      refreshToken: "rt-1",
      clientId: "abc123",
      scope: "mcp",
      accessExpiresAt: ACCESS_EXPIRES,
      refreshExpiresAt: REFRESH_EXPIRES,
      createdAt: TOKEN_NOW,
      grantCreatedAt: TOKEN_NOW,
      ...overrides,
    });

    const refresh = (
      store: AuthStore,
      overrides: Partial<RefreshRequest> = {},
    ): Promise<OAuthGrant | undefined> =>
      store.refreshAccessToken({
        refreshToken: "rt-1",
        now: REFRESH_NOW,
        newAccessToken: "at-2",
        accessTtlMs: DAY_MS,
        refreshTtlMs: 30 * DAY_MS,
        maxGrantMs: MAX_GRANT_MS,
        ...overrides,
      });

    it("getAccessToken returns the grant (no token values) for a saved pair", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      const got = await store.getAccessToken("at-1", TOKEN_NOW);
      expect(got).toEqual({
        clientId: "abc123",
        scope: "mcp",
        accessExpiresAt: ACCESS_EXPIRES,
        refreshExpiresAt: REFRESH_EXPIRES,
        createdAt: TOKEN_NOW,
        grantCreatedAt: TOKEN_NOW,
      });
      expect(JSON.stringify(got)).not.toMatch(/at-1|rt-1/);
    });

    it("getAccessToken does not accept the refresh token as an access token", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      expect(await store.getAccessToken("rt-1", TOKEN_NOW)).toBeUndefined();
    });

    it("getAccessToken returns undefined for unknown token", async () => {
      const store = await factory();
      const got = await store.getAccessToken("no-such", TOKEN_NOW);
      expect(got).toBeUndefined();
    });

    it("getAccessToken returns undefined for expired token", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(
        tokenPair({ accessExpiresAt: new Date(TOKEN_NOW.getTime() - 1) }),
      );
      const afterExpiry = new Date(TOKEN_NOW.getTime() + 1);
      const got = await store.getAccessToken("at-1", afterExpiry);
      expect(got).toBeUndefined();
    });

    const REFRESH_NOW = new Date(TOKEN_NOW.getTime() + HOUR_MS);

    it("refreshAccessToken swaps the access token and slides both expiries by their TTLs", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      const got = await refresh(store);
      expect(got).toEqual({
        clientId: "abc123",
        scope: "mcp",
        accessExpiresAt: new Date(REFRESH_NOW.getTime() + DAY_MS),
        refreshExpiresAt: new Date(REFRESH_NOW.getTime() + 30 * DAY_MS),
        createdAt: TOKEN_NOW,
        grantCreatedAt: TOKEN_NOW,
      });
    });

    it("refreshAccessToken invalidates the previous access token and validates the new one", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      await refresh(store);
      expect(await store.getAccessToken("at-1", REFRESH_NOW)).toBeUndefined();
      expect(await store.getAccessToken("at-2", REFRESH_NOW)).toBeDefined();
    });

    it("refreshAccessToken keeps the same refresh token usable again (non-bricking)", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      await refresh(store);
      const again = await refresh(store, { newAccessToken: "at-3" });
      expect(again).toBeDefined();
      expect(await store.getAccessToken("at-3", REFRESH_NOW)).toBeDefined();
      expect(await store.getAccessToken("at-2", REFRESH_NOW)).toBeUndefined();
    });

    it("refreshAccessToken returns undefined for an unknown refresh token", async () => {
      const store = await factory();
      expect(await refresh(store, { refreshToken: "no-such" })).toBeUndefined();
    });

    it("refreshAccessToken does not accept the access token as a refresh token", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      expect(await refresh(store, { refreshToken: "at-1" })).toBeUndefined();
    });

    it("refreshAccessToken returns undefined for an expired refresh token and leaves the row intact", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      // refresh already expired, but access token still valid
      await store.saveTokenPair(
        tokenPair({ refreshExpiresAt: new Date(TOKEN_NOW.getTime() - 1) }),
      );
      expect(await refresh(store, { now: TOKEN_NOW })).toBeUndefined();
      expect(await store.getAccessToken("at-1", TOKEN_NOW)).toBeDefined();
    });

    it("refreshAccessToken with a mismatching expectedClientId returns undefined and leaves the row intact", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      expect(
        await refresh(store, { now: TOKEN_NOW, expectedClientId: "other-client" }),
      ).toBeUndefined();
      expect(await store.getAccessToken("at-1", TOKEN_NOW)).toBeDefined();
      expect(await store.getAccessToken("at-2", TOKEN_NOW)).toBeUndefined();
    });

    it("refreshAccessToken with a matching expectedClientId refreshes", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      expect(await refresh(store, { expectedClientId: "abc123" })).toBeDefined();
    });

    it("refreshAccessToken never extends either expiry past grantCreatedAt + maxGrantMs", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      const grantEnd = new Date(TOKEN_NOW.getTime() + MAX_GRANT_MS);
      const nearEnd = new Date(grantEnd.getTime() - HOUR_MS);
      await store.saveTokenPair(
        tokenPair({ refreshExpiresAt: new Date(grantEnd.getTime() + DAY_MS) }),
      );
      const got = await refresh(store, { now: nearEnd });
      expect(got?.accessExpiresAt).toEqual(grantEnd);
      expect(got?.refreshExpiresAt).toEqual(grantEnd);
    });

    it("refreshAccessToken refuses once the absolute grant lifetime is reached", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      const grantEnd = new Date(TOKEN_NOW.getTime() + MAX_GRANT_MS);
      await store.saveTokenPair(
        tokenPair({ refreshExpiresAt: new Date(grantEnd.getTime() + DAY_MS) }),
      );
      expect(await refresh(store, { now: grantEnd })).toBeUndefined();
    });

    it("saveTokenPair prunes rows whose refresh token expired by the new pair's createdAt", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(
        tokenPair({
          accessToken: "old-at",
          refreshToken: "old-rt",
          accessExpiresAt: new Date(TOKEN_NOW.getTime() + 60 * DAY_MS),
          refreshExpiresAt: new Date(TOKEN_NOW.getTime() + DAY_MS),
        }),
      );
      const later = new Date(TOKEN_NOW.getTime() + 2 * DAY_MS);
      await store.saveTokenPair(tokenPair({ createdAt: later, grantCreatedAt: later }));
      // old-at's access expiry is still in the future, so only pruning can hide it.
      expect(await store.getAccessToken("old-at", later)).toBeUndefined();
    });

    it("expiry instants are exclusive: a token or code is dead exactly at its expiry time", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      expect(await store.getAccessToken("at-1", ACCESS_EXPIRES)).toBeUndefined();
      expect(await refresh(store, { now: REFRESH_EXPIRES })).toBeUndefined();
      await store.saveAuthCode({
        code: "edge",
        clientId: "abc123",
        redirectUri: "https://claude.ai/cb",
        scope: "mcp",
        codeChallenge: "c",
        expiresAt: new Date(TOKEN_NOW.getTime() + HOUR_MS),
        createdAt: TOKEN_NOW,
      });
      expect(
        await store.consumeAuthCode("edge", new Date(TOKEN_NOW.getTime() + HOUR_MS)),
      ).toBeUndefined();
    });

    it("countClients counts registered clients", async () => {
      const store = await factory();
      expect(await store.countClients()).toBe(0);
      await store.registerClient(reg({ clientId: "c1" }));
      await store.registerClient(reg({ clientId: "c2" }));
      expect(await store.countClients()).toBe(2);
    });

    it("pruneUnusedClients deletes only clients older than the cutoff with no codes and no tokens", async () => {
      const store = await factory();
      const old = new Date("2026-04-01T00:00:00Z");
      const cutoff = new Date("2026-04-10T00:00:00Z");
      await store.registerClient(reg({ clientId: "old-unused", createdAt: old }));
      await store.registerClient(reg({ clientId: "old-with-code", createdAt: old }));
      await store.registerClient(reg({ clientId: "old-with-token", createdAt: old }));
      await store.registerClient(
        reg({ clientId: "new-unused", createdAt: new Date("2026-04-15T00:00:00Z") }),
      );
      await store.saveAuthCode({
        code: "live-code",
        clientId: "old-with-code",
        redirectUri: "https://claude.ai/cb",
        scope: "mcp",
        codeChallenge: "c",
        expiresAt: new Date("2026-04-15T00:10:00Z"),
        createdAt: new Date("2026-04-15T00:00:00Z"),
      });
      await store.saveTokenPair({
        accessToken: "at-x",
        refreshToken: "rt-x",
        clientId: "old-with-token",
        scope: "mcp",
        accessExpiresAt: new Date("2026-05-01T00:00:00Z"),
        refreshExpiresAt: new Date("2026-05-01T00:00:00Z"),
        createdAt: old,
        grantCreatedAt: old,
      });
      expect(await store.pruneUnusedClients(cutoff)).toBe(1);
      expect(await store.getClient("old-unused")).toBeUndefined();
      expect(await store.getClient("old-with-code")).toBeDefined();
      expect(await store.getClient("old-with-token")).toBeDefined();
      expect(await store.getClient("new-unused")).toBeDefined();
    });

    it("saveAuthCode prunes codes that already expired at the new code's createdAt", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      const base = {
        clientId: "abc123",
        redirectUri: "https://claude.ai/cb",
        scope: "mcp",
        codeChallenge: "c",
      };
      await store.saveAuthCode({
        ...base,
        code: "stale",
        createdAt: new Date("2026-04-20T09:00:00Z"),
        expiresAt: new Date("2026-04-20T09:10:00Z"),
      });
      await store.saveAuthCode({
        ...base,
        code: "fresh",
        createdAt: new Date("2026-04-20T10:00:00Z"),
        expiresAt: new Date("2026-04-20T10:10:00Z"),
      });
      // A pruned code consumed "in the past" would still be returned if it existed.
      expect(await store.consumeAuthCode("stale", new Date("2026-04-20T09:05:00Z"))).toBeUndefined();
      expect(await store.consumeAuthCode("fresh", new Date("2026-04-20T10:05:00Z"))).toBeDefined();
    });

    it("listClientsWithStats reports active grants and the latest grant start per client, never token values", async () => {
      const store = await factory();
      const t0 = new Date("2026-04-01T00:00:00Z");
      const now = new Date("2026-04-20T00:00:00Z");
      await store.registerClient(reg({ clientId: "busy", clientName: "Claude", createdAt: t0 }));
      await store.registerClient(
        reg({ clientId: "idle", createdAt: new Date(t0.getTime() + 1) }),
      );
      const pair = (n: string, grantAt: Date, refreshExp: Date): OAuthTokenPair => ({
        accessToken: `at-${n}`,
        refreshToken: `rt-${n}`,
        clientId: "busy",
        scope: "mcp",
        accessExpiresAt: refreshExp,
        refreshExpiresAt: refreshExp,
        createdAt: t0,
        grantCreatedAt: grantAt,
      });
      await store.saveTokenPair(pair("a", t0, new Date("2026-05-01T00:00:00Z")));
      await store.saveTokenPair(
        pair("b", new Date("2026-04-10T00:00:00Z"), new Date("2026-05-02T00:00:00Z")),
      );
      await store.saveTokenPair(pair("dead", t0, new Date("2026-04-15T00:00:00Z")));

      const got = await store.listClientsWithStats(now);
      expect(got.map((c) => c.client.clientId)).toEqual(["busy", "idle"]);
      expect(got[0]?.activeGrants).toBe(2);
      expect(got[0]?.lastGrantAt).toEqual(new Date("2026-04-10T00:00:00Z"));
      expect(got[1]?.activeGrants).toBe(0);
      expect(got[1]?.lastGrantAt).toBeUndefined();
      expect(JSON.stringify(got)).not.toMatch(/at-|rt-/);
    });

    it("revokeClient deletes the client with all its tokens and codes; returns false for an unknown id", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.registerClient(reg({ clientId: "keep" }));
      await store.saveTokenPair(tokenPair());
      await store.saveTokenPair(
        tokenPair({ accessToken: "keep-at", refreshToken: "keep-rt", clientId: "keep" }),
      );
      await store.saveAuthCode({
        code: "pending",
        clientId: "abc123",
        redirectUri: "https://claude.ai/cb",
        scope: "mcp",
        codeChallenge: "c",
        expiresAt: new Date(TOKEN_NOW.getTime() + HOUR_MS),
        createdAt: TOKEN_NOW,
      });

      expect(await store.revokeClient("abc123")).toBe(true);

      expect(await store.getClient("abc123")).toBeUndefined();
      expect(await store.getAccessToken("at-1", TOKEN_NOW)).toBeUndefined();
      expect(await refresh(store, { now: TOKEN_NOW })).toBeUndefined();
      expect(await store.consumeAuthCode("pending", TOKEN_NOW)).toBeUndefined();
      expect(await store.getAccessToken("keep-at", TOKEN_NOW)).toBeDefined();
      expect(await store.revokeClient("abc123")).toBe(false);
    });

    it("registerClient round-trips multiple redirect URIs", async () => {
      const store = await factory();
      await store.registerClient(
        reg({
          clientId: "multi",
          redirectUris: [
            "https://claude.ai/cb",
            "http://localhost:1234/cb",
          ],
        }),
      );
      const got = await store.getClient("multi");
      expect(got?.redirectUris).toEqual([
        "https://claude.ai/cb",
        "http://localhost:1234/cb",
      ]);
    });
  });
}
