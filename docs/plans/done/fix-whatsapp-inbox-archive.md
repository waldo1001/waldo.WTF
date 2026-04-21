# Fix: WhatsApp inbox files stranded after container restart

## Context

On the production NAS, 5 WhatsApp export zips sat in
`/data/whatsapp-inbox/` for >5 minutes after a deploy restart and were
never moved to `/data/whatsapp-archive/`. The watcher emits its startup
log line (`whatsapp-watcher: watching …`) but no `whatsapp-watcher:
import failed …` and no successful-import log either — the files are
simply invisible to it.

**Root cause** — [src/fs-node.ts:51](../../src/fs-node.ts#L51)
constructs chokidar with `ignoreInitial: true`. Pre-existing files in
the watched directory do **not** fire an `add` event. Only files
created *after* chokidar reaches `ready` are seen. On every container
restart any file sitting in the inbox is orphaned forever (until the
operator touches it, or manually runs `--import-whatsapp`).

The manual CLI path [src/cli.ts:357](../../src/cli.ts#L357)
(`realImportWhatsApp`) already proves the design: it's `listDir` +
filter + `importWhatsAppFile` in a loop. The watcher needs the same
startup sweep before handing off to chokidar for incremental events.

**Secondary concern** — even with the sweep, the `fs.rename` failure
mode at [src/sync/import-whatsapp.ts:133](../../src/sync/import-whatsapp.ts#L133)
is only half-covered. `moveAcrossDevices` in
[src/fs-node.ts:6-18](../../src/fs-node.ts#L6-L18) handles `EXDEV`
(cross-filesystem) by falling back to `copyFile + unlink`, but an
intermediate error (copy succeeded, unlink failed; or EACCES on the
archive dir; or ENOSPC) still aborts the import mid-way and the
watcher's catch-all in
[src/sync/whatsapp-watcher.ts:28-31](../../src/sync/whatsapp-watcher.ts#L28-L31)
logs a generic `import failed for <path>: <msg>` without distinguishing
"parse failed" from "archive move failed". A message-level import
followed by a failed archive move means the messages are in the lake
but the file remains in the inbox — next restart, the sweep re-imports
the same content. `upsertMessages` dedupes on content-hashed `id` so
the lake stays consistent, but the log is noisy and the operator has
no signal the archive move is the broken step.

**Intended outcome** — container restarts don't strand files; each
failed import names its failing step; if a parse succeeds but archive
fails, we log *why* and leave the file in place for the next sweep
(idempotent re-import is already safe via content-hashed ids).

## User decisions (locked)

1. **Startup sweep is the fix, not flipping `ignoreInitial: false`.**
   Chokidar's `ignoreInitial: false` re-emits `add` for every file on
   every restart, which is fine for idempotent importers but couples
   chokidar timing (`awaitWriteFinish` debouncing) to bulk restart
   replay. A one-shot explicit `listDir` + sequential import at
   startup is clearer, testable without chokidar, and easier to log.
2. **Sequential not parallel.** Five zips at a time is the realistic
   load; `importWhatsAppFile` hits SQLite in a WAL transaction per
   file; parallelism buys nothing and complicates failure semantics.
3. **Archive failures leave the file in place.** Re-import is
   idempotent (content-hashed ids). Don't move to a quarantine dir,
   don't delete. The next sweep tries again.
4. **Split the watcher log into two event names** so the operator can
   distinguish parse failures from archive failures in `docker logs`.

## Scope boundary

**In this slice:**

- Startup inbox sweep in `startWhatsAppWatcher` (or a helper it calls).
- Split error-path logging into `parse_failed` / `archive_failed` /
  `import_failed` event names with structured fields.
- Unit tests for: pre-existing files are imported on startup, new
  files after startup still trigger via chokidar (regression guard),
  archive-failure path leaves file + logs the right event.

**Explicitly out:**

- Changing `ignoreInitial` on chokidar itself.
- Quarantine / dead-letter directory.
- Retry loop with backoff on transient archive failures (the next
  startup sweep is the retry).
- Fixing the Synology bind-mount layout if EXDEV is happening — that's
  infrastructure, not code; the existing `moveAcrossDevices` fallback
  already covers it.
- Emitting a metric / health-check signal for inbox backlog depth.

## Files to create / touch

- [src/sync/whatsapp-watcher.ts](../../src/sync/whatsapp-watcher.ts) —
  add startup sweep, split error logging.
- [src/sync/whatsapp-watcher.test.ts](../../src/sync/whatsapp-watcher.test.ts) —
  new RED tests (see below).
- [src/sync/import-whatsapp.ts](../../src/sync/import-whatsapp.ts) —
  throw typed error classes (`WhatsAppParseError`,
  `WhatsAppArchiveError`) so the watcher can discriminate, instead of
  a generic `Error`.
- [src/sync/import-whatsapp.test.ts](../../src/sync/import-whatsapp.test.ts) —
  RED tests for the new error classes.

No changes to [src/fs-node.ts](../../src/fs-node.ts),
[src/index.ts](../../src/index.ts),
[src/cli.ts](../../src/cli.ts), or migration infra.

## Seams involved

- **fs** — `listDir`, `watch`, `rename` (existing), `exists` (existing).
- **logger** — three new event names.
- **clock** — not needed; sweep is synchronous-ish, no backoff.
- No new seams.

## RED test list

- **AC1**: startup sweep imports pre-existing matching files.
  - test file: `src/sync/whatsapp-watcher.test.ts`
  - test name: `"imports files already present in the downloads directory at startup"`
  - seams: fs (in-memory with two pre-seeded `WhatsApp Chat - *.zip` files), logger
  - edge cases: sweep runs sequentially (importer resolves in order of `listDir`); non-matching filenames skipped.

- **AC2**: startup sweep happens *before* the watcher logs ready — or at
  least before returning the handle — so a caller awaiting the function
  can't miss sweep completion.
  - test name: `"completes startup sweep before returning the handle"`
  - seams: fs, logger
  - **design question**: `startWhatsAppWatcher` is currently sync. Changing
    it to async ripples into `src/index.ts`. Resolve by making the sweep
    fire-and-log in the background (log `sweep_complete` when done) but
    wire a test-only hook to await it. See Open questions.

- **AC3**: new file created after startup still fires via chokidar
  (regression guard against accidental `ignoreInitial: false` removal).
  - test name: `"imports new files that appear after startup via watch events"`
  - seams: fs (in-memory watch driver)

- **AC4**: parse failure logs `whatsapp_parse_failed` with `{ path,
  error }`, does NOT move the file.
  - test name: `"logs parse_failed and leaves file in place when parsing throws"`
  - seams: fs, logger
  - edge cases: importer throws a `WhatsAppParseError`.

- **AC5**: archive failure (rename throws) logs
  `whatsapp_archive_failed`, messages are still in the store, file
  stays in inbox.
  - test name: `"logs archive_failed and leaves file in place when archive move throws"`
  - seams: fs (rename that throws EACCES), store, logger

- **AC6**: re-running the sweep after an archive failure re-imports
  the same file idempotently (content-hashed ids; no duplicate rows).
  - test name: `"re-sweeping after archive failure is idempotent"`
  - seams: fs, store

- **AC7**: unknown importer error (neither parse nor archive error
  class) still logged as `whatsapp_import_failed` — backstop.
  - test name: `"logs import_failed for unknown errors"`

- **AC8** (`import-whatsapp.test.ts`): `importWhatsAppFile` throws
  `WhatsAppParseError` when the zip is malformed.
- **AC9** (`import-whatsapp.test.ts`): `importWhatsAppFile` throws
  `WhatsAppArchiveError` when `fs.rename` rejects.

## Open questions / assumptions

1. **Async startup** — does `startWhatsAppWatcher` become
   `async function`, or does sweep run in the background with a
   `sweepComplete: Promise<void>` exposed on the handle? **Assumption
   (flagged for confirmation)**: background sweep, expose
   `handle.sweepComplete` so production code ignores it and tests
   can await it. Keeps `src/index.ts` unchanged.
2. **Sweep ordering vs watch subscription** — if a file lands during
   the sweep, chokidar's `awaitWriteFinish` means it's seen later
   anyway; safe to subscribe first and sweep second without a race,
   because chokidar's `ignoreInitial: true` won't replay the file and
   the sweep picks it up. **Assumption**: subscribe, then sweep.
3. **Error class placement** — new classes live in
   `src/sync/import-whatsapp.ts` alongside `importWhatsAppFile`.
   Single-file scope, no new module.
4. **Does the sweep need a "done" log line?** Yes — `whatsapp_sweep_complete
   { files, imported }` so the operator can confirm in `docker logs`
   that the startup pass ran.

## Risks

- **R1**: sweep runs while initial Graph sync is still churning SQLite,
  causing WAL contention. `importWhatsAppFile` already uses short
  transactions; unlikely to matter at 5 files, but if it does, the
  sweep can `await` after each file. Mitigation is sequential by
  default anyway.
- **R2**: chokidar's `ready` fires before the background sweep
  completes; if a new file lands in the narrow window after
  subscription but before sweep pass, it's imported twice (once by
  chokidar, once by sweep). Idempotent upsert makes this a non-issue
  for data, but the archive-move race could produce a spurious
  `archive_failed` on the second attempt (file already moved).
  Mitigation: sweep's per-file block should `fs.exists(filePath)`
  before calling importer.
- **R3**: if the Synology has an actual cross-filesystem EXDEV
  between `/data/whatsapp-inbox` and `/data/whatsapp-archive`,
  `moveAcrossDevices` already falls back. If the failure mode is
  EACCES (wrong uid on the archive dir), the plan surfaces it in
  logs but doesn't fix it — operator must chown. Documented as an
  operator responsibility.

## Out-of-scope follow-ups

- Emitting an inbox-depth gauge on `/health` so an external monitor
  can alert on stuck files.
- Retry-with-backoff for transient failures (ENOSPC clearing up,
  network SMB flake) instead of wait-for-next-restart.
- Moving the inbox/archive bind mounts to a single Synology subvolume
  to sidestep any latent EXDEV concern entirely.
- Allowing `--import-whatsapp` to run alongside the long-running
  server (currently it opens its own `Database` which would contend
  on WAL).

## Critical files

- [src/sync/whatsapp-watcher.ts](../../src/sync/whatsapp-watcher.ts)
- [src/sync/whatsapp-watcher.test.ts](../../src/sync/whatsapp-watcher.test.ts)
- [src/sync/import-whatsapp.ts](../../src/sync/import-whatsapp.ts)
- [src/sync/import-whatsapp.test.ts](../../src/sync/import-whatsapp.test.ts)
- [src/fs-node.ts](../../src/fs-node.ts) — read-only reference
- [src/cli.ts:342-381](../../src/cli.ts#L342-L381) — pattern to mirror for the sweep

## Verification

- `npm test` green per slice.
- After deploy, `docker logs waldo-wtf` within the first 30s shows:
  - `whatsapp-watcher: watching /data/whatsapp-inbox for WhatsApp Chat*`
  - one `whatsapp_sweep_complete` event with `files` matching the
    inbox count before the restart
  - N `imported … from WhatsApp Chat - *.zip` lines (or N
    `whatsapp_archive_failed` with a readable errno if the archive
    dir is wrong)
- `ls /volume1/docker/waldo-wtf/whatsapp-inbox/` is empty after a
  healthy sweep; files appear under
  `/volume1/docker/waldo-wtf/whatsapp-archive/YYYY-MM/`.
- `list_threads(source: "whatsapp")` via MCP reports the expected
  count.
- Coverage: ≥90% line+branch on touched files per
  [docs/tdd/coverage-policy.md](../tdd/coverage-policy.md).
