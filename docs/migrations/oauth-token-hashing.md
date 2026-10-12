# oauth-token-hashing

**Status**: active
**Added**: 2026-10-12
**One-line**: Schema v19 → v20. Hashes stored OAuth access tokens, refresh
tokens and auth codes **in place** (SHA-256) and adds
`oauth_access_tokens.grant_created_at` for the absolute grant lifetime.
Runs automatically at boot.

## Why

Security hardening S4 ([plan](../plans/done/security-hardening-s4-token-storage-lifetime.md)).
Before v20, `lake.db` held every OAuth secret in plaintext. The nightly NAS
backup copied them, so anyone with a backup could use the connector's tokens.
After v20 the database holds only `sha256(token)`. Clients still present the
plaintext, and the server hashes it on lookup, so **existing connectors keep
working**.

`grant_created_at` (backfilled from `created_at`, which records the original
code exchange) lets refresh stop at `WALDO_OAUTH_MAX_GRANT_DAYS` (default 180)
after consent. Before, the sliding 30-day refresh never ended.

## Prerequisites

- Code at or after the S4 commit on `security/hardening` (`src/store/schema.ts`
  `migrateV20`).
- Pre-migration `PRAGMA user_version` is `19`. At `20` it's a no-op:
  `migrateV20` checks for the `grant_created_at` column first, so it never
  hashes twice.
- **Take a backup first.** Hashing is one-way:
  `sudo launchctl kickstart system/com.waldo.wtf.backup`, then wait for the
  `backup.log` entry.

## Pre-verify (on the Mac mini)

```sh
sqlite3 "file:/Users/waldo/waldo-wtf/db/lake.db?mode=ro" \
  "PRAGMA user_version;
   SELECT COUNT(*) FROM oauth_access_tokens;
   SELECT COUNT(*) FROM pragma_table_info('oauth_access_tokens') WHERE name='grant_created_at';
   SELECT client_id, datetime(MIN(created_at)/1000,'unixepoch') FROM oauth_access_tokens GROUP BY client_id;"
```

Expected: `19`, a small token count, `0`, and the date of each client's
**oldest** grant. Any grant older than `WALDO_OAUTH_MAX_GRANT_DAYS` stops
refreshing immediately after the migration; that client must re-consent.

## Command

None. The migration runs inside `applyMigrations` on the first boot of the new
code (`/deploy-local` restarts the daemon). `--list-oauth-clients` also
migrates if the CLI happens to run first.

## Post-verify

```sh
sqlite3 "file:/Users/waldo/waldo-wtf/db/lake.db?mode=ro" \
  "PRAGMA user_version;
   SELECT length(access_token), length(refresh_token) FROM oauth_access_tokens LIMIT 3;
   SELECT COUNT(*) FROM oauth_access_tokens WHERE grant_created_at = 0;"
cd /Users/waldo/Sourcecode/waldo.wtf && npx tsx src/cli.ts --list-oauth-clients
```

Expected: `20`; every token column 64 characters long (a hex digest); `0` rows
with `grant_created_at = 0`. The CLI lists your clients with `active_grants`
of 1 or more. Then call a tool from the claude.ai connector; it should work
without re-adding.

## After the migration (recommended, once)

Pre-v20 backups on the NAS still hold the **same** tokens in plaintext, and
in-place hashing kept those tokens valid. To make those copies useless:

1. `--list-oauth-clients` → note the connector's client id(s).
2. Remove and re-add the waldo-wtf connector on claude.ai (one consent covers
   web, mobile and Desktop; see [oauth.md §6.1](../oauth.md)).
3. `--revoke-oauth-client <old id>` for the previous registration(s).

Pre-v20 backups rotate out after 14 days regardless.

## Rollback

- **Code rollback without a DB restore breaks all OAuth clients.** Old code
  looks tokens up by plaintext and finds only hashes. Fix by re-adding the
  connector after the rollback, or:
- **Full rollback**: stop the daemon, restore the pre-deploy `lake.db` backup,
  deploy the old commit, start. Sync data written since the backup is
  re-fetched by delta sync.
