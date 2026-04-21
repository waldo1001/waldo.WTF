# whatsapp-rethread

**Status**: active
**Added**: 2026-04-21
**One-line**: Heals bifurcated WhatsApp threads by normalizing
`thread_id`, rewriting `thread_name` to the group's latest-imported raw
value, recomputing each message `id` via the normalized chat name, and
dropping duplicate content across re-exports.

## Why

WhatsApp thread identity was filename-derived: `threadId = threadName =
<filename-chat-name>`. Re-exports of the same logical conversation
under slightly different filenames (e.g. `WhatsApp Chat - BC Dev
Talk.zip`, `WhatsApp Chat - BC Dev Talk (2).zip`, and `WhatsApp Chat -
General chat (BC Dev Talk).zip` — WhatsApp uses the `General chat`
prefix as a placeholder when exporting a named group) landed under two
or three different `thread_id`s. `get_thread` filters by exact
`thread_id = ?`, so once a thread bifurcated, `get_thread` could only
ever show one slice — the user reported seeing April-9 messages in
one query and April-20 messages in another for the same conversation
with no overlap.

Slice 2 of [../plans/done/fix-whatsapp-thread-bifurcation.md](../plans/done/fix-whatsapp-thread-bifurcation.md)
(as corrected by [../plans/done/fix-whatsapp-normalize-rule.md](../plans/done/fix-whatsapp-normalize-rule.md))
stopped the bleed: new WhatsApp imports normalize the chat name
(trim + collapse whitespace + strip trailing numeric ` (N)` counters +
unwrap `General chat (<name>)` placeholder) before computing
`thread_id` and the message `id` hash. That fixes future imports.
This migration is Slice 3 — heal the data already in the lake.

## Prerequisites

- Container image must contain `src/cli.ts --rethread-whatsapp` flag
  (shipped in the same deploy).
- `normalizeWhatsAppChatName` in `src/sync/whatsapp-map.ts` must be the
  slice-2 version (trim, whitespace collapse, trailing ` (…)` strip).
- NAS has `/volume1/docker/waldo-wtf/db/lake.db` on internal SSD.

## Pre-verify

```sh
sudo docker run --rm -v /volume1/docker/waldo-wtf/db:/db keinos/sqlite3 \
  sqlite3 "file:/db/lake.db?immutable=1" \
  "SELECT thread_id, thread_name, COUNT(*) AS n,
          datetime(MIN(sent_at)/1000, 'unixepoch') AS oldest,
          datetime(MAX(sent_at)/1000, 'unixepoch') AS newest
     FROM messages
     WHERE source = 'whatsapp' AND thread_id IS NOT NULL
     GROUP BY thread_id
     ORDER BY MAX(sent_at) DESC;"
```

Expected: one row per raw filename-derived chat name. Bifurcation
shows up as **two rows with the same human-readable display name but
distinct `thread_id` values**, each covering a disjoint date range.
If there's only one row per chat name, nothing to merge.

`list_threads(source: "whatsapp")` via the MCP tool shows the same
view once the container is running — use whichever is at hand.

## Command

```sh
# Dry run first (prints counts, writes nothing):
sudo docker compose run --rm waldo --rethread-whatsapp --dry-run

# Then the real run:
sudo docker compose run --rm waldo --rethread-whatsapp
```

The `/deploy-nas` skill wires this via `--migrate whatsapp-rethread`
and `--migrate whatsapp-rethread --dry-run`.

Expected output pattern:

```
◇ injected env (0) from .env
rethread-whatsapp complete: <R> rows updated, <D> duplicates dropped
  across <M>/<G> groups
WhatsApp rethread done: <R> rows updated, <D> duplicates dropped
  across <M>/<G> groups
```

- `G` is the total number of distinct normalized WhatsApp threads
  after the migration.
- `M` is the number of those that were bifurcated before (had >1 raw
  `thread_id` collapsed into one).
- `R` is the number of rows whose `id` / `thread_id` / `thread_name`
  changed in place.
- `D` is the number of rows deleted because their recomputed `id`
  collided with another row's id and the other row had a higher
  `imported_at` (or this row did and the other was removed).

A non-bifurcated lake reports `M=0, R=0, D=0` — safe no-op.

## Post-verify

```sh
sudo docker run --rm -v /volume1/docker/waldo-wtf/db:/db keinos/sqlite3 \
  sqlite3 "file:/db/lake.db?immutable=1" \
  "SELECT thread_id, thread_name, COUNT(*) AS n
     FROM messages
     WHERE source = 'whatsapp' AND thread_id IS NOT NULL
     GROUP BY thread_id
     ORDER BY MAX(sent_at) DESC;"
```

Expected: one row per **logical** chat. Previously-bifurcated
`"BC Dev Talk"` + `"BC Dev Talk (2)"` + `"General chat (BC Dev Talk)"`
collapse to a single row with the union of their message counts.
`thread_name` reflects the raw filename-derived value from the most
recently imported export in the group.

Smoke from Claude Desktop:

> *Show me the full "General chat" thread.*

Expected: messages span the full date range (e.g. April 9 through
April 21), not just one half.

## Rollback

The `/deploy-nas` skill creates a snapshot at
`/volume1/docker/waldo-wtf/db/lake.db.pre-whatsapp-rethread-YYYYMMDD`
before running the migration. If post-verify fails:

```sh
sudo docker compose stop
sudo mv db/lake.db db/lake.db.broken
sudo mv db/lake.db.pre-whatsapp-rethread-YYYYMMDD db/lake.db
sudo rm -f db/lake.db-wal db/lake.db-shm
sudo docker compose up -d
```

No MSAL / Graph state is touched — WhatsApp imports are filesystem
based, and the 5-minute Graph sync scheduler is independent of this
migration.

## Idempotence

**Safe to re-run.** The migration is a no-op on a lake that's already
converged: for every row, the computed `newId` matches the current
`id`, the `newThreadId` matches the current `thread_id`, and the
canonical `thread_name` matches the current value, so the plan list is
empty and no writes happen.

## Risks

- **R1: `normalizeWhatsAppChatName` normalizes two logically-distinct
  chats to the same string.** The rule only strips trailing numeric
  ` (N)` counters (re-export artifacts) and only unwraps
  `General chat (<name>)` where `<name>` is non-empty and non-numeric
  (WhatsApp placeholder pattern for named groups). `"Work"` and
  `"Work (Belgium)"` stay separate; `"BC Dev Talk"` and
  `"BC Dev Talk (2)"` merge — intended. If a false-merge does slip
  through in practice, re-export the chats and import them fresh after
  rolling back from the snapshot. There's no automatic un-merge.
- **R2: Content-id collision across re-exports when `imported_at` is
  identical on both rows.** The tiebreak is `existing.importedAt >=
  p.importedAt` — the pre-existing row wins. Safe: one of the two
  rows is a byte-for-byte duplicate (same sender / sentAt / body under
  the same normalized chat), so keeping either is semantically equal.
- **R3: FTS triggers fire once per `UPDATE`.** On a lake with many
  bifurcations the migration can take a few seconds per thousand rows
  updated. The whole operation runs in a single transaction, so WAL
  stays bounded.

## Smoke prompt (for Claude Desktop after the migration)

> *List every WhatsApp thread in the lake. Is "General chat" one row
> or two? What's the newest message in it?*

**Success signal**: one row, newest message is the most recent one you
re-exported (e.g. April 21 2026).

**Failure signal**: still two rows, or the newest message is much
older than expected — re-run the dry-run to inspect counts, and check
whether Claude Desktop is caching stale tool responses (`Cmd+Q` and
relaunch).
