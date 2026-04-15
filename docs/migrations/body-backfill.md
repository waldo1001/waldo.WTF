# body-backfill

**Status**: active
**Added**: 2026-04-15
**One-line**: Derives plain `body` from `body_html` in place for every
message that has HTML but no plain text, then rebuilds the FTS5 index
so mail content is searchable.

## Why

First live smoke of the NAS container after Weekend 5 surfaced that
Claude couldn't read mail bodies. The MCP tools return snippets, but:

1. **FTS5 indexes only the `body` column.** Outlook mails arrive with
   `contentType: "html"` and the Weekend 2 sync writer stored them in
   `body_html`, leaving `body` NULL. So FTS matched only subject +
   sender, and `snippet()` returned NULL because column 0 (`body`) was
   empty — Claude saw `snippet: null` on every hit.
2. **The `get_recent_activity` tool fell back to slicing `body_html`.**
   The first 280 chars of any mail's HTML is the `<head><meta><style>…`
   boilerplate, so every snippet looked like garbage.

Fix (Slice A of `docs/plans/fix-message-bodies-slice-a-backfill.md`):
new `htmlToText` helper, new sync mapper that populates both
`bodyHtml` and `body` going forward, schema v5 → v6 marker, and this
one-shot in-place backfill for the ~36k existing messages. No Graph
refetch — the HTML is already on disk.

## Prerequisites

- Container image must contain `src/cli.ts --backfill-bodies` flag
  (shipped in the same deploy; routine `/deploy-nas` builds + ships it).
- Pre-migration `PRAGMA user_version` must be `5`. If it's already `6`,
  the migration is a no-op (safe — the `WHERE body IS NULL` filter is
  self-healing) but there's no reason to run it.
- `node-html-parser` is a runtime dependency (already in `package.json`
  since 2026-04-15).
- NAS has `/volume1/docker/waldo-wtf/db/lake.db` on internal SSD, not
  SMB (Weekend 5 manual Part D).

## Pre-verify

```sh
sudo docker run --rm -v /volume1/docker/waldo-wtf/db:/db keinos/sqlite3 \
  sqlite3 "file:/db/lake.db?immutable=1" \
  "PRAGMA user_version; SELECT COUNT(*) FROM messages WHERE body IS NULL AND body_html IS NOT NULL;"
```

Expected: two lines —
- `5` (the current schema version before the migration runs).
- A non-zero count — this is "how much work the backfill has to do".
  On the production lake at first run this was `39537`. A fresh-ish
  install might be smaller.

If the first line is already `6` and the count is `0`, the migration
has already run on this lake — skip it.

**Note**: the `immutable=1` URI is required because the `keinos/sqlite3`
image runs as root (UID 0) and the lake is owned by UID 1000, which
makes WAL-mode file locking fail with `attempt to write a readonly
database (8)`. `immutable=1` tells SQLite to read the file directly
without touching the WAL or SHM files at all.

## Command

```sh
sudo docker compose run --rm waldo --backfill-bodies
```

Do **not** override the entrypoint with `--entrypoint node ...`. The
image's default entrypoint is `node_modules/.bin/tsx src/cli.ts`, and
the `--backfill-bodies` flag gets appended to it. Running `node
--experimental-strip-types src/cli.ts ...` fails with
`ERR_MODULE_NOT_FOUND` for `./config.js` because Node can't rewrite
TypeScript's `.js` imports the way tsx does.

Also: the compose service is named `waldo`, not `waldo-wtf`. The
container name is `waldo-wtf` and the image is `waldo-wtf:local`, but
`docker compose run` takes the service name from `docker-compose.yml`.

Expected output pattern:

```
◇ injected env (0) from .env // tip: ⌘ override existing { override: true }
  backfilled <N> rows (<Xs>)
backfill complete: <N> messages updated
Backfill done: <N> messages updated
```

Expected wall-clock: a few minutes. On the DS223 internal SSD against
~40k messages, the first production run took 255 seconds (≈4m15s).
Most of that is the FTS5 `rebuild` phase — it runs silently after the
last row update and scans every message to recompute the shadow
tables.

## Post-verify

```sh
sudo docker run --rm -v /volume1/docker/waldo-wtf/db:/db keinos/sqlite3 \
  sqlite3 "file:/db/lake.db?immutable=1" \
  "PRAGMA user_version; SELECT COUNT(*) FROM messages WHERE body IS NULL AND body_html IS NOT NULL;"
```

Expected: two lines —
- `6` (schema version advanced).
- `0` (every row with HTML content now has a derived plain-text body).

If `user_version` is still `5`, the migration did not commit — restore
the snapshot and investigate.

If the count is non-zero, some rows could not be converted. This should
never happen with the current `node-html-parser`-backed helper (it does
not throw on malformed HTML), but if it does, check the backfill output
for errors and consider raising the `chunkSize` default or running a
second pass.

## Rollback

The skill creates a snapshot at
`/volume1/docker/waldo-wtf/db/lake.db.pre-body-backfill-YYYYMMDD`
before running the migration. If post-verify fails:

```sh
sudo docker compose stop
sudo mv db/lake.db db/lake.db.broken
sudo mv db/lake.db.pre-body-backfill-YYYYMMDD db/lake.db
sudo rm -f db/lake.db-wal db/lake.db-shm
sudo docker compose up -d
```

Delta tokens are untouched by the backfill (it only updates the
`body` column), so the 5-minute sync scheduler resumes from the same
state. No MSAL re-login required. The system returns bit-for-bit to
pre-migration state, with `user_version=5`, NULL Outlook bodies, and
broken FTS for Outlook.

Once you're confident the backfill is good (give it a day of normal
use), delete the snapshot:

```sh
sudo rm db/lake.db.pre-body-backfill-*
```

## Idempotence

**Safe to re-run.** The backfill's `SELECT ... WHERE body IS NULL AND
body_html IS NOT NULL` filter skips rows that already have a
populated `body`. A second run processes 0 rows and exits cleanly.
The FTS5 rebuild runs regardless — that's fine, it's idempotent too.

## Risks

- **R1: `htmlToText` produces subtly-wrong plain text for some
  malformed mails.** Mitigation: `node-html-parser` tolerates
  malformed HTML. The worst case is a stray `<` surviving, which is
  cosmetic not data-loss. The backfill is re-runnable from `body_html`
  at any time with an improved stripper.
- **R2: FTS5 rebuild takes longer than expected on a much larger
  lake.** The rebuild scans every row. On 40k messages it took ~3
  minutes; on 400k it would be ~30 minutes. Budget accordingly.
- **R3: Lake grows because `body` is new data.** Expected: on the
  current lake the size went from 842 MB to ~(slightly more). WAL
  gets truncated at the end, so post-migration `lake.db` is the
  authoritative size.
- **R4: The running container tries to write to the lake during the
  backfill.** Mitigation: the skill stops the container first
  (`docker compose stop`) and doesn't restart until post-verify passes.

## Smoke prompt (for Claude Desktop after the migration)

Ask Claude:

> *Search my mail for a word that's likely to be in a body but unlikely
> to be in a subject line — e.g. "factuur", "deadline", "meeting". Show
> me the raw snippet field it returns for the top hit, verbatim.*

**Success signal**: the `snippet` field contains a readable sentence
fragment with actual context around the word, not `<html><head><meta>…`
boilerplate and not `null`.

**Failure signal**: still `null` or still HTML — means either the
backfill didn't run, the FTS rebuild didn't complete, or Claude Desktop
is caching the old tool responses (restart Claude Desktop with Cmd+Q
and relaunch).
