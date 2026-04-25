import {
  PublicClientApplication,
  type AuthenticationResult,
  type AccountInfo as MsalAccountInfoReal,
} from "@azure/msal-node";
import type { AuthClient, GetTokenOptions } from "./auth-client.js";
import { AuthError, type AccessToken, type Account } from "./types.js";
import { TokenCacheStore } from "./token-cache-store.js";

export const DEFAULT_AUTHORITY = "https://login.microsoftonline.com/common";
export const YAMMER_SCOPE = "https://api.yammer.com/user_impersonation";
export const SCOPES = ["Mail.Read", "Chat.Read"] as const;
export const TEAMS_CHANNEL_SCOPES = [
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "ChannelMessage.Read.All",
] as const;

export function vivaAuthorityFor(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/`;
}

export function teamsAuthorityFor(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/`;
}

// MSAL surfaces unconsented-tenant rejections as `interaction_required` /
// `consent_required` / `AADSTS65001` (sometimes wrapped by the cause chain).
// We walk the cause chain since the AuthClient seam wraps MSAL errors in an
// AuthError. Used by the channels canary in CLI discover and by the
// scheduler's per-account skip when a tenant has no admin consent.
export function isConsentRequiredError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    const msg = cur.message.toLowerCase();
    if (
      msg.includes("interaction_required") ||
      msg.includes("consent_required") ||
      msg.includes("aadsts65001")
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

// Azure CLI's public first-party client ID. It is pre-consented globally by
// Microsoft, which means device-code login against external tenants where our
// own app registration would be blocked by "Admin consent required" works
// without any admin intervention. Used exclusively for the Yammer/Viva Engage
// per-tenant auth path — Outlook/Teams still use the project's own clientId.
// Source: public Azure CLI repository; this identifier is not a secret.
export const YAMMER_PUBLIC_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";

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
    authority?: string;
    forceRefresh?: boolean;
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
  readonly authority: string;

  constructor(opts: MsalAuthClientOptions) {
    this.authority = opts.authority ?? DEFAULT_AUTHORITY;
    if (opts.pca) {
      this.pca = opts.pca;
      return;
    }
    const real = new PublicClientApplication({
      auth: {
        clientId: opts.clientId,
        authority: this.authority,
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
          ...(req.authority !== undefined && { authority: req.authority }),
          ...(req.forceRefresh !== undefined && { forceRefresh: req.forceRefresh }),
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

  async getTokenSilent(
    account: Account,
    options?: GetTokenOptions,
  ): Promise<AccessToken> {
    try {
      const res = await this.pca.acquireTokenSilent({
        account: {
          username: account.username,
          homeAccountId: account.homeAccountId,
          tenantId: account.tenantId,
        },
        scopes: options?.scopes ?? SCOPES,
        ...(options?.authority !== undefined && { authority: options.authority }),
        ...(options?.forceRefresh !== undefined && {
          forceRefresh: options.forceRefresh,
        }),
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
    options?: { scopes?: readonly string[] },
  ): Promise<Account> {
    try {
      const res = await this.pca.acquireTokenByDeviceCode({
        scopes: options?.scopes ?? SCOPES,
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
