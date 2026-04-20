export interface OAuthClientRegistration {
  readonly clientId: string;
  readonly clientName?: string;
  readonly redirectUris: readonly string[];
  readonly createdAt: Date;
}

export interface OAuthClientRecord {
  readonly clientId: string;
  readonly clientName?: string;
  readonly redirectUris: readonly string[];
  readonly createdAt: Date;
}

export class DuplicateClientIdError extends Error {
  readonly clientId: string;
  constructor(clientId: string) {
    super(`oauth client_id already registered: ${clientId}`);
    this.name = "DuplicateClientIdError";
    this.clientId = clientId;
  }
}

export interface OAuthAuthCodeRecord {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly codeChallenge: string;
  readonly state?: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface OAuthTokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly clientId: string;
  readonly scope: string;
  readonly accessExpiresAt: Date;
  readonly refreshExpiresAt: Date;
  readonly createdAt: Date;
}

export interface AuthStore {
  registerClient(registration: OAuthClientRegistration): Promise<void>;
  getClient(clientId: string): Promise<OAuthClientRecord | undefined>;
  listClients(): Promise<readonly OAuthClientRecord[]>;

  saveAuthCode(record: OAuthAuthCodeRecord): Promise<void>;
  consumeAuthCode(
    code: string,
    now: Date,
  ): Promise<OAuthAuthCodeRecord | undefined>;

  saveTokenPair(pair: OAuthTokenPair): Promise<void>;
  getAccessToken(
    accessToken: string,
    now: Date,
  ): Promise<OAuthTokenPair | undefined>;
  consumeRefreshToken(
    refreshToken: string,
    now: Date,
  ): Promise<OAuthTokenPair | undefined>;
}
