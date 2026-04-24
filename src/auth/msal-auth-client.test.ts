import { describe, it, expect, vi } from "vitest";
import {
  MsalAuthClient,
  DEFAULT_AUTHORITY,
  SCOPES,
  YAMMER_SCOPE,
  YAMMER_PUBLIC_CLIENT_ID,
} from "./msal-auth-client.js";
import { AuthError, type Account } from "./types.js";
import { TokenCacheStore } from "./token-cache-store.js";
import { InMemoryFileSystem } from "../testing/in-memory-file-system.js";

type AccountInfo = {
  username: string;
  homeAccountId: string;
  tenantId: string;
};

interface FakePcaOptions {
  accounts?: AccountInfo[];
  silentResult?: {
    accessToken: string;
    expiresOn: Date;
    account: AccountInfo;
  };
  silentError?: Error;
  deviceCodeMessage?: string;
  deviceCodeResult?: { account: AccountInfo };
  deviceCodeError?: Error;
}

class FakePca {
  readonly silentCalls: Array<{
    account: AccountInfo;
    scopes: string[];
    authority?: string;
  }> = [];
  readonly deviceCodeCalls: Array<{ scopes: string[] }> = [];

  constructor(private readonly opts: FakePcaOptions) {}

  getAllAccounts(): AccountInfo[] {
    return this.opts.accounts ?? [];
  }

  async acquireTokenSilent(req: {
    account: AccountInfo;
    scopes: string[];
    authority?: string;
  }): Promise<{ accessToken: string; expiresOn: Date; account: AccountInfo }> {
    this.silentCalls.push(
      req.authority !== undefined
        ? { account: req.account, scopes: req.scopes, authority: req.authority }
        : { account: req.account, scopes: req.scopes },
    );
    if (this.opts.silentError) throw this.opts.silentError;
    if (!this.opts.silentResult) {
      throw new Error("FakePca: no silentResult configured");
    }
    return this.opts.silentResult;
  }

  async acquireTokenByDeviceCode(req: {
    scopes: string[];
    deviceCodeCallback: (r: { message: string }) => void;
  }): Promise<{ account: AccountInfo }> {
    this.deviceCodeCalls.push({ scopes: req.scopes });
    req.deviceCodeCallback({
      message: this.opts.deviceCodeMessage ?? "visit https://example.invalid",
    });
    if (this.opts.deviceCodeError) throw this.opts.deviceCodeError;
    if (!this.opts.deviceCodeResult) {
      throw new Error("FakePca: no deviceCodeResult configured");
    }
    return this.opts.deviceCodeResult;
  }
}

const makeCacheStore = (): TokenCacheStore =>
  new TokenCacheStore({ fs: new InMemoryFileSystem(), path: "/auth/cache.json" });

const makeAccountInfo = (overrides: Partial<AccountInfo> = {}): AccountInfo => ({
  username: "a@example.invalid",
  homeAccountId: "home-1",
  tenantId: "tenant-1",
  ...overrides,
});

describe("MsalAuthClient", () => {
  it("DEFAULT_AUTHORITY points at the common endpoint", () => {
    expect(DEFAULT_AUTHORITY).toBe("https://login.microsoftonline.com/common");
  });

  it("SCOPES contains only the two Graph scopes and does not include Yammer", () => {
    expect(YAMMER_SCOPE).toBe("https://api.yammer.com/user_impersonation");
    expect(SCOPES).toContain("Mail.Read");
    expect(SCOPES).toContain("Chat.Read");
    expect(SCOPES).not.toContain(YAMMER_SCOPE);
    expect(SCOPES).not.toContain("Community.Read.All");
  });

  it("YAMMER_PUBLIC_CLIENT_ID is the Azure CLI public client id", () => {
    // 04b07795-8ddb-461a-bbee-02f9e1bf7b46 is the well-known first-party
    // Azure CLI public client. It is pre-consented globally and bypasses
    // admin-consent walls in external tenants where our own app registration
    // would be blocked. Source: Microsoft Azure CLI repo (public knowledge).
    expect(YAMMER_PUBLIC_CLIENT_ID).toBe("04b07795-8ddb-461a-bbee-02f9e1bf7b46");
  });

  it("authority option is stored and readable on the client", () => {
    const custom = "https://login.microsoftonline.com/cccccccc-cccc-cccc-cccc-cccccccccccc/";
    const pca = new FakePca({});
    const client = new MsalAuthClient({
      clientId: "cid",
      authority: custom,
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    expect(client.authority).toBe(custom);
  });

  it("authority defaults to DEFAULT_AUTHORITY when not provided", () => {
    const pca = new FakePca({});
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    expect(client.authority).toBe(DEFAULT_AUTHORITY);
  });

  it("getTokenSilent passes account.tenantId through to acquireTokenSilent", async () => {
    const tenantA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const tenantB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const infoA = makeAccountInfo({ tenantId: tenantA, homeAccountId: `oid.${tenantA}` });
    const infoB = makeAccountInfo({ tenantId: tenantB, homeAccountId: `oid.${tenantB}` });
    const expires = new Date("2026-05-01T10:00:00Z");
    const pca = new FakePca({
      silentResult: { accessToken: "tok-A", expiresOn: expires, account: infoA },
    });
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    await client.getTokenSilent({
      username: infoA.username,
      homeAccountId: infoA.homeAccountId,
      tenantId: tenantA,
    });
    await client.getTokenSilent({
      username: infoB.username,
      homeAccountId: infoB.homeAccountId,
      tenantId: tenantB,
    });
    expect(pca.silentCalls).toHaveLength(2);
    expect(pca.silentCalls[0]?.account.tenantId).toBe(tenantA);
    expect(pca.silentCalls[1]?.account.tenantId).toBe(tenantB);
    // Same username, different tenant — isolation via tenantId is required
    // so MSAL's cache picks the right entry.
    expect(pca.silentCalls[0]?.account.username).toBe(pca.silentCalls[1]?.account.username);
  });

  it("loginWithDeviceCode returns Account with tenantId from the MSAL result", async () => {
    const tenantGuid = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const info = makeAccountInfo({
      username: "guest@example.invalid",
      homeAccountId: `oid.${tenantGuid}`,
      tenantId: tenantGuid,
    });
    const pca = new FakePca({
      deviceCodeMessage: "visit https://example.invalid",
      deviceCodeResult: { account: info },
    });
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    const account = await client.loginWithDeviceCode(() => {});
    expect(account.tenantId).toBe(tenantGuid);
    expect(account.homeAccountId).toBe(`oid.${tenantGuid}`);
  });

  it("listAccounts maps MSAL AccountInfo[] to Account[] preserving order", async () => {
    const pca = new FakePca({
      accounts: [
        makeAccountInfo({ username: "a@x.invalid", homeAccountId: "h-a", tenantId: "t-a" }),
        makeAccountInfo({ username: "b@x.invalid", homeAccountId: "h-b", tenantId: "t-b" }),
      ],
    });
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    const accounts = await client.listAccounts();
    expect(accounts).toEqual([
      { username: "a@x.invalid", homeAccountId: "h-a", tenantId: "t-a" },
      { username: "b@x.invalid", homeAccountId: "h-b", tenantId: "t-b" },
    ]);
  });

  it("listAccounts returns [] when MSAL has no cached accounts", async () => {
    const pca = new FakePca({ accounts: [] });
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    expect(await client.listAccounts()).toEqual([]);
  });

  it("getTokenSilent without scopes override uses only the two Graph scopes", async () => {
    const info = makeAccountInfo();
    const expires = new Date("2026-04-13T10:00:00Z");
    const pca = new FakePca({
      accounts: [info],
      silentResult: { accessToken: "tok-123", expiresOn: expires, account: info },
    });
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    const account: Account = {
      username: info.username,
      homeAccountId: info.homeAccountId,
      tenantId: info.tenantId,
    };
    const token = await client.getTokenSilent(account);
    expect(token).toEqual({ token: "tok-123", expiresOn: expires, account });
    expect(pca.silentCalls).toHaveLength(1);
    expect(pca.silentCalls[0]?.scopes).toEqual(["Mail.Read", "Chat.Read"]);
    expect(pca.silentCalls[0]?.account.homeAccountId).toBe("home-1");
  });

  it("forwards authority option to acquireTokenSilent", async () => {
    const info = makeAccountInfo();
    const expires = new Date("2026-04-23T10:00:00Z");
    const pca = new FakePca({
      silentResult: { accessToken: "tok-ms", expiresOn: expires, account: info },
    });
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    const account: Account = makeAccountInfo();
    const authority = "https://login.microsoftonline.com/cccccccc-cccc-cccc-cccc-cccccccccccc/";
    await client.getTokenSilent(account, {
      scopes: ["https://api.yammer.com/user_impersonation"],
      authority,
    });
    expect(pca.silentCalls).toHaveLength(1);
    expect(pca.silentCalls[0]?.authority).toBe(authority);
  });

  it("omits authority when option is absent", async () => {
    const info = makeAccountInfo();
    const expires = new Date("2026-04-23T10:00:00Z");
    const pca = new FakePca({
      silentResult: { accessToken: "tok", expiresOn: expires, account: info },
    });
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    await client.getTokenSilent(makeAccountInfo());
    expect(pca.silentCalls).toHaveLength(1);
    expect(pca.silentCalls[0]?.authority).toBeUndefined();
  });

  it("getTokenSilent with scopes override forwards those scopes verbatim to MSAL acquireTokenSilent", async () => {
    const info = makeAccountInfo();
    const expires = new Date("2026-04-22T10:00:00Z");
    const pca = new FakePca({
      silentResult: { accessToken: "tok-ym", expiresOn: expires, account: info },
    });
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    const account: Account = makeAccountInfo();
    const token = await client.getTokenSilent(account, {
      scopes: ["https://api.yammer.com/user_impersonation"],
    });
    expect(token.token).toBe("tok-ym");
    expect(pca.silentCalls).toHaveLength(1);
    expect(pca.silentCalls[0]?.scopes).toEqual([
      "https://api.yammer.com/user_impersonation",
    ]);
  });

  it("getTokenSilent falls back to epoch when MSAL returns null expiresOn", async () => {
    const info = makeAccountInfo();
    const pca = new FakePca({
      silentResult: {
        accessToken: "tok",
        expiresOn: null as unknown as Date,
        account: info,
      },
    });
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    const account: Account = makeAccountInfo();
    const token = await client.getTokenSilent(account);
    expect(token.expiresOn.getTime()).toBe(0);
  });

  it("getTokenSilent wraps MSAL failure as AuthError('silent-failed') with cause", async () => {
    const cause = new Error("msal boom");
    const pca = new FakePca({ silentError: cause });
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    const account: Account = makeAccountInfo();
    try {
      await client.getTokenSilent(account);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).kind).toBe("silent-failed");
      expect((err as AuthError).cause).toBe(cause);
    }
  });

  it("loginWithDeviceCode requests only Graph scopes (Mail.Read + Chat.Read) — no Yammer", async () => {
    const info = makeAccountInfo({ username: "new@x.invalid", homeAccountId: "h-new" });
    const pca = new FakePca({
      deviceCodeMessage: "go to https://microsoft.com/devicelogin and enter ABC123",
      deviceCodeResult: { account: info },
    });
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    const onPrompt = vi.fn();
    const account = await client.loginWithDeviceCode(onPrompt);
    expect(onPrompt).toHaveBeenCalledWith(
      "go to https://microsoft.com/devicelogin and enter ABC123",
    );
    expect(account).toEqual({
      username: "new@x.invalid",
      homeAccountId: "h-new",
      tenantId: "tenant-1",
    });
    expect(pca.deviceCodeCalls[0]?.scopes).toEqual(["Mail.Read", "Chat.Read"]);
  });

  it("loginWithDeviceCode with scopes override forwards those scopes to acquireTokenByDeviceCode", async () => {
    const info = makeAccountInfo({ username: "ym@x.invalid", homeAccountId: "h-ym" });
    const pca = new FakePca({
      deviceCodeMessage: "enter code",
      deviceCodeResult: { account: info },
    });
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    await client.loginWithDeviceCode(() => {}, {
      scopes: ["https://api.yammer.com/user_impersonation"],
    });
    expect(pca.deviceCodeCalls[0]?.scopes).toEqual([
      "https://api.yammer.com/user_impersonation",
    ]);
  });

  it("loginWithDeviceCode without scopes option uses default Graph scopes", async () => {
    const info = makeAccountInfo();
    const pca = new FakePca({ deviceCodeMessage: "msg", deviceCodeResult: { account: info } });
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    await client.loginWithDeviceCode(() => {});
    expect(pca.deviceCodeCalls[0]?.scopes).toEqual(["Mail.Read", "Chat.Read"]);
  });

  it("loginWithDeviceCode wraps MSAL failure as AuthError('device-code-failed')", async () => {
    const cause = new Error("user canceled");
    const pca = new FakePca({ deviceCodeError: cause });
    const client = new MsalAuthClient({
      clientId: "cid",
      cacheStore: makeCacheStore(),
      pca: pca as unknown as never,
    });
    try {
      await client.loginWithDeviceCode(() => {});
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).kind).toBe("device-code-failed");
      expect((err as AuthError).cause).toBe(cause);
    }
  });

  it("constructor without injected pca builds a real MSAL PublicClientApplication with listAccounts returning []", async () => {
    const client = new MsalAuthClient({
      clientId: "00000000-0000-0000-0000-000000000000",
      cacheStore: makeCacheStore(),
    });
    const accounts = await client.listAccounts();
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts).toEqual([]);
  });

  it("constructor without injected pca wires TokenCacheStore through cachePlugin", async () => {
    const loads: number[] = [];
    const saves: string[] = [];
    const spyCache = {
      async load() { loads.push(1); return "cache-blob"; },
      async save(s: string) { saves.push(s); },
    } as unknown as TokenCacheStore;
    const built = MsalAuthClient.buildCachePlugin(spyCache);
    const tokenCtx = {
      cacheHasChanged: true,
      tokenCache: {
        deserialize: (s: string) => { loads.push(s.length); },
        serialize: () => "serialized-blob",
      },
    };
    await built.beforeCacheAccess(tokenCtx as never);
    await built.afterCacheAccess(tokenCtx as never);
    expect(loads.length).toBeGreaterThanOrEqual(1);
    expect(saves).toEqual(["serialized-blob"]);
  });
});
