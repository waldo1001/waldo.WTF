# sent-items-schema

**Status**: active
**Added**: 2026-04-21
**One-line**: Schema v10 → v11 — adds `messages.from_me` and widens the
`sync_state` primary key to `(account, source, folder)` so Outlook Inbox
and Sent Items can each track their own delta cursor.

## Why

Weekend N+1 adds a second Outlook sync: `syncSent` reads
`/me/mailFolders/sentitems/messages/delta` and stores each row with
`from_me=1`. Two changes unlock that:

1. **`messages.from_me INTEGER NOT NULL DEFAULT 0`** — a boolean marker
   so `get_thread` can interleave inbound + outbound, `get_recent_activity`
   can set `replied=true` on threads whose latest row is the user's reply,
   and steering rules that target correspondents (`sender_email`,
   `sender_domain`, `body_contains`) can be carved out for the user's
   own replies. Folder is the source of truth — we do not try to match
   `from.emailAddress.address` against `account.username`, so shared
   mailbox shenanigans stay out of the way.
2. **`sync_state` gains a `folder TEXT NOT NULL DEFAULT ''` column and
   the PK becomes `(account, source, folder)`** so Sent Items can
   persist its own `@odata.deltaLink` without stomping the Inbox
   cursor. Inbox rows keep `folder=''` (written by `syncInbox` since
   Weekend 2); `syncSent` writes `folder='sentitems'`.

## Prerequisites

- Container image must contain the Sent Items sync (`src/sync/sync-sent.ts`)
  and the v11 migration (`src/store/schema.ts`). Both ship in the same
  deploy.
- Pre-migration `PRAGMA user_version` must be `10`. If it's already `11`,
  the migration is a no-op — the `migrateV11` function is defensive and
  checks `PRAGMA table_info` before mutating anything.
- Graph's `Mail.Read` scope already covers Sent Items — **no MSAL re-login
  required**.

## Pre-verify

```sh
sudo docker run --rm -v /volume1/docker/waldo-wtf/db:/db keinos/sqlite3 \
  sqlite3 "file:/db/lake.db?immutable=1" \
  "PRAGMA user_version;
   SELECT COUNT(*) FROM messages;
   SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name='from_me';
   SELECT COUNT(*) FROM pragma_table_info('sync_state') WHERE name='folder';"
```

Expected:
- `10` — current schema version.
- A non-zero messages count (this is "how many rows inherit `from_me=0`").
- `0` — `from_me` column not yet present.
- `0` — `folder` column not yet present.

If the first line is already `11`, skip — already migrated.

## Command

The v11 migration is **boot-automatic**: when the container starts with
the new image, `src/store/schema.ts` detects `user_version < 11` and
runs `migrateV11` inside a transaction. There is no separate
`--migrate sent-items-schema` flag because:

- `ALTER TABLE messages ADD COLUMN from_me INTEGER NOT NULL DEFAULT 0`
  is O(1) in SQLite ≥ 3.35 — it's a metadata-only change; rows expand
  lazily on read.
- The `sync_state` rewrite is O(N) in `sync_state` rows only (one row
  per account per source — a handful, not the full message count).

Standard `/deploy-nas` is enough:

```sh
/deploy-nas
```

The skill stops the container, ships the new image, restarts — at
which point the migration runs on first DB open. Watch logs for the
boot-migration line.

## Post-verify

```sh
sudo docker run --rm -v /volume1/docker/waldo-wtf/db:/db keinos/sqlite3 \
  sqlite3 "file:/db/lake.db?immutable=1" \
  "PRAGMA user_version;
   SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name='from_me';
   SELECT COUNT(*) FROM pragma_table_info('sync_state') WHERE name='folder';
   SELECT COUNT(*) FROM messages WHERE from_me = 1;
   SELECT account, source, folder, length(delta_token) FROM sync_state
     ORDER BY account, source, folder;"
```

Expected:
- `11` — schema version advanced.
- `1` — `from_me` column present on `messages`.
- `1` — `folder` column present on `sync_state`.
- `0` — no rows flagged fromMe yet (the first sync tick after boot will
  start backfilling Sent Items within `backfillDays`).
- Existing rows show `folder=''` (inbox cursor untouched). After the
  next sync tick, each account additionally grows a row with
  `folder='sentitems'`.

If `user_version` is still `10`, the boot migration did not commit —
restart the container; failing that, restore the snapshot and
investigate the `schema` init logs.

## Rollback

The skill creates a snapshot at
`/volume1/docker/waldo-wtf/db/lake.db.pre-sent-items-schema-YYYYMMDD`
before the migration runs (add a manual `cp` step if `/deploy-nas`
hasn't been updated to include this recipe in its auto-snapshot list
yet). If post-verify fails:

```sh
sudo docker compose stop
sudo mv db/lake.db db/lake.db.broken
sudo mv db/lake.db.pre-sent-items-schema-YYYYMMDD db/lake.db
sudo rm -f db/lake.db-wal db/lake.db-shm
sudo docker compose up -d
```

Delta tokens for Inbox are preserved on restore. No MSAL re-login
required. The system returns to v10: no `from_me`, no per-folder
`sync_state`, no Sent Items ingestion.

Once you're confident the new schema is healthy (give it 24h of normal
use and verify `replied=true` annotations start appearing in
`get_recent_activity` for threads you've replied to), delete the
snapshot:

```sh
sudo rm db/lake.db.pre-sent-items-schema-*
```

## Idempotence

**Safe to re-run.** `migrateV11` checks `PRAGMA table_info` before
altering either table, so running it against an already-v11 lake is a
no-op. If `user_version` is bumped back to 10 manually (for a rollback
dry-run), the migration restores v11 without data loss.

## Risks

- **R1: First post-migration sync tick backfills Sent Items inside
  `backfillDays`.** For an account with ~months of heavy email, this
  can pull a few hundred messages on the first tick. Expected; the
  delta cursor then takes over. Not a data-loss risk — just a brief
  spike in `get_sync_status` messagesAdded counts.
- **R2: Privacy surface grows.** The lake now stores the user's
  outgoing bodies. Still local-only; still write-only from the sync
  path (MCP tools remain read-only). Worth noting in user-guide.
- **R3: Steering carve-out changes muted_count semantics.** Rules
  targeting `sender_email` / `sender_domain` / `body_contains` no
  longer mute the user's own replies. `muted_count` on
  `get_recent_activity` reflects this — it reports what was actually
  muted, not what the rule would have matched in the v10 world.
  Thread-level rules (`thread_id`, `thread_name_contains`) still mute
  fromMe rows — muting a whole thread is a stronger intent.
- **R4: Sent Items sync failure drifts `replied` annotations.** If
  `syncSent` fails repeatedly while `syncInbox` keeps advancing, new
  replies won't be ingested and `replied=false` will stick even after
  the user replied. Surface to the operator via `get_sync_status`
  errors; permanent fix is out of scope here (follow-up: per-folder
  sync status display).

## Smoke prompt (for Claude Desktop after the migration)

Ask Claude:

> *In a thread where I've recently replied (from Outlook / Teams web),
> what's my last message? Show me the reply verbatim.*

**Success signal**: `get_thread` returns the reply interleaved in
`sent_at` order with `fromMe: true` on that message; the snippet /
body matches what the user actually sent.

**Failure signal**: the reply is missing, or `fromMe` is absent — means
either `syncSent` hasn't run yet (check `get_sync_status`) or the
migration didn't commit (see Post-verify).
