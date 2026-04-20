# Plan — WALDO_BACKFILL_DAYS: cap initial delta backfill window

## Context

Today, the very first delta sync against a freshly logged-in account pulls the
entire Outlook inbox (and all Teams chats) — the spike saw ~36k messages / 724
pages for one dynex.be account. With multiple accounts that quickly bloats the
SQLite lake (waldo just hit 1 GB) and burns Graph quota on history nobody will
read.

Microsoft Graph delta endpoints honor a `$filter=<dateField> ge <iso>` on the
**first delta call only** — once a deltaLink is stored, the filter is baked in
and subsequent calls remain incremental from that point. So a one-time,
first-call-only filter is all that's needed to bound the historical window
without breaking the incremental contract.

This plan adds an optional `WALDO_BACKFILL_DAYS` env var. When set, the first
delta call for a given (account, source) uses `receivedDateTime ge now-Ndays`
(Outlook) or `lastModifiedDateTime ge now-Ndays` (Teams). Subsequent calls use
the stored deltaLink as today. Unset = current behavior (unbounded).

## Scope boundary

**IN**

- Optional `Config.backfillDays?: number` parsed from `WALDO_BACKFILL_DAYS`
  (positive integer, no default).
- `SyncSchedulerDeps.backfillDays?: number` plumbed from `main()`.
- `SyncInboxDeps` / `SyncTeamsDeps` gain optional `backfillDays?: number`
  (passed by scheduler).
- `sync-inbox` / `sync-teams`: when the stored sync state has no `deltaToken`
  AND `backfillDays` is set, compose the initial URL with
  `$filter=<dateField> ge <iso>` appended to the default endpoint. Otherwise
  unchanged.
- ISO cutoff = `clock.now() - backfillDays * 86400_000`, formatted as
  `toISOString()`.
- Filter URL composition lives in the sync layer, not the HTTP client — keeps
  `HttpGraphClient` / `HttpTeamsClient` ignorant of business rules and avoids
  touching either client. The sync layer already decides "this is the first
  call" (no `existing.deltaToken`), so it's the right place.
- Unit tests on both sync paths covering: (a) first call with `backfillDays`
  set composes a filtered URL, (b) first call without `backfillDays` composes
  the unfiltered default URL, (c) subsequent calls (`deltaToken` present)
  ignore `backfillDays` entirely, (d) the ISO date is computed from
  `clock.now()` (FakeClock-driven), (e) the filter is URL-encoded correctly so
  `:` and `+` in the ISO string don't break the query string.
- Config tests: parse valid `WALDO_BACKFILL_DAYS=30`, reject `0`/`-5`/`abc`,
  accept absent (undefined).
- `.env.example` documents the new var.
- Changelog entry.

**OUT**

- Backfilling/pruning existing data. Already-synced messages stay. If user
  wants a fresh narrow lake, they wipe `WALDO_DB_PATH` + `WALDO_AUTH_DIR` and
  re-login — documented in changelog as the reset recipe.
- Widening the window after the fact. Once a deltaLink is stored, the only way
  to widen is wipe + resync. Documented as a tradeoff, not solved.
- Pruning by age (deleting old rows from the lake). Separate concern, separate
  plan.
- A body-size cap (`WALDO_MAX_BODY_BYTES`). Mentioned earlier as a companion
  idea — out of scope here, file as a follow-up.
- Per-account backfill overrides. Single global value for v1.
- Changing `HttpGraphClient` / `HttpTeamsClient` signatures. They remain
  `getDelta(url, token)` and the sync layer hands them a pre-composed URL.
- Teams-specific quirks beyond the `$filter` field name swap. If
  `lastModifiedDateTime` filtering doesn't work on the Teams delta endpoint in
  practice, that's a follow-up — we'll discover it on smoke run and decide.

## Files to create / touch

- `src/config.ts` — add `backfillDays?: number` to `Config`; parse
  `WALDO_BACKFILL_DAYS` via existing `parsePositiveInt` pattern.
- `src/config.test.ts` — 4 new tests (valid, zero, negative, non-numeric,
  absent).
- `src/sync/sync-inbox.ts` — extend `SyncInboxDeps` with
  `backfillDays?: number`; when `existing?.deltaToken` is undefined and
  `backfillDays` is set, build URL with `?$filter=receivedDateTime ge ${iso}`
  appended (URL-encoded).
- `src/sync/sync-inbox.test.ts` — 4 new tests (see RED list).
- `src/sync/sync-teams.ts` — same shape, swap field name to
  `lastModifiedDateTime`.
- `src/sync/sync-teams.test.ts` — 4 new tests (parallel to inbox).
- `src/sync/sync-scheduler.ts` — add `backfillDays?: number` to
  `SyncSchedulerDeps`; pass through to both `syncInbox` and `syncTeams` calls.
- `src/sync/sync-scheduler.test.ts` — 1 new test confirming the value is
  forwarded.
- `src/index.ts` — read `config.backfillDays`, pass to new `SyncScheduler`.
  Composition root only, no test (it's coverage-excluded per policy and
  validated by smoke run).
- `.env.example` — document `WALDO_BACKFILL_DAYS` with a one-line description
  and a 30-day example commented out.
- `docs/changelog.md` — bullet under today's date including the
  "wipe-to-apply-retroactively" caveat.

## Seams involved

- config (env var → Config)
- graph / teams (no signature change; sync layer composes URL)
- clock (drives ISO cutoff; FakeClock in tests)
- scheduler (forwards new dep)

## RED test list

See plan preamble and methodology.md for full AC list. Highlights:

- AC1: `loadConfig` parses `WALDO_BACKFILL_DAYS=30` → `backfillDays === 30`;
  rejects `0`, `-5`, `abc`; absent → `undefined`.
- AC2: `syncInbox` first call with `backfillDays=30` composes
  `/me/mailFolders/inbox/messages/delta?$filter=receivedDateTime ge <iso>`
  with `<iso>` from `clock.now() - 30d`, URL-encoded.
- AC3: `syncInbox` first call without `backfillDays` uses the unfiltered
  default endpoint.
- AC4: `syncInbox` with a stored `deltaToken` ignores `backfillDays` entirely.
- AC5–AC7: parallel behaviors on `syncTeams` with field name
  `lastModifiedDateTime`.
- AC8: `SyncScheduler` forwards `backfillDays` from its deps to both
  `syncInbox` and `syncTeams` on every tick.

## Risks

- Teams filter field is wrong — mitigation: smoke run flags it immediately
  (Graph returns 400); fix is a one-line field-name swap.
- Date-skew between machines — `clock.now()` is local, ISO is UTC via
  `toISOString()`. Standard. No mitigation needed.
- User assumes setting the var prunes existing data — mitigation:
  `.env.example` comment + changelog explicitly call out the wipe-to-apply
  recipe.
- Coverage on touched files — adding a branch in sync-inbox/sync-teams
  requires both the "set" and "unset" branches under test.

## Out-of-scope follow-ups

- `WALDO_MAX_BODY_BYTES` — body truncation cap to bound row size.
- Age-based pruning (delete rows older than N days from the lake).
- Per-account backfill overrides.
- A `--reset` CLI flag that wipes db + auth-dir + delta-state in one shot.
- A "current backfill window" field surfaced via `get_sync_status`.

## Verification

1. Stop any running `tsx src/index.ts`.
2. Set `WALDO_BACKFILL_DAYS=7` in `.env`.
3. Wipe the dev data dir.
4. `npx tsx src/cli.ts --add-account` — log in.
5. `npx tsx src/index.ts` — first tick finishes in seconds; small
   `messagesAdded` count instead of churning for minutes.
6. `get_recent_activity { hours: 168 }` — oldest result within the last
   7 days.
7. Re-run — second run should be +0/-0 (incremental, deltaLink honored).
8. `npm test` — all green, ≥90% coverage on touched files.
9. `npm run typecheck` — clean.
10. `/security-scan` — PASS.
11. `/docs-update` — changelog updated.

## Outcome (2026-04-13)

Shipped. Live smoke on a clean dev db (`/Users/waldo/Temp/waldo.WTF.dev/`) with
two real accounts across two tenants and `WALDO_BACKFILL_DAYS=14`:

- Outlook both accounts **ok** on the first tick, seconds not minutes:
  `messagesAddedLastOk` = 666 / 546. Window filter is holding.
- Teams both accounts **error** with `HTTP 412 PreconditionFailed — Requested
  API is not supported in delegated context`. **Pre-existing blocker**,
  unrelated to this feature: `/me/chats/getAllMessages/delta` requires
  application permissions + Resource-Specific Consent and is not available
  under the delegated device-code flow waldo.WTF uses. Existed since Weekend 4
  slice 4; first surfaced today on live smoke. Filed as a separate plan:
  [teams-endpoint-rework.md](teams-endpoint-rework.md). The 412 correctly
  lands in `sync_log` — that signal is what found the hole, and is left in
  place as the regression guard.
