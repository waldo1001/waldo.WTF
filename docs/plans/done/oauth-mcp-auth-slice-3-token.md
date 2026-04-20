# OAuth MCP — Slice 3: Token endpoint

Parent: [oauth-mcp-auth.md](oauth-mcp-auth.md)

## Task

Add `POST /oauth/token` for both `authorization_code` and `refresh_token`
grants. PKCE S256 verification gates the code exchange. Access tokens are
opaque hex strings stored in `oauth_access_tokens` (1-hour TTL). Refresh
tokens live in `oauth_refresh_tokens` (30-day TTL) and rotate on use.

## Scope boundary

**In scope:**

- `pkce.ts` — pure `verifyPkceS256(challenge, verifier)` function.
- Schema v9 adds `oauth_access_tokens` and `oauth_refresh_tokens`.
- `AuthStore` gains `saveTokenPair`, `getAccessToken`, `consumeRefreshToken`
  (atomic rotate: delete old + write new pair).
- `token.ts` — `handleTokenRequest(req)` pure handler; returns
  `{status, body}`.
- `POST /oauth/token` route wired to `http-server.ts`.
- `access_token` TTL: 3600 s; `refresh_token` TTL: 30 days.
- Refresh-token rotation: each use invalidates old token, issues a new pair.
- Error responses follow RFC 6749 §5.2 (`error`, `error_description`).
- No `scope` response field needed (always `mcp`).

**Out of scope:**

- MCP resource guard (slice 4).
- Token introspection / revocation endpoints.
- Client authentication (public clients only, `token_endpoint_auth_method=none`).

## RED test list

- pkce: `"verifyPkceS256 returns true when verifier hashes to challenge"`
- pkce: `"verifyPkceS256 returns false for wrong verifier"`
- pkce: `"verifyPkceS256 returns false for empty verifier"`
- auth-store-contract: `"saveTokenPair persists both tokens"`
- auth-store-contract: `"getAccessToken returns undefined for unknown token"`
- auth-store-contract: `"getAccessToken returns undefined for expired token"`
- auth-store-contract: `"consumeRefreshToken returns pair and deletes old refresh token"`
- auth-store-contract: `"consumeRefreshToken returns undefined for unknown token"`
- auth-store-contract: `"consumeRefreshToken returns undefined for expired token"`
- token: `"authorization_code grant issues access + refresh tokens"`
- token: `"authorization_code grant fails PKCE check → 400 invalid_grant"`
- token: `"authorization_code grant with unknown code → 400 invalid_grant"`
- token: `"authorization_code grant with expired code → 400 invalid_grant"`
- token: `"authorization_code grant redirect_uri mismatch → 400 invalid_grant"`
- token: `"refresh_token grant rotates tokens"`
- token: `"refresh_token grant with unknown token → 400 invalid_grant"`
- token: `"refresh_token grant with expired token → 400 invalid_grant"`
- token: `"unknown grant_type → 400 unsupported_grant_type"`
- http-server: `"POST /oauth/token with valid code returns 200 + access_token"`
- http-server: `"POST /oauth/token with bad code returns 400 invalid_grant"`
