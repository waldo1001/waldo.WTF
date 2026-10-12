import type { Database, Statement } from "better-sqlite3";
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
} from "./auth-store.js";
import { hashToken } from "./token-hash.js";

// Secrets at rest: access_token, refresh_token and oauth_auth_codes.code hold
// hashToken(value), never the value itself (schema v20). Every method hashes
// what the caller presents before touching SQL.

interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris_json: string;
  created_at: number;
}

interface GrantRow {
  client_id: string;
  scope: string;
  access_expires_at: number;
  refresh_expires_at: number;
  created_at: number;
  grant_created_at: number;
}

interface AuthCodeRow {
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  state: string | null;
  expires_at: number;
  created_at: number;
}

const GRANT_COLUMNS =
  "client_id, scope, access_expires_at, refresh_expires_at, created_at, grant_created_at";

const rowToRecord = (row: ClientRow): OAuthClientRecord => {
  const redirectUris = JSON.parse(row.redirect_uris_json) as string[];
  return {
    clientId: row.client_id,
    redirectUris,
    createdAt: new Date(row.created_at),
    ...(row.client_name !== null ? { clientName: row.client_name } : {}),
  };
};

const rowToGrant = (row: GrantRow): OAuthGrant => ({
  clientId: row.client_id,
  scope: row.scope,
  accessExpiresAt: new Date(row.access_expires_at),
  refreshExpiresAt: new Date(row.refresh_expires_at),
  createdAt: new Date(row.created_at),
  grantCreatedAt: new Date(row.grant_created_at),
});

export class SqliteAuthStore implements AuthStore {
  private readonly insertClientStmt: Statement<
    [string, string | null, string, number]
  >;
  private readonly getClientStmt: Statement<[string]>;
  private readonly listClientsStmt: Statement<[]>;
  private readonly countClientsStmt: Statement<[]>;
  private readonly deleteExpiredCodesStmt: Statement<[number]>;
  private readonly pruneUnusedClientsStmt: Statement<[number]>;
  private readonly insertAuthCodeStmt: Statement<
    [string, string, string, string, string, string | null, number, number]
  >;
  private readonly consumeCodeTx: (
    codeHash: string,
    nowMs: number,
  ) => AuthCodeRow | undefined;
  private readonly deleteExpiredGrantsStmt: Statement<[number]>;
  private readonly insertTokenStmt: Statement<
    [string, string, string, string, number, number, number, number]
  >;
  private readonly getByAccessStmt: Statement<[string]>;
  private readonly refreshTx: (req: RefreshRequest) => OAuthGrant | undefined;
  private readonly listClientStatsStmt: Statement<[number]>;
  private readonly revokeTx: (clientId: string) => boolean;

  constructor(db: Database) {
    this.insertClientStmt = db.prepare(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris_json, created_at) VALUES (?, ?, ?, ?)",
    );
    this.getClientStmt = db.prepare(
      "SELECT client_id, client_name, redirect_uris_json, created_at FROM oauth_clients WHERE client_id = ?",
    );
    this.listClientsStmt = db.prepare(
      "SELECT client_id, client_name, redirect_uris_json, created_at FROM oauth_clients ORDER BY created_at ASC, client_id ASC",
    );
    this.countClientsStmt = db.prepare("SELECT COUNT(*) AS n FROM oauth_clients");
    this.deleteExpiredCodesStmt = db.prepare(
      "DELETE FROM oauth_auth_codes WHERE expires_at <= ?",
    );
    this.pruneUnusedClientsStmt = db.prepare(
      `DELETE FROM oauth_clients
        WHERE created_at < ?
          AND client_id NOT IN (SELECT client_id FROM oauth_auth_codes)
          AND client_id NOT IN (SELECT client_id FROM oauth_access_tokens)`,
    );

    this.insertAuthCodeStmt = db.prepare(
      "INSERT INTO oauth_auth_codes (code, client_id, redirect_uri, scope, code_challenge, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const selectCode = db.prepare<[string]>(
      "SELECT client_id, redirect_uri, scope, code_challenge, state, expires_at, created_at FROM oauth_auth_codes WHERE code = ?",
    );
    const deleteCode = db.prepare<[string]>(
      "DELETE FROM oauth_auth_codes WHERE code = ?",
    );
    this.consumeCodeTx = db.transaction(
      (codeHash: string, nowMs: number): AuthCodeRow | undefined => {
        const row = selectCode.get(codeHash) as AuthCodeRow | undefined;
        if (!row) return undefined;
        deleteCode.run(codeHash);
        return row.expires_at <= nowMs ? undefined : row;
      },
    );

    this.listClientStatsStmt = db.prepare(
      `SELECT c.client_id, c.client_name, c.redirect_uris_json, c.created_at,
              COALESCE(SUM(CASE WHEN t.refresh_expires_at > ? THEN 1 ELSE 0 END), 0) AS active_grants,
              MAX(t.grant_created_at) AS last_grant_at
         FROM oauth_clients c
         LEFT JOIN oauth_access_tokens t ON t.client_id = c.client_id
        GROUP BY c.client_id
        ORDER BY c.created_at ASC, c.client_id ASC`,
    );
    const deleteClientCodes = db.prepare<[string]>(
      "DELETE FROM oauth_auth_codes WHERE client_id = ?",
    );
    const deleteClientTokens = db.prepare<[string]>(
      "DELETE FROM oauth_access_tokens WHERE client_id = ?",
    );
    const deleteClient = db.prepare<[string]>(
      "DELETE FROM oauth_clients WHERE client_id = ?",
    );
    this.revokeTx = db.transaction((clientId: string): boolean => {
      deleteClientCodes.run(clientId);
      deleteClientTokens.run(clientId);
      return deleteClient.run(clientId).changes > 0;
    });

    this.deleteExpiredGrantsStmt = db.prepare(
      "DELETE FROM oauth_access_tokens WHERE refresh_expires_at <= ?",
    );
    this.insertTokenStmt = db.prepare(
      "INSERT INTO oauth_access_tokens (access_token, refresh_token, client_id, scope, access_expires_at, refresh_expires_at, created_at, grant_created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.getByAccessStmt = db.prepare(
      `SELECT ${GRANT_COLUMNS} FROM oauth_access_tokens WHERE access_token = ?`,
    );
    const selectByRefresh = db.prepare<[string]>(
      `SELECT ${GRANT_COLUMNS} FROM oauth_access_tokens WHERE refresh_token = ?`,
    );
    const updateAccess = db.prepare<[string, number, number, string]>(
      "UPDATE oauth_access_tokens SET access_token = ?, access_expires_at = ?, refresh_expires_at = ? WHERE refresh_token = ?",
    );
    this.refreshTx = db.transaction(
      (req: RefreshRequest): OAuthGrant | undefined => {
        const refreshHash = hashToken(req.refreshToken);
        const row = selectByRefresh.get(refreshHash) as GrantRow | undefined;
        const nowMs = req.now.getTime();
        // Non-destructive: unknown, expired, wrong-client or past-cap leaves the row untouched.
        if (!row || row.refresh_expires_at <= nowMs) return undefined;
        if (
          req.expectedClientId !== undefined &&
          row.client_id !== req.expectedClientId
        ) {
          return undefined;
        }
        const grantEndMs = row.grant_created_at + req.maxGrantMs;
        if (nowMs >= grantEndMs) return undefined;
        const accessExpiresAtMs = Math.min(nowMs + req.accessTtlMs, grantEndMs);
        const refreshExpiresAtMs = Math.min(nowMs + req.refreshTtlMs, grantEndMs);
        updateAccess.run(
          hashToken(req.newAccessToken),
          accessExpiresAtMs,
          refreshExpiresAtMs,
          refreshHash,
        );
        this.deleteExpiredGrantsStmt.run(nowMs);
        return rowToGrant({
          ...row,
          access_expires_at: accessExpiresAtMs,
          refresh_expires_at: refreshExpiresAtMs,
        });
      },
    );
  }

  async registerClient(reg: OAuthClientRegistration): Promise<void> {
    try {
      this.insertClientStmt.run(
        reg.clientId,
        reg.clientName ?? null,
        JSON.stringify(reg.redirectUris),
        reg.createdAt.getTime(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE constraint failed")) {
        throw new DuplicateClientIdError(reg.clientId);
      }
      throw err;
    }
  }

  async getClient(clientId: string): Promise<OAuthClientRecord | undefined> {
    const row = this.getClientStmt.get(clientId) as ClientRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  async listClients(): Promise<readonly OAuthClientRecord[]> {
    const rows = this.listClientsStmt.all() as ClientRow[];
    return rows.map(rowToRecord);
  }

  async listClientsWithStats(now: Date): Promise<readonly OAuthClientStats[]> {
    const rows = this.listClientStatsStmt.all(now.getTime()) as (ClientRow & {
      active_grants: number;
      last_grant_at: number | null;
    })[];
    return rows.map((row) => ({
      client: rowToRecord(row),
      activeGrants: row.active_grants,
      ...(row.last_grant_at !== null
        ? { lastGrantAt: new Date(row.last_grant_at) }
        : {}),
    }));
  }

  async revokeClient(clientId: string): Promise<boolean> {
    return this.revokeTx(clientId);
  }

  async countClients(): Promise<number> {
    return (this.countClientsStmt.get() as { n: number }).n;
  }

  async pruneUnusedClients(olderThan: Date): Promise<number> {
    this.deleteExpiredCodesStmt.run(olderThan.getTime());
    return this.pruneUnusedClientsStmt.run(olderThan.getTime()).changes;
  }

  async saveAuthCode(record: OAuthAuthCodeRecord): Promise<void> {
    this.deleteExpiredCodesStmt.run(record.createdAt.getTime());
    this.insertAuthCodeStmt.run(
      hashToken(record.code),
      record.clientId,
      record.redirectUri,
      record.scope,
      record.codeChallenge,
      record.state ?? null,
      record.expiresAt.getTime(),
      record.createdAt.getTime(),
    );
  }

  async consumeAuthCode(
    code: string,
    now: Date,
  ): Promise<OAuthAuthCodeRecord | undefined> {
    const row = this.consumeCodeTx(hashToken(code), now.getTime());
    if (!row) return undefined;
    return {
      code,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      scope: row.scope,
      codeChallenge: row.code_challenge,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
      ...(row.state !== null ? { state: row.state } : {}),
    };
  }

  async saveTokenPair(pair: OAuthTokenPair): Promise<void> {
    this.deleteExpiredGrantsStmt.run(pair.createdAt.getTime());
    this.insertTokenStmt.run(
      hashToken(pair.accessToken),
      hashToken(pair.refreshToken),
      pair.clientId,
      pair.scope,
      pair.accessExpiresAt.getTime(),
      pair.refreshExpiresAt.getTime(),
      pair.createdAt.getTime(),
      pair.grantCreatedAt.getTime(),
    );
  }

  async getAccessToken(
    accessToken: string,
    now: Date,
  ): Promise<OAuthGrant | undefined> {
    const row = this.getByAccessStmt.get(hashToken(accessToken)) as
      | GrantRow
      | undefined;
    if (!row || row.access_expires_at <= now.getTime()) return undefined;
    return rowToGrant(row);
  }

  async refreshAccessToken(req: RefreshRequest): Promise<OAuthGrant | undefined> {
    return this.refreshTx(req);
  }
}
