import { describe, expect, it } from "vitest";
import {
  DuplicateClientIdError,
  type AuthStore,
  type OAuthAuthCodeRecord,
  type OAuthClientRegistration,
  type OAuthTokenPair,
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
    const ACCESS_EXPIRES = new Date(TOKEN_NOW.getTime() + 3600 * 1000);
    const REFRESH_EXPIRES = new Date(TOKEN_NOW.getTime() + 30 * 24 * 3600 * 1000);

    const tokenPair = (overrides?: Partial<OAuthTokenPair>): OAuthTokenPair => ({
      accessToken: "at-1",
      refreshToken: "rt-1",
      clientId: "abc123",
      scope: "mcp",
      accessExpiresAt: ACCESS_EXPIRES,
      refreshExpiresAt: REFRESH_EXPIRES,
      createdAt: TOKEN_NOW,
      ...overrides,
    });

    it("saveTokenPair persists both access and refresh tokens", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      const got = await store.getAccessToken("at-1", TOKEN_NOW);
      expect(got).toBeDefined();
      expect(got?.accessToken).toBe("at-1");
      expect(got?.refreshToken).toBe("rt-1");
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

    const HOUR_MS = 3600 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    const REFRESH_NOW = new Date(TOKEN_NOW.getTime() + HOUR_MS);
    const NEW_ACCESS_EXPIRES = new Date(REFRESH_NOW.getTime() + DAY_MS);
    const NEW_REFRESH_EXPIRES = new Date(REFRESH_NOW.getTime() + 30 * DAY_MS);

    it("refreshAccessToken updates the access token, keeps the refresh token, and slides both expiries", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      const got = await store.refreshAccessToken(
        "rt-1",
        REFRESH_NOW,
        "at-2",
        NEW_ACCESS_EXPIRES,
        NEW_REFRESH_EXPIRES,
      );
      expect(got).toBeDefined();
      expect(got?.accessToken).toBe("at-2");
      expect(got?.refreshToken).toBe("rt-1");
      expect(got?.accessExpiresAt).toEqual(NEW_ACCESS_EXPIRES);
      expect(got?.refreshExpiresAt).toEqual(NEW_REFRESH_EXPIRES);
      expect(got?.scope).toBe("mcp");
    });

    it("refreshAccessToken invalidates the previous access token and validates the new one", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      await store.refreshAccessToken(
        "rt-1",
        REFRESH_NOW,
        "at-2",
        NEW_ACCESS_EXPIRES,
        NEW_REFRESH_EXPIRES,
      );
      expect(await store.getAccessToken("at-1", REFRESH_NOW)).toBeUndefined();
      const fresh = await store.getAccessToken("at-2", REFRESH_NOW);
      expect(fresh?.accessToken).toBe("at-2");
    });

    it("refreshAccessToken keeps the same refresh token usable again (non-bricking)", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      await store.refreshAccessToken(
        "rt-1",
        REFRESH_NOW,
        "at-2",
        NEW_ACCESS_EXPIRES,
        NEW_REFRESH_EXPIRES,
      );
      const again = await store.refreshAccessToken(
        "rt-1",
        REFRESH_NOW,
        "at-3",
        NEW_ACCESS_EXPIRES,
        NEW_REFRESH_EXPIRES,
      );
      expect(again?.accessToken).toBe("at-3");
      expect(again?.refreshToken).toBe("rt-1");
    });

    it("refreshAccessToken returns undefined for an unknown refresh token", async () => {
      const store = await factory();
      const got = await store.refreshAccessToken(
        "no-such",
        REFRESH_NOW,
        "at-2",
        NEW_ACCESS_EXPIRES,
        NEW_REFRESH_EXPIRES,
      );
      expect(got).toBeUndefined();
    });

    it("refreshAccessToken returns undefined for an expired refresh token and leaves the row intact", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      // refresh already expired, but access token still valid
      await store.saveTokenPair(
        tokenPair({ refreshExpiresAt: new Date(TOKEN_NOW.getTime() - 1) }),
      );
      const got = await store.refreshAccessToken(
        "rt-1",
        TOKEN_NOW,
        "at-2",
        NEW_ACCESS_EXPIRES,
        NEW_REFRESH_EXPIRES,
      );
      expect(got).toBeUndefined();
      // the original access token row is untouched (not deleted/mutated)
      const original = await store.getAccessToken("at-1", TOKEN_NOW);
      expect(original?.accessToken).toBe("at-1");
    });

    it("refreshAccessToken with a mismatching expectedClientId returns undefined and leaves the row intact", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      const got = await store.refreshAccessToken(
        "rt-1",
        TOKEN_NOW,
        "at-2",
        ACCESS_EXPIRES,
        REFRESH_EXPIRES,
        "other-client",
      );
      expect(got).toBeUndefined();
      expect(await store.getAccessToken("at-1", TOKEN_NOW)).toBeDefined();
      expect(await store.getAccessToken("at-2", TOKEN_NOW)).toBeUndefined();
    });

    it("refreshAccessToken with a matching expectedClientId refreshes", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      const got = await store.refreshAccessToken(
        "rt-1",
        TOKEN_NOW,
        "at-2",
        ACCESS_EXPIRES,
        REFRESH_EXPIRES,
        "abc123",
      );
      expect(got?.accessToken).toBe("at-2");
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
