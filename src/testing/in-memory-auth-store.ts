import {
  DuplicateClientIdError,
  type AuthStore,
  type OAuthAuthCodeRecord,
  type OAuthClientRecord,
  type OAuthClientRegistration,
  type OAuthTokenPair,
} from "../auth/oauth/auth-store.js";

const cloneRecord = (
  reg: OAuthClientRegistration,
): OAuthClientRecord => ({
  clientId: reg.clientId,
  redirectUris: [...reg.redirectUris],
  createdAt: new Date(reg.createdAt.getTime()),
  ...(reg.clientName !== undefined ? { clientName: reg.clientName } : {}),
});

const cloneAuthCode = (r: OAuthAuthCodeRecord): OAuthAuthCodeRecord => ({
  code: r.code,
  clientId: r.clientId,
  redirectUri: r.redirectUri,
  scope: r.scope,
  codeChallenge: r.codeChallenge,
  expiresAt: new Date(r.expiresAt.getTime()),
  createdAt: new Date(r.createdAt.getTime()),
  ...(r.state !== undefined ? { state: r.state } : {}),
});

const cloneTokenPair = (p: OAuthTokenPair): OAuthTokenPair => ({
  accessToken: p.accessToken,
  refreshToken: p.refreshToken,
  clientId: p.clientId,
  scope: p.scope,
  accessExpiresAt: new Date(p.accessExpiresAt.getTime()),
  refreshExpiresAt: new Date(p.refreshExpiresAt.getTime()),
  createdAt: new Date(p.createdAt.getTime()),
});

export class InMemoryAuthStore implements AuthStore {
  private readonly clients = new Map<string, OAuthClientRecord>();
  private readonly authCodes = new Map<string, OAuthAuthCodeRecord>();
  private readonly tokensByAccess = new Map<string, OAuthTokenPair>();
  private readonly tokensByRefresh = new Map<string, string>();

  async registerClient(reg: OAuthClientRegistration): Promise<void> {
    if (this.clients.has(reg.clientId)) {
      throw new DuplicateClientIdError(reg.clientId);
    }
    this.clients.set(reg.clientId, cloneRecord(reg));
  }

  async getClient(clientId: string): Promise<OAuthClientRecord | undefined> {
    const found = this.clients.get(clientId);
    return found ? cloneRecord({ ...found }) : undefined;
  }

  async listClients(): Promise<readonly OAuthClientRecord[]> {
    return [...this.clients.values()]
      .sort((a, b) => {
        const dt = a.createdAt.getTime() - b.createdAt.getTime();
        if (dt !== 0) return dt;
        return a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0;
      })
      .map((r) => cloneRecord({ ...r }));
  }

  async saveAuthCode(record: OAuthAuthCodeRecord): Promise<void> {
    this.authCodes.set(record.code, cloneAuthCode(record));
  }

  async consumeAuthCode(
    code: string,
    now: Date,
  ): Promise<OAuthAuthCodeRecord | undefined> {
    const record = this.authCodes.get(code);
    if (!record) return undefined;
    this.authCodes.delete(code);
    if (record.expiresAt.getTime() <= now.getTime()) return undefined;
    return cloneAuthCode(record);
  }

  async saveTokenPair(pair: OAuthTokenPair): Promise<void> {
    const cloned = cloneTokenPair(pair);
    this.tokensByAccess.set(pair.accessToken, cloned);
    this.tokensByRefresh.set(pair.refreshToken, pair.accessToken);
  }

  async getAccessToken(
    accessToken: string,
    now: Date,
  ): Promise<OAuthTokenPair | undefined> {
    const pair = this.tokensByAccess.get(accessToken);
    if (!pair) return undefined;
    if (pair.accessExpiresAt.getTime() <= now.getTime()) return undefined;
    return cloneTokenPair(pair);
  }

  async consumeRefreshToken(
    refreshToken: string,
    now: Date,
  ): Promise<OAuthTokenPair | undefined> {
    const accessToken = this.tokensByRefresh.get(refreshToken);
    if (!accessToken) return undefined;
    const pair = this.tokensByAccess.get(accessToken);
    if (!pair) return undefined;
    this.tokensByAccess.delete(accessToken);
    this.tokensByRefresh.delete(refreshToken);
    if (pair.refreshExpiresAt.getTime() <= now.getTime()) return undefined;
    return cloneTokenPair(pair);
  }
}
