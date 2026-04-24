import type { AuthClient, GetTokenOptions } from "../auth/auth-client.js";
import { AuthError, type AccessToken, type Account } from "../auth/types.js";

export type FakeAuthClientCall =
  | { method: "listAccounts" }
  | {
      method: "getTokenSilent";
      account: Account;
      scopes?: readonly string[];
      authority?: string;
      forceRefresh?: boolean;
    }
  | { method: "loginWithDeviceCode"; scopes?: readonly string[] };

export interface FakeAuthClientOptions {
  accounts: readonly Account[];
  // Token keys, tried in order:
  //   `<homeAccountId>|<authority>|forceRefresh=true`  (only when forceRefresh: true)
  //   `<homeAccountId>|<authority>`                     (authority-scoped)
  //   `<homeAccountId>`                                 (plain / default authority)
  tokens?: ReadonlyMap<string, AccessToken | Error>;
  deviceCodeResult?: Account | Error;
  deviceCodeMessage?: string;
}

export class FakeAuthClient implements AuthClient {
  readonly calls: FakeAuthClientCall[] = [];

  constructor(private readonly opts: FakeAuthClientOptions) {}

  async listAccounts(): Promise<readonly Account[]> {
    this.calls.push({ method: "listAccounts" });
    return this.opts.accounts;
  }

  async getTokenSilent(
    account: Account,
    options?: GetTokenOptions,
  ): Promise<AccessToken> {
    const call: FakeAuthClientCall = {
      method: "getTokenSilent",
      account,
      ...(options?.scopes !== undefined && { scopes: options.scopes }),
      ...(options?.authority !== undefined && { authority: options.authority }),
      ...(options?.forceRefresh !== undefined && {
        forceRefresh: options.forceRefresh,
      }),
    };
    this.calls.push(call);
    const tryKeys: string[] = [];
    if (options?.forceRefresh === true && options?.authority !== undefined) {
      tryKeys.push(`${account.homeAccountId}|${options.authority}|forceRefresh=true`);
    }
    if (options?.authority !== undefined) {
      tryKeys.push(`${account.homeAccountId}|${options.authority}`);
    }
    tryKeys.push(account.homeAccountId);
    let scripted: AccessToken | Error | undefined;
    for (const key of tryKeys) {
      const v = this.opts.tokens?.get(key);
      if (v !== undefined) {
        scripted = v;
        break;
      }
    }
    if (scripted === undefined) {
      throw new AuthError(
        "silent-failed",
        `FakeAuthClient: no scripted token for ${account.username}`,
      );
    }
    if (scripted instanceof Error) throw scripted;
    return scripted;
  }

  async loginWithDeviceCode(
    onPrompt: (message: string) => void,
    options?: { scopes?: readonly string[] },
  ): Promise<Account> {
    const call: FakeAuthClientCall =
      options?.scopes !== undefined
        ? { method: "loginWithDeviceCode", scopes: options.scopes }
        : { method: "loginWithDeviceCode" };
    this.calls.push(call);
    onPrompt(
      this.opts.deviceCodeMessage ??
        "FakeAuthClient: visit https://example.invalid/devicelogin",
    );
    const result = this.opts.deviceCodeResult;
    if (result === undefined) {
      throw new AuthError(
        "device-code-failed",
        "FakeAuthClient: no scripted device-code result",
      );
    }
    if (result instanceof Error) throw result;
    return result;
  }
}
