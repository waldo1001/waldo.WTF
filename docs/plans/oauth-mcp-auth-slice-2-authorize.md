# OAuth MCP — Slice 2: Authorization endpoint + consent

Parent: [oauth-mcp-auth.md](oauth-mcp-auth.md)

## Task

Add `GET /oauth/authorize` (consent HTML) and `POST /oauth/authorize` (admin-
password check → auth code) to the MCP HTTP server. The `oauth_auth_codes`
table is added as schema v8. A new `PasswordHasher` seam handles scrypt
hashing at server start and verify at consent time.

## Scope boundary

**In scope:**

- `GET /oauth/authorize` validates PKCE params + client registration, renders
  an HTML consent form (no external stylesheet — inline minimal CSS).
- `POST /oauth/authorize` verifies admin password (scrypt, timing-safe),
  issues a 10-minute opaque auth code, stores
  `{ clientId, redirectUri, scope, codeChallenge, state, expiresAt }`,
  redirects to `redirect_uri?code=xxx[&state=yyy]`.
- Wrong-password case: re-render the consent form with an error message
  (inline HTML, 401 status, no redirect).
- PKCE: `code_challenge_method=S256` required; `code_challenge` stored verbatim
  for slice 3 to verify.
- `PasswordHasher` interface + `scryptPasswordHasher` (N=16384,r=8,p=1)
  + `PlaintextPasswordHasher` (test fake).
- `AuthStore` extended: `saveAuthCode`, `consumeAuthCode` (atomic delete +
  return, undefined if missing or expired).
- `InMemoryAuthStore` + `SqliteAuthStore` updated to implement new methods.
- Schema v8: `oauth_auth_codes` table.
- `OAuthHttpOptions` gains `adminPasswordHash?: string` (computed at startup
  in `index.ts`) and `hasher?: PasswordHasher`.
- If `adminPasswordHash` is absent, `/oauth/authorize` returns 503.

**Out of scope (deferred):**

- `/oauth/token` — slice 3.
- MCP resource guard — slice 4.
- Consent page styling beyond minimal inline CSS.
- Error redirects (`error=access_denied`) for wrong-password — inline page is
  enough for single-admin system.

## Files to create / touch

**New:**
- `src/auth/oauth/password.ts` + `.test.ts`
- `src/auth/oauth/authorize.ts` + `.test.ts`

**Edited:**
- `src/auth/oauth/auth-store.ts` — add `OAuthAuthCodeRecord`, `saveAuthCode`,
  `consumeAuthCode`
- `src/auth/oauth/auth-store-contract.ts` — auth code contract tests
- `src/testing/in-memory-auth-store.ts` — Map + auth code methods
- `src/auth/oauth/sqlite-auth-store.ts` — auth code statements
- `src/store/schema.ts` — MIGRATION_8 (`oauth_auth_codes`)
- `src/store/schema.test.ts` — v8 migration tests
- `src/mcp/http-server.ts` — mount GET/POST /oauth/authorize
- `src/mcp/http-server.test.ts` — authorize route tests
- `src/index.ts` — hash admin password at startup

## RED test list

- schema: `"creates oauth_auth_codes table on v7→v8"`
- schema: `"oauth_auth_codes PRIMARY KEY rejects duplicate code on raw insert"`
- schema: `"v7→v8 preserves oauth_clients data"`
- password: `"scryptPasswordHasher.hash produces a non-empty string"`
- password: `"scryptPasswordHasher.verify returns true for correct password"`
- password: `"scryptPasswordHasher.verify returns false for wrong password"`
- auth-store-contract: `"saveAuthCode persists code retrievable via consumeAuthCode"`
- auth-store-contract: `"consumeAuthCode deletes the code (second call returns undefined)"`
- auth-store-contract: `"consumeAuthCode returns undefined for unknown code"`
- auth-store-contract: `"consumeAuthCode returns undefined for expired code"`
- authorize: `"handleAuthorizeGet returns 200 HTML with consent form for valid params"`
- authorize: `"handleAuthorizeGet returns 400 for unknown client_id"`
- authorize: `"handleAuthorizeGet returns 400 for unregistered redirect_uri"`
- authorize: `"handleAuthorizeGet returns 400 for missing code_challenge"`
- authorize: `"handleAuthorizeGet returns 400 for code_challenge_method != S256"`
- authorize: `"handleAuthorizeGet returns 400 for response_type != code"`
- authorize: `"handleAuthorizePost with correct password redirects 302 with code"`
- authorize: `"handleAuthorizePost includes state in redirect when present"`
- authorize: `"handleAuthorizePost omits state from redirect when absent"`
- authorize: `"handleAuthorizePost with wrong password returns 401 HTML"`
- authorize: `"handleAuthorizePost with missing adminPasswordHash returns 503"`
- http-server: `"GET /oauth/authorize returns 200 HTML without bearer auth"`
- http-server: `"POST /oauth/authorize with correct password returns 302"`
- http-server: `"POST /oauth/authorize with wrong password returns 401"`
- http-server: `"GET /oauth/authorize without oauth configured returns 404"`
