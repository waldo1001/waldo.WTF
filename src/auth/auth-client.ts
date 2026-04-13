import type { AccessToken, Account } from "./types.js";

export interface AuthClient {
  listAccounts(): Promise<readonly Account[]>;
  getTokenSilent(account: Account): Promise<AccessToken>;
  loginWithDeviceCode(
    onPrompt: (message: string) => void,
  ): Promise<Account>;
}
