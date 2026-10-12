import type { Clock } from "../../clock.js";
import type { AuthStore } from "./auth-store.js";
import type { RandomIdSource } from "./ids.js";
import { verifyPkceS256 } from "./pkce.js";

const ACCESS_TOKEN_TTL_MS = 24 * 3600 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

export interface TokenRequest {
  readonly store: AuthStore;
  readonly ids: RandomIdSource;
  readonly clock: Clock;
  /** Absolute lifetime of a grant from its original consent; refresh never extends past it. */
  readonly maxGrantMs: number;
  readonly body: Record<string, unknown>;
}

export interface TokenResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

// Public clients (token_endpoint_auth_method "none") may omit client_id;
// when they do send it, it must match the grant it is redeeming.
const presentedClientId = (body: Record<string, unknown>): string | undefined =>
  typeof body.client_id === "string" && body.client_id !== ""
    ? body.client_id
    : undefined;

const expiresInSeconds = (expiresAt: Date, now: Date): number =>
  Math.floor((expiresAt.getTime() - now.getTime()) / 1000);

const errorResponse = (
  status: number,
  error: string,
  description: string,
): TokenResponse => ({
  status,
  body: { error, error_description: description },
});

async function handleAuthorizationCode(
  req: TokenRequest,
  body: Record<string, unknown>,
): Promise<TokenResponse> {
  /* c8 ignore next 3 -- null branches handled by grant_type dispatch; missing fields become "" */
  const code = String(body.code ?? "");
  const redirectUri = String(body.redirect_uri ?? "");
  const codeVerifier = String(body.code_verifier ?? "");

  if (!code || !codeVerifier) {
    return errorResponse(400, "invalid_request", "code and code_verifier are required");
  }

  const now = req.clock.now();
  const authCode = await req.store.consumeAuthCode(code, now);
  if (!authCode) {
    return errorResponse(400, "invalid_grant", "authorization code is invalid or expired");
  }

  const clientId = presentedClientId(body);
  if (clientId !== undefined && clientId !== authCode.clientId) {
    return errorResponse(400, "invalid_grant", "client_id does not match the authorization code");
  }

  if (authCode.redirectUri !== redirectUri) {
    return errorResponse(400, "invalid_grant", "redirect_uri does not match");
  }

  if (!verifyPkceS256(authCode.codeChallenge, codeVerifier)) {
    return errorResponse(400, "invalid_grant", "code_verifier does not match code_challenge");
  }

  const accessToken = req.ids.next();
  const refreshToken = req.ids.next();
  const grantEndMs = now.getTime() + req.maxGrantMs;
  const accessExpiresAt = new Date(
    Math.min(now.getTime() + ACCESS_TOKEN_TTL_MS, grantEndMs),
  );
  const refreshExpiresAt = new Date(
    Math.min(now.getTime() + REFRESH_TOKEN_TTL_MS, grantEndMs),
  );

  await req.store.saveTokenPair({
    accessToken,
    refreshToken,
    clientId: authCode.clientId,
    scope: authCode.scope,
    accessExpiresAt,
    refreshExpiresAt,
    createdAt: now,
    grantCreatedAt: now,
  });

  return {
    status: 200,
    body: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresInSeconds(accessExpiresAt, now),
      refresh_token: refreshToken,
      scope: authCode.scope,
    },
  };
}

async function handleRefreshToken(
  req: TokenRequest,
  body: Record<string, unknown>,
): Promise<TokenResponse> {
  /* c8 ignore next -- null branch: missing refresh_token becomes "" which fails !refreshToken check */
  const refreshToken = String(body.refresh_token ?? "");
  if (!refreshToken) {
    return errorResponse(400, "invalid_request", "refresh_token is required");
  }

  const now = req.clock.now();
  const newAccess = req.ids.next();
  const expectedClientId = presentedClientId(body);

  // Non-rotating refresh: reuse the same refresh token, mint a fresh access
  // token, slide the refresh expiry — but never past the grant's absolute
  // cap. A lost response can be retried safely because the presented
  // refresh token stays valid.
  const pair = await req.store.refreshAccessToken({
    refreshToken,
    now,
    newAccessToken: newAccess,
    accessTtlMs: ACCESS_TOKEN_TTL_MS,
    refreshTtlMs: REFRESH_TOKEN_TTL_MS,
    maxGrantMs: req.maxGrantMs,
    ...(expectedClientId !== undefined ? { expectedClientId } : {}),
  });
  if (!pair) {
    return errorResponse(400, "invalid_grant", "refresh token is invalid or expired");
  }

  return {
    status: 200,
    body: {
      access_token: newAccess,
      token_type: "Bearer",
      expires_in: expiresInSeconds(pair.accessExpiresAt, now),
      refresh_token: refreshToken,
      scope: pair.scope,
    },
  };
}

export async function handleTokenRequest(
  req: TokenRequest,
): Promise<TokenResponse> {
  const body = req.body;
  const grantType = body.grant_type;

  if (!grantType) {
    return errorResponse(400, "invalid_request", "grant_type is required");
  }
  if (grantType === "authorization_code") {
    return handleAuthorizationCode(req, body);
  }
  if (grantType === "refresh_token") {
    return handleRefreshToken(req, body);
  }
  return errorResponse(
    400,
    "unsupported_grant_type",
    `grant_type '${String(grantType)}' is not supported`,
  );
}
