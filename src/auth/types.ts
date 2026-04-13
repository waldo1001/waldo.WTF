export interface Account {
  readonly username: string;
  readonly homeAccountId: string;
  readonly tenantId: string;
}

export interface AccessToken {
  readonly token: string;
  readonly expiresOn: Date;
  readonly account: Account;
}

export type AuthErrorKind =
  | "silent-failed"
  | "no-accounts"
  | "device-code-failed"
  | "cache-corrupt";

export class AuthError extends Error {
  constructor(
    readonly kind: AuthErrorKind,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(message ?? kind, options);
    this.name = "AuthError";
  }
}
