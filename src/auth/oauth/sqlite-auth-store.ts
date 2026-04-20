import type { Database, Statement } from "better-sqlite3";
import {
  DuplicateClientIdError,
  type AuthStore,
  type OAuthAuthCodeRecord,
  type OAuthClientRecord,
  type OAuthClientRegistration,
  type OAuthTokenPair,
} from "./auth-store.js";

interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris_json: string;
  created_at: number;
}

interface TokenRow {
  access_token: string;
  refresh_token: string;
  client_id: string;
  scope: string;
  access_expires_at: number;
  refresh_expires_at: number;
  created_at: number;
}

interface AuthCodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  state: string | null;
  expires_at: number;
  created_at: number;
}

const rowToRecord = (row: ClientRow): OAuthClientRecord => {
  const redirectUris = JSON.parse(row.redirect_uris_json) as string[];
  return {
    clientId: row.client_id,
    redirectUris,
    createdAt: new Date(row.created_at),
    ...(row.client_name !== null ? { clientName: row.client_name } : {}),
  };
};

const rowToTokenPair = (row: TokenRow): OAuthTokenPair => ({
  accessToken: row.access_token,
  refreshToken: row.refresh_token,
  clientId: row.client_id,
  scope: row.scope,
  accessExpiresAt: new Date(row.access_expires_at),
  refreshExpiresAt: new Date(row.refresh_expires_at),
  createdAt: new Date(row.created_at),
});

const rowToAuthCode = (row: AuthCodeRow): OAuthAuthCodeRecord => ({
  code: row.code,
  clientId: row.client_id,
  redirectUri: row.redirect_uri,
  scope: row.scope,
  codeChallenge: row.code_challenge,
  expiresAt: new Date(row.expires_at),
  createdAt: new Date(row.created_at),
  ...(row.state !== null ? { state: row.state } : {}),
});

export class SqliteAuthStore implements AuthStore {
  private readonly insertClientStmt: Statement<
    [string, string | null, string, number]
  >;
  private readonly getClientStmt: Statement<[string]>;
  private readonly listClientsStmt: Statement<[]>;
  private readonly insertAuthCodeStmt: Statement<
    [string, string, string, string, string, string | null, number, number]
  >;
  private readonly getAndDeleteAuthCodeStmt: (
    code: string,
    nowMs: number,
  ) => OAuthAuthCodeRecord | undefined;
  private readonly insertTokenStmt: Statement<
    [string, string, string, string, number, number, number]
  >;
  private readonly getAccessTokenStmt: Statement<[string]>;
  private readonly getAndDeleteRefreshStmt: (
    refreshToken: string,
    nowMs: number,
  ) => OAuthTokenPair | undefined;

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
    this.insertAuthCodeStmt = db.prepare(
      "INSERT INTO oauth_auth_codes (code, client_id, redirect_uri, scope, code_challenge, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );

    const selectCode = db.prepare<[string]>(
      "SELECT code, client_id, redirect_uri, scope, code_challenge, state, expires_at, created_at FROM oauth_auth_codes WHERE code = ?",
    );
    const deleteCode = db.prepare<[string]>(
      "DELETE FROM oauth_auth_codes WHERE code = ?",
    );
    const consumeTx = db.transaction(
      (code: string, nowMs: number): OAuthAuthCodeRecord | undefined => {
        const row = selectCode.get(code) as AuthCodeRow | undefined;
        if (!row) return undefined;
        deleteCode.run(code);
        if (row.expires_at <= nowMs) return undefined;
        return rowToAuthCode(row);
      },
    );
    this.getAndDeleteAuthCodeStmt = (code, nowMs) => consumeTx(code, nowMs);

    this.insertTokenStmt = db.prepare(
      "INSERT INTO oauth_access_tokens (access_token, refresh_token, client_id, scope, access_expires_at, refresh_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.getAccessTokenStmt = db.prepare(
      "SELECT access_token, refresh_token, client_id, scope, access_expires_at, refresh_expires_at, created_at FROM oauth_access_tokens WHERE access_token = ?",
    );

    const selectByRefresh = db.prepare<[string]>(
      "SELECT access_token, refresh_token, client_id, scope, access_expires_at, refresh_expires_at, created_at FROM oauth_access_tokens WHERE refresh_token = ?",
    );
    const deleteByAccess = db.prepare<[string]>(
      "DELETE FROM oauth_access_tokens WHERE access_token = ?",
    );
    const consumeRefreshTx = db.transaction(
      (refreshToken: string, nowMs: number): OAuthTokenPair | undefined => {
        const row = selectByRefresh.get(refreshToken) as TokenRow | undefined;
        if (!row) return undefined;
        deleteByAccess.run(row.access_token);
        if (row.refresh_expires_at <= nowMs) return undefined;
        return rowToTokenPair(row);
      },
    );
    this.getAndDeleteRefreshStmt = (rt, nowMs) => consumeRefreshTx(rt, nowMs);
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

  async saveAuthCode(record: OAuthAuthCodeRecord): Promise<void> {
    this.insertAuthCodeStmt.run(
      record.code,
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
    return this.getAndDeleteAuthCodeStmt(code, now.getTime());
  }

  async saveTokenPair(pair: OAuthTokenPair): Promise<void> {
    this.insertTokenStmt.run(
      pair.accessToken,
      pair.refreshToken,
      pair.clientId,
      pair.scope,
      pair.accessExpiresAt.getTime(),
      pair.refreshExpiresAt.getTime(),
      pair.createdAt.getTime(),
    );
  }

  async getAccessToken(
    accessToken: string,
    now: Date,
  ): Promise<OAuthTokenPair | undefined> {
    const row = this.getAccessTokenStmt.get(accessToken) as
      | TokenRow
      | undefined;
    if (!row) return undefined;
    if (row.access_expires_at <= now.getTime()) return undefined;
    return rowToTokenPair(row);
  }

  async consumeRefreshToken(
    refreshToken: string,
    now: Date,
  ): Promise<OAuthTokenPair | undefined> {
    return this.getAndDeleteRefreshStmt(refreshToken, now.getTime());
  }
}
