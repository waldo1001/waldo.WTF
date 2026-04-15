# Deploy: body-from-HTML backfill (one-shot)

Target: the running waldo.WTF container on the Synology DS223 (Weekend 5
deployment), pointed at the 882 MB production lake at
`/volume1/docker/waldo/db/lake.db`.

Goal: populate `messages.body` from `messages.body_html` in place for all
existing Outlook mail, rebuild the FTS5 index, and leave the delta tokens
untouched so normal sync resumes cleanly.

**Expected duration:** a few minutes wall-clock for ~36 000 messages on
the DS223's internal SSD. The FTS rebuild is the longest step.

**Blast radius:** writes to `lake.db` only. Does not touch `raw_json`,
`body_html`, `sync_state`, `chat_cursors`, `token-cache.json`, or any
Graph endpoint.

---

## Pre-flight (1 minute)

1. **SSH into the NAS** as the docker-capable user:
   ```sh
   ssh waldo@waldonas3
   ```

2. **Check the container is currently healthy**, then stop it. The
   backfill acquires an exclusive write handle on `lake.db` — it must
   not race the 5-minute sync scheduler.
   ```sh
   cd /volume1/docker/waldo
   sudo docker compose ps
   sudo docker compose stop
   ```

3. **Snapshot the lake.** 882 MB on the internal SSD is a sub-second `cp`.
   Keep the snapshot for 24 hours in case the backfill output looks
   wrong and you want to roll back.
   ```sh
   sudo cp db/lake.db db/lake.db.pre-backfill-$(date +%Y%m%d)
   sudo ls -lh db/lake.db*
   ```
   Expected: one `lake.db` ≈ 882 MB, one `lake.db.pre-backfill-…`
   ≈ 882 MB, possibly `lake.db-wal` / `lake.db-shm` (small).

4. **Verify schema version and the problem shape.** This confirms the
   backfill has something to do.
   ```sh
   sudo docker run --rm -v /volume1/docker/waldo/db:/db \
     keinos/sqlite3 sqlite3 /db/lake.db \
     "PRAGMA user_version; SELECT COUNT(*) FROM messages WHERE source='outlook' AND body IS NULL AND body_html IS NOT NULL;"
   ```
   Expected: `user_version` = 5 (pre-migration), and a non-zero count of
   NULL-body Outlook mails (probably most of your 36k).

## Run the backfill (2–5 minutes)

5. **Run the backfill via the existing container image** — no rebuild
   needed. The image entrypoint is already `tsx src/cli.ts`, so the
   flag just gets appended:
   ```sh
   sudo docker compose run --rm waldo --backfill-bodies
   ```

   Expected output — progress ticks in-place as each chunk commits,
   then a final line:
   ```
     backfilled 5000 rows (3.2s)
     backfilled 10000 rows (6.8s)
     ...
     backfilled 36154 rows (24.6s)
   Backfill done: 36154 messages updated
   ```

   The FTS5 `rebuild` runs after the last chunk — that's the step that
   takes noticeably longer than the row updates (it scans every row and
   rewrites the shadow tables). No progress output during rebuild; be
   patient.

6. **Verify the migration advanced and NULL bodies are gone.**
   ```sh
   sudo docker run --rm -v /volume1/docker/waldo/db:/db \
     keinos/sqlite3 sqlite3 /db/lake.db \
     "PRAGMA user_version; SELECT COUNT(*) FROM messages WHERE source='outlook' AND body IS NULL AND body_html IS NOT NULL;"
   ```
   Expected: `user_version` = 6, count = 0.

7. **Spot-check FTS** with a word you know is only in the HTML body of
   one specific mail (not in the subject or sender). If you don't have
   one handy, pick a recent mail, open it in Outlook, grep an unusual
   word, and search for it:
   ```sh
   sudo docker run --rm -v /volume1/docker/waldo/db:/db \
     keinos/sqlite3 sqlite3 /db/lake.db \
     "SELECT rowid, thread_name FROM messages_fts WHERE messages_fts MATCH 'yourword' LIMIT 5;"
   ```
   Expected: at least one hit, and the `thread_name` matches the mail
   you were thinking of.

## Restart and smoke test (2 minutes)

8. **Start the container back up.**
   ```sh
   sudo docker compose up -d
   sudo docker compose ps      # expect (healthy) within ~30s
   sudo docker compose logs --tail=30
   ```
   Expected log line within the first sync tick:
   `sync tick complete: N account(s), M ok, 0 error(s)`. Delta tokens
   were untouched, so this should be a `+0/-0` tick unless new mail
   arrived during the maintenance window.

9. **End-to-end smoke via Claude Desktop** (this is the acceptance
   criterion for the whole slice):
   - In Claude Desktop, ask: *"search my mail for yourword, and give
     me the snippet"*.
   - Expected: `search` returns a hit with a **non-null** `snippet` that
     contains the plain-text context around `yourword`, not
     `<html><head><meta>…`.
   - Then ask: *"show me what's in the 5 most recent mails from the
     last 24 hours"*.
   - Expected: `get_recent_activity` snippets are readable prose, not
     HTML boilerplate.

## Rollback (if anything looks wrong)

If `user_version` didn't advance, if the post-backfill NULL count is
still non-zero, or if the FTS spot-check returns nothing sensible:

```sh
sudo docker compose stop
sudo mv db/lake.db db/lake.db.broken
sudo mv db/lake.db.pre-backfill-$(date +%Y%m%d) db/lake.db
sudo rm -f db/lake.db-wal db/lake.db-shm
sudo docker compose up -d
```

The snapshot from step 3 is a bit-for-bit copy of the pre-migration
lake. Restoring it returns the system to exactly where it was (with
`user_version=5`, NULL bodies, and broken FTS for Outlook), and the
5-minute scheduler resumes from the same delta tokens. No data loss,
no re-login needed.

Once you're confident the backfill is good (give it a day of normal
use), delete the snapshot:

```sh
sudo rm db/lake.db.pre-backfill-*
```

## What this does NOT do

- **Does not refetch anything from Microsoft Graph.** The data to derive
  `body` from is already in `body_html` — no tokens, no network calls,
  no delta reset.
- **Does not touch `raw_json`.** That column remains as the untouched
  insurance copy of the original Graph DTO (populated since the
  2026-04-13 retrofit).
- **Does not touch Teams messages.** Teams already lands with plain
  `body` populated — only Outlook was broken.
- **Does not change the schema shape.** v5→v6 is a marker-only
  migration; no columns added, dropped, or renamed.
- **Does not expose full bodies through the MCP tools.** That's Slice B
  (a future `include_body` flag on `get_thread` / new `get_message`
  tool). Slice A only fixes snippets and FTS indexing — which is enough
  for Claude to actually *find* and *preview* mail content, which was
  the reported pain point.
