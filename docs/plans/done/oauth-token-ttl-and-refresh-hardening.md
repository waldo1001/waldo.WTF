# OAuth access-token TTL + non-rotating refresh hardening

Diagnostic origin: `~/.claude/plans/zazzy-skipping-fog.md` (connector "no tools"
incident — server healthy, connector held expired creds and could not recover).

## Task
Raise the OAuth access-token TTL to 24h and make the `refresh_token` grant
non-rotating and non-bricking, so the Claude connector recovers from a missed
refresh instead of needing manual re-auth.

## Scope boundary
**IN**
- `ACCESS_TOKEN_TTL_MS` 1h → 24h in `src/auth/oauth/token.ts`.
- Replace destructive `consumeRefreshToken` with a non-destructive
  `refreshAccessToken` on the `AuthStore` interface + both implementations.
- `handleRefreshToken` reuses the same refresh token, mints a new access token,
  slides `refresh_expires_at` to now+30d; old access token stops validating.
- Fix latent bug: an expired/invalid refresh attempt must NOT mutate/delete state.
- Update the contract + token tests to encode the new behavior; update `docs/oauth.md`.

**OUT** (deferred)
- Pruning dead client registrations / expired token sweep.
- Any change to refresh-token absolute 30d lifetime, schema columns, or the
  read-only MCP tool surface.

## Files to create / touch
- `src/auth/oauth/token.ts` — TTL constant; `handleRefreshToken` rewrite.
- `src/auth/oauth/auth-store.ts` — swap `consumeRefreshToken` → `refreshAccessToken`.
- `src/auth/oauth/sqlite-auth-store.ts` — implement via single `UPDATE … WHERE refresh_token=? AND refresh_expires_at>?`.
- `src/testing/in-memory-auth-store.ts` — mirror non-destructive update.
- `src/auth/oauth/auth-store-contract.ts` — refresh contract tests.
- `src/auth/oauth/token.test.ts` — TTL + non-rotating refresh tests.
- `docs/oauth.md`, `docs/changelog.md` — doc updates (via /docs-update).

## Seams involved
store, clock, http (token route already wired at `http-server.ts:189`). No schema
migration — only existing columns are updated.

## RED test list
- AC1: `authorization_code` grant returns `expires_in === 86400`; `accessExpiresAt = now + 24h`.
  - token.test.ts: "issues access token with 24h TTL on valid code"
- AC2: `refresh_token` grant returns a **new** access token but the **same** refresh token.
  - token.test.ts: "refresh issues new access token and keeps the same refresh token"
- AC3: refresh slides `refresh_expires_at` to now+30d and new access token has 24h TTL.
  - token.test.ts / contract: "refresh slides refresh expiry and sets 24h access TTL"
- AC4: the same refresh token works twice in a row (non-bricking).
  - token.test.ts: "same refresh token still valid after a refresh"
- AC5: after refresh, the old access token no longer validates; the new one does.
  - contract: "refreshAccessToken invalidates the previous access token"
- AC6: expired refresh → `invalid_grant`, and the row is NOT mutated/deleted.
  - token.test.ts: "expired refresh token is rejected"; contract: "refreshAccessToken leaves the row intact on expired/unknown token"
- AC7: contract — `refreshAccessToken` updates access token + both expiries, keeps refresh token, returns pair; unknown/expired → undefined.
- AC8: regression — authorization_code, PKCE, auth-code, getAccessToken expiry tests stay green.

## Open questions / assumptions
- **Assumption (flagged):** dropping refresh-token rotation is acceptable for this
  single-user server behind Tailscale/Funnel; a leaked refresh token stays valid up
  to its 30d window rather than being single-use. Approved in the diagnostic plan.

## Risks
- Behavior change to refresh semantics could break MCP clients that *expect* a
  rotated refresh token — mitigated: reusing the presented token is RFC-compliant
  (rotation is optional) and strictly more lenient.
- `UPDATE` race on concurrent refreshes — both would land the same row; last write
  wins, both responses carry a valid (same) refresh token. Acceptable.

## Out-of-scope follow-ups
- Prune `ce6f…`/`58ac…` dead clients + expired token rows.
- Startup sweep of expired `oauth_access_tokens` / `oauth_auth_codes`.
