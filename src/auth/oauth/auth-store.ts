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
  /** Start of the consent this pair descends from; caps its total lifetime. */
  readonly grantCreatedAt: Date;
}

/**
 * What the store returns for a token lookup. Deliberately carries no token
 * values: the store keeps only their hashes, so it cannot return them.
 */
export interface OAuthGrant {
  readonly clientId: string;
  readonly scope: string;
  readonly accessExpiresAt: Date;
  readonly refreshExpiresAt: Date;
  readonly createdAt: Date;
  readonly grantCreatedAt: Date;
}

export interface RefreshRequest {
  readonly refreshToken: string;
  readonly now: Date;
  readonly newAccessToken: string;
  readonly accessTtlMs: number;
  readonly refreshTtlMs: number;
  /** Absolute cap measured from grantCreatedAt; sliding never extends past it. */
  readonly maxGrantMs: number;
  /** When given and different from the grant's client, behaves like an unknown token. */
  readonly expectedClientId?: string;
}

export interface OAuthClientStats {
  readonly client: OAuthClientRecord;
  /** Grants whose refresh token has not expired. */
  readonly activeGrants: number;
  /** Most recent grantCreatedAt among the client's tokens, if any. */
  readonly lastGrantAt?: Date;
}

export interface AuthStore {
  registerClient(registration: OAuthClientRegistration): Promise<void>;
  getClient(clientId: string): Promise<OAuthClientRecord | undefined>;
  listClients(): Promise<readonly OAuthClientRecord[]>;
  countClients(): Promise<number>;
  /**
   * Deletes clients created before `olderThan` that have no auth codes and no
   * tokens (abandoned DCR registrations). Returns the number deleted.
   */
  pruneUnusedClients(olderThan: Date): Promise<number>;
  /** Operator view (CLI): per client, how many grants are still refreshable at `now`. */
  listClientsWithStats(now: Date): Promise<readonly OAuthClientStats[]>;
  /** Deletes the client and all its tokens and codes. False if it did not exist. */
  revokeClient(clientId: string): Promise<boolean>;

  /** Also deletes codes already expired at `record.createdAt`. */
  saveAuthCode(record: OAuthAuthCodeRecord): Promise<void>;
  consumeAuthCode(
    code: string,
    now: Date,
  ): Promise<OAuthAuthCodeRecord | undefined>;

  /** Also deletes token rows whose refresh expiry is at or before `pair.createdAt`. */
  saveTokenPair(pair: OAuthTokenPair): Promise<void>;
  getAccessToken(accessToken: string, now: Date): Promise<OAuthGrant | undefined>;
  /**
   * Non-rotating refresh: replaces the access token (the old one stops
   * validating), keeps the SAME refresh token, and slides both expiries by
   * their TTLs — clamped to grantCreatedAt + maxGrantMs. Returns undefined
   * (row untouched) for an unknown, expired, wrong-client or past-cap grant.
   */
  refreshAccessToken(req: RefreshRequest): Promise<OAuthGrant | undefined>;
}
