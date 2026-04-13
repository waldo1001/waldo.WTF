import type { AuthClient } from "../auth/auth-client.js";
import { AuthError, type AccessToken, type Account } from "../auth/types.js";

export type FakeAuthClientCall =
  | { method: "listAccounts" }
  | { method: "getTokenSilent"; account: Account }
  | { method: "loginWithDeviceCode" };

export interface FakeAuthClientOptions {
  accounts: readonly Account[];
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

  async getTokenSilent(account: Account): Promise<AccessToken> {
    this.calls.push({ method: "getTokenSilent", account });
    const scripted = this.opts.tokens?.get(account.homeAccountId);
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
  ): Promise<Account> {
    this.calls.push({ method: "loginWithDeviceCode" });
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
