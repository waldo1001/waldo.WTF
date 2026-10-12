# S1 — OAuth flow integrity (consent phishing + small hardening)

Parent: [security-hardening.md](../security-hardening.md)

Status: **DONE 2026-10-12** (branch `security/hardening`).

## Goal
An auth code can only be minted for a registered client, to an allowlisted
redirect URI registered for that client, with S256 PKCE. The consent page shows
where the code will go. The token endpoint binds codes and refresh tokens to their client.

## Threat
An attacker registers `client_name: "Claude"` with `redirect_uris: ["https://evil.example/cb"]`
and sends waldo the real consent URL. waldo types the admin password, and the code
plus the attacker's own PKCE verifier become a token. Separately, a hand-crafted
POST can skip every GET-side check.

## Scope / files
- `src/auth/oauth/redirect-allowlist.ts` (new): `isRedirectAllowed(uri, allowlist)`.
  Exact match for https entries. `http://localhost` / `http://127.0.0.1` / `http://[::1]`
  on any port and any path. Rejects userinfo and fragments.
- `src/auth/oauth/oauth-config.ts`: `WALDO_OAUTH_REDIRECT_ALLOWLIST` (comma-separated),
  default `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback`,
  plus loopback always.
- `dcr.ts`: reject non-allowlisted redirect URIs (`invalid_redirect_uri`). Cap `client_name` length (64).
- `authorize.ts`: one shared `validateAuthorizeParams(store, params, allowlist)` used by
  **both** GET and POST (`response_type`, S256, `code_challenge` present and well-formed
  (43–128 base64url chars), client exists, redirect registered **and** allowlisted).
  The allowlist re-check at authorize time also neutralises clients registered
  **before** this change. The consent page shows **"After approval you'll be sent to:
  `<scheme://host>`"** prominently, plus the client name labelled as *self-declared*.
  Error pages use fixed messages, with no reflected input.
- `token.ts`: if `client_id` is present it must equal the code's / refresh pair's client → `invalid_grant`.
- `http-server.ts`: `writeHtml` adds `X-Frame-Options: DENY`,
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`,
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. The token and DCR JSON responses also get `Cache-Control: no-store`.

## RED test list
1. `redirect-allowlist`: claude.ai callback allowed; `https://evil.example/cb` rejected; `http://localhost:53682/callback` allowed; `http://127.0.0.1:1/x` allowed; `http://evil.localhost.example` rejected; `https://claude.ai.evil.example/api/mcp/auth_callback` rejected; userinfo (`https://claude.ai@evil.example/…`) rejected.
2. `oauth-config`: default allowlist when unset; custom list parsed; invalid entry → `OAuthConfigError`.
3. `dcr`: non-allowlisted https redirect → 400 `invalid_redirect_uri`; overlong `client_name` → 400.
4. `authorize GET`: pre-existing client with a non-allowlisted redirect → 400 (legacy neutralised).
5. `authorize POST` with the correct password: unknown client → 400, no code saved; redirect not registered → 400; method `plain` → 400; missing challenge → 400; malformed challenge → 400. **No code is ever saved and no 302 is issued in any of these.**
6. `authorize POST` happy path is unchanged (302 with code and state).
7. Consent page contains the redirect host and the "self-declared" label. A `<script>` in `client_name` is escaped.
8. Error pages don't contain the submitted `client_id` / `redirect_uri` text.
9. `token`: auth_code with a mismatching `client_id` → `invalid_grant`, and the code is consumed (no retry oracle); refresh with a mismatching `client_id` → `invalid_grant`; absent `client_id` still works (backward compatible with today's claude.ai behavior).
10. `http-server`: consent GET and error responses carry all four headers; the token response has `Cache-Control: no-store`.

## Risks
- claude.ai might use a callback URL not on the default list (e.g. a regional host). Mitigation: env-configurable, and a rejected DCR logs the offending URI (it's not a secret) so you can add it.
- Claude Desktop/Code use loopback callbacks on random ports. These are covered by the loopback rule.

## Out of scope
Rate limits (S3), token storage (S4).
