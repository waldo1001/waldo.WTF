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

    it("consumeRefreshToken returns the token pair and deletes it", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(tokenPair());
      const got = await store.consumeRefreshToken("rt-1", TOKEN_NOW);
      expect(got).toBeDefined();
      expect(got?.refreshToken).toBe("rt-1");
      const second = await store.consumeRefreshToken("rt-1", TOKEN_NOW);
      expect(second).toBeUndefined();
    });

    it("consumeRefreshToken returns undefined for unknown token", async () => {
      const store = await factory();
      const got = await store.consumeRefreshToken("no-such", TOKEN_NOW);
      expect(got).toBeUndefined();
    });

    it("consumeRefreshToken returns undefined for expired token", async () => {
      const store = await factory();
      await store.registerClient(reg({ clientId: "abc123" }));
      await store.saveTokenPair(
        tokenPair({ refreshExpiresAt: new Date(TOKEN_NOW.getTime() - 1) }),
      );
      const afterExpiry = new Date(TOKEN_NOW.getTime() + 1);
      const got = await store.consumeRefreshToken("rt-1", afterExpiry);
      expect(got).toBeUndefined();
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
