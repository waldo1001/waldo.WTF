import {
  PublicClientApplication,
  type AuthenticationResult,
  type AccountInfo as MsalAccountInfoReal,
} from "@azure/msal-node";
import type { AuthClient } from "./auth-client.js";
import { AuthError, type AccessToken, type Account } from "./types.js";
import { TokenCacheStore } from "./token-cache-store.js";

export const DEFAULT_AUTHORITY = "https://login.microsoftonline.com/common";
export const SCOPES = ["Mail.Read", "Chat.Read", "Community.Read.All"] as const;

interface MsalAccountInfo {
  readonly username: string;
  readonly homeAccountId: string;
  readonly tenantId: string;
}

interface MsalAuthResult {
  readonly accessToken: string;
  readonly expiresOn: Date | null;
  readonly account: MsalAccountInfo;
}

interface MsalDeviceCodeResponse {
  readonly message: string;
}

interface MsalTokenCacheContext {
  readonly cacheHasChanged: boolean;
  readonly tokenCache: {
    deserialize(serialized: string): void;
    serialize(): string;
  };
}

interface MsalCachePlugin {
  beforeCacheAccess(ctx: MsalTokenCacheContext): Promise<void>;
  afterCacheAccess(ctx: MsalTokenCacheContext): Promise<void>;
}

export interface MsalLikePca {
  getAllAccounts(): MsalAccountInfo[] | Promise<MsalAccountInfo[]>;
  acquireTokenSilent(req: {
    account: MsalAccountInfo;
    scopes: readonly string[];
  }): Promise<MsalAuthResult>;
  acquireTokenByDeviceCode(req: {
    scopes: readonly string[];
    deviceCodeCallback: (r: MsalDeviceCodeResponse) => void;
  }): Promise<{ account: MsalAccountInfo }>;
}

export interface MsalAuthClientOptions {
  readonly clientId: string;
  readonly authority?: string;
  readonly cacheStore: TokenCacheStore;
  readonly pca?: MsalLikePca;
}

const toAccount = (info: MsalAccountInfo): Account => ({
  username: info.username,
  homeAccountId: info.homeAccountId,
  tenantId: info.tenantId,
});

export class MsalAuthClient implements AuthClient {
  private readonly pca: MsalLikePca;

  constructor(opts: MsalAuthClientOptions) {
    if (opts.pca) {
      this.pca = opts.pca;
      return;
    }
    const real = new PublicClientApplication({
      auth: {
        clientId: opts.clientId,
        authority: opts.authority ?? DEFAULT_AUTHORITY,
      },
      cache: {
        cachePlugin: MsalAuthClient.buildCachePlugin(opts.cacheStore),
      },
    });
    this.pca = {
      getAllAccounts: () => real.getAllAccounts() as Promise<MsalAccountInfo[]>,
      /* c8 ignore start -- thin MSAL adapter; verified via manual smoke run */
      acquireTokenSilent: async (req) => {
        const r = (await real.acquireTokenSilent({
          account: req.account as MsalAccountInfoReal,
          scopes: [...req.scopes],
        })) as AuthenticationResult;
        return {
          accessToken: r.accessToken,
          expiresOn: r.expiresOn,
          account: r.account as MsalAccountInfo,
        };
      },
      acquireTokenByDeviceCode: async (req) => {
        const r = (await real.acquireTokenByDeviceCode({
          scopes: [...req.scopes],
          deviceCodeCallback: req.deviceCodeCallback,
        })) as AuthenticationResult | null;
        if (!r || !r.account) {
          throw new AuthError("device-code-failed", "MSAL returned no account");
        }
        return { account: r.account as MsalAccountInfo };
      },
      /* c8 ignore stop */
    };
  }

  async listAccounts(): Promise<readonly Account[]> {
    const infos = await this.pca.getAllAccounts();
    return infos.map(toAccount);
  }

  async getTokenSilent(account: Account): Promise<AccessToken> {
    try {
      const res = await this.pca.acquireTokenSilent({
        account: {
          username: account.username,
          homeAccountId: account.homeAccountId,
          tenantId: account.tenantId,
        },
        scopes: SCOPES,
      });
      return {
        token: res.accessToken,
        expiresOn: res.expiresOn ?? new Date(0),
        account,
      };
    } catch (err) {
      throw new AuthError("silent-failed", "MSAL silent token acquisition failed", {
        cause: err,
      });
    }
  }

  async loginWithDeviceCode(
    onPrompt: (message: string) => void,
  ): Promise<Account> {
    try {
      const res = await this.pca.acquireTokenByDeviceCode({
        scopes: SCOPES,
        deviceCodeCallback: (r) => onPrompt(r.message),
      });
      return toAccount(res.account);
    } catch (err) {
      throw new AuthError("device-code-failed", "MSAL device-code login failed", {
        cause: err,
      });
    }
  }

  static buildCachePlugin(store: TokenCacheStore): MsalCachePlugin {
    return {
      async beforeCacheAccess(ctx) {
        const data = await store.load();
        if (data !== null) ctx.tokenCache.deserialize(data);
      },
      async afterCacheAccess(ctx) {
        if (ctx.cacheHasChanged) {
          await store.save(ctx.tokenCache.serialize());
        }
      },
    };
  }
}
