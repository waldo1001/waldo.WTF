import type { AccessToken, Account } from "./types.js";

export interface GetTokenOptions {
  readonly scopes?: readonly string[];
}

export interface LoginWithDeviceCodeOptions {
  readonly scopes?: readonly string[];
}

export interface AuthClient {
  listAccounts(): Promise<readonly Account[]>;
  getTokenSilent(
    account: Account,
    options?: GetTokenOptions,
  ): Promise<AccessToken>;
  loginWithDeviceCode(
    onPrompt: (message: string) => void,
    options?: LoginWithDeviceCodeOptions,
  ): Promise<Account>;
}
