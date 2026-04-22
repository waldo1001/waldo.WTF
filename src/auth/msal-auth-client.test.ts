import { describe, it, expect, vi } from "vitest";
import {
  MsalAuthClient,
  DEFAULT_AUTHORITY,
  SCOPES,
  YAMMER_SCOPE,
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
  readonly silentCalls: Array<{ account: AccountInfo; scopes: string[] }> = [];
  readonly deviceCodeCalls: Array<{ scopes: string[] }> = [];

  constructor(private readonly opts: FakePcaOptions) {}

  getAllAccounts(): AccountInfo[] {
    return this.opts.accounts ?? [];
  }

  async acquireTokenSilent(req: {
    account: AccountInfo;
    scopes: string[];
  }): Promise<{ accessToken: string; expiresOn: Date; account: AccountInfo }> {
    this.silentCalls.push({ account: req.account, scopes: req.scopes });
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
