import {
  DuplicateClientIdError,
  type AuthStore,
  type OAuthAuthCodeRecord,
  type OAuthClientRecord,
  type OAuthClientStats,
  type OAuthClientRegistration,
  type OAuthGrant,
  type OAuthTokenPair,
  type RefreshRequest,
} from "../auth/oauth/auth-store.js";
import { hashToken } from "../auth/oauth/token-hash.js";

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

interface StoredGrant extends OAuthGrant {
  readonly accessHash: string;
  readonly refreshHash: string;
}

const toGrant = (g: StoredGrant): OAuthGrant => ({
  clientId: g.clientId,
  scope: g.scope,
  accessExpiresAt: new Date(g.accessExpiresAt.getTime()),
  refreshExpiresAt: new Date(g.refreshExpiresAt.getTime()),
  createdAt: new Date(g.createdAt.getTime()),
  grantCreatedAt: new Date(g.grantCreatedAt.getTime()),
});

const minDate = (a: number, b: number): Date => new Date(Math.min(a, b));

export class InMemoryAuthStore implements AuthStore {
  private readonly clients = new Map<string, OAuthClientRecord>();
  private readonly authCodes = new Map<string, OAuthAuthCodeRecord>();
  // Keyed by refresh-token hash, mirroring SqliteAuthStore's hashed storage.
  private readonly grants = new Map<string, StoredGrant>();

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

  async listClientsWithStats(now: Date): Promise<readonly OAuthClientStats[]> {
    const clients = await this.listClients();
    return clients.map((client) => {
      const grants = [...this.grants.values()].filter(
        (g) => g.clientId === client.clientId,
      );
      const active = grants.filter(
        (g) => g.refreshExpiresAt.getTime() > now.getTime(),
      ).length;
      const last = grants.reduce<number | undefined>(
        (max, g) =>
          max === undefined || g.grantCreatedAt.getTime() > max
            ? g.grantCreatedAt.getTime()
            : max,
        undefined,
      );
      return {
        client,
        activeGrants: active,
        ...(last !== undefined ? { lastGrantAt: new Date(last) } : {}),
      };
    });
  }

  async revokeClient(clientId: string): Promise<boolean> {
    if (!this.clients.delete(clientId)) return false;
    for (const [key, g] of this.grants) {
      if (g.clientId === clientId) this.grants.delete(key);
    }
    for (const [code, c] of this.authCodes) {
      if (c.clientId === clientId) this.authCodes.delete(code);
    }
    return true;
  }

  async countClients(): Promise<number> {
    return this.clients.size;
  }

  async pruneUnusedClients(olderThan: Date): Promise<number> {
    this.deleteCodesExpiredBy(olderThan);
    const used = new Set<string>([
      ...[...this.authCodes.values()].map((c) => c.clientId),
      ...[...this.grants.values()].map((t) => t.clientId),
    ]);
    let deleted = 0;
    for (const [id, client] of this.clients) {
      if (client.createdAt.getTime() < olderThan.getTime() && !used.has(id)) {
        this.clients.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  async saveAuthCode(record: OAuthAuthCodeRecord): Promise<void> {
    this.deleteCodesExpiredBy(record.createdAt);
    this.authCodes.set(record.code, cloneAuthCode(record));
  }

  private deleteCodesExpiredBy(at: Date): void {
    for (const [code, rec] of this.authCodes) {
      if (rec.expiresAt.getTime() <= at.getTime()) this.authCodes.delete(code);
    }
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
    this.deleteGrantsExpiredBy(pair.createdAt);
    const refreshHash = hashToken(pair.refreshToken);
    this.grants.set(refreshHash, {
      accessHash: hashToken(pair.accessToken),
      refreshHash,
      clientId: pair.clientId,
      scope: pair.scope,
      accessExpiresAt: new Date(pair.accessExpiresAt.getTime()),
      refreshExpiresAt: new Date(pair.refreshExpiresAt.getTime()),
      createdAt: new Date(pair.createdAt.getTime()),
      grantCreatedAt: new Date(pair.grantCreatedAt.getTime()),
    });
  }

  async getAccessToken(
    accessToken: string,
    now: Date,
  ): Promise<OAuthGrant | undefined> {
    const accessHash = hashToken(accessToken);
    const g = [...this.grants.values()].find((x) => x.accessHash === accessHash);
    if (!g || g.accessExpiresAt.getTime() <= now.getTime()) return undefined;
    return toGrant(g);
  }

  async refreshAccessToken(req: RefreshRequest): Promise<OAuthGrant | undefined> {
    const refreshHash = hashToken(req.refreshToken);
    const g = this.grants.get(refreshHash);
    const nowMs = req.now.getTime();
    if (!g || g.refreshExpiresAt.getTime() <= nowMs) return undefined;
    if (req.expectedClientId !== undefined && g.clientId !== req.expectedClientId) {
      return undefined;
    }
    const grantEndMs = g.grantCreatedAt.getTime() + req.maxGrantMs;
    if (nowMs >= grantEndMs) return undefined;
    const updated: StoredGrant = {
      ...g,
      accessHash: hashToken(req.newAccessToken),
      accessExpiresAt: minDate(nowMs + req.accessTtlMs, grantEndMs),
      refreshExpiresAt: minDate(nowMs + req.refreshTtlMs, grantEndMs),
    };
    this.grants.set(refreshHash, updated);
    this.deleteGrantsExpiredBy(req.now);
    return toGrant(updated);
  }

  private deleteGrantsExpiredBy(at: Date): void {
    for (const [key, g] of this.grants) {
      if (g.refreshExpiresAt.getTime() <= at.getTime()) this.grants.delete(key);
    }
  }


}
