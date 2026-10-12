# S4 — Token storage, absolute lifetime, revoke CLI

Parent: [security-hardening.md](security-hardening.md)

## Goal
A copy of `lake.db` (nightly NAS backup) yields no usable tokens. No refresh
token lives forever. The operator can list and revoke clients without raw SQL.

## Design
- **Hash at rest**: store `sha256(token)` hex for access tokens, refresh tokens and
  auth codes. Look up by hash. Tokens are 256-bit random values, so an unsalted
  SHA-256 is appropriate (no KDF needed).
- **In-place migration, no forced re-consent**: a migration hashes the existing
  plaintext rows (`UPDATE … SET access_token = sha256(access_token)` done in JS,
  in one transaction), recorded in a `schema_meta`/`user_version` marker so it runs
  exactly once. **Existing claude.ai tokens keep working**, because the client still
  presents the plaintext and the server hashes it on lookup. This beats the prompt's
  "invalidate" fallback. Registered at `docs/migrations/oauth-token-hashing.md` for
  `/deploy-local --migrate`, and also idempotent at boot (safe either way).
- **Absolute lifetime**: a new column `grant_created_at` (backfilled with
  `created_at` for existing rows). Refresh slides `refresh_expires_at` to
  `min(now + 30d, grant_created_at + WALDO_OAUTH_MAX_GRANT_DAYS)`, default 180.
  Access expiry is also capped at the grant end.
- **Prune** expired token rows on refresh/save.
- **CLI**: `--list-oauth-clients` (id, name, redirect hosts, created, last token
  activity, active token count; **never prints tokens**) and
  `--revoke-oauth-client <id>` (deletes the client, its tokens and its codes in one transaction).

## Files
`src/store/schema.ts` (+ migration), `src/auth/oauth/sqlite-auth-store.ts`,
`auth-store.ts` (+ `revokeClient`, `listClientsWithStats`), `auth-store-contract.ts`,
`token.ts`, `oauth-config.ts`, `src/cli.ts`/`src/index.ts` CLI wiring,
`docs/migrations/oauth-token-hashing.md` + `INDEX.md`.

## RED test list
1. contract: after `saveTokenPair`, the raw DB row does **not** contain the plaintext access/refresh token (it equals the sha256 hex); `getAccessToken(plaintext)` works.
2. contract: auth code is stored hashed; `consumeAuthCode(plaintext)` works and is single-use.
3. migration: a db seeded with plaintext rows (fake token values) → after migration, a lookup by plaintext succeeds and the rows are hashed; running it twice is a no-op; `grant_created_at` is backfilled.
4. token: refresh at day 179 → `refresh_expires_at` ≤ grant + 180 d; refresh at day 181 → `invalid_grant`; the access token never outlives the grant.
5. config: `WALDO_OAUTH_MAX_GRANT_DAYS` default 180; invalid → error.
6. CLI `--list-oauth-clients`: output contains the client id/name/redirect host and contains **no token value** (asserted against seeded tokens).
7. CLI `--revoke-oauth-client <id>`: the client, tokens and codes are gone; its access token → 401 at `/mcp`; unknown id → non-zero exit with a clear message.
8. refresh/save prunes expired rows.

## Risks
- **The migration touches `lake.db` auth tables only**: no message data. Back up first (`/deploy-local` already snapshots? If not, the migration doc says: take a backup via `kickstart com.waldo.wtf.backup` first).
- If the migration goes wrong, the worst case is a forced re-consent on claude.ai (remove/re-add, `docs/oauth.md §6.1`). That's annoying, not a data loss.
- The 180-day cap means re-consent twice a year (decided).
