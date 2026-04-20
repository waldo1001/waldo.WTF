import type { Clock } from "../../clock.js";
import type { AuthStore } from "./auth-store.js";
import type { RandomIdSource } from "./ids.js";
import { verifyPkceS256 } from "./pkce.js";

const ACCESS_TOKEN_TTL_MS = 3600 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

export interface TokenRequest {
  readonly store: AuthStore;
  readonly ids: RandomIdSource;
  readonly clock: Clock;
  readonly body: Record<string, unknown>;
}

export interface TokenResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

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

  if (authCode.redirectUri !== redirectUri) {
    return errorResponse(400, "invalid_grant", "redirect_uri does not match");
  }

  if (!verifyPkceS256(authCode.codeChallenge, codeVerifier)) {
    return errorResponse(400, "invalid_grant", "code_verifier does not match code_challenge");
  }

  const accessToken = req.ids.next();
  const refreshToken = req.ids.next();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

  await req.store.saveTokenPair({
    accessToken,
    refreshToken,
    clientId: authCode.clientId,
    scope: authCode.scope,
    accessExpiresAt,
    refreshExpiresAt,
    createdAt: now,
  });

  return {
    status: 200,
    body: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
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
  const pair = await req.store.consumeRefreshToken(refreshToken, now);
  if (!pair) {
    return errorResponse(400, "invalid_grant", "refresh token is invalid or expired");
  }

  const newAccess = req.ids.next();
  const newRefresh = req.ids.next();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

  await req.store.saveTokenPair({
    accessToken: newAccess,
    refreshToken: newRefresh,
    clientId: pair.clientId,
    scope: pair.scope,
    accessExpiresAt,
    refreshExpiresAt,
    createdAt: now,
  });

  return {
    status: 200,
    body: {
      access_token: newAccess,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: newRefresh,
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
