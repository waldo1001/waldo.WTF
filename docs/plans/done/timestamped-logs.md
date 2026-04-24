# Plan: Prefix log lines with ISO timestamps

## Task

Make `docker compose logs --tail=N` (and every other place waldo.WTF's
stdout ends up — journalctl, piped tails, diagnostic screenshots) show
*when* each line was emitted, without the operator needing to remember
`--timestamps`.

## Context — why this is needed

During the 2026-04-22 Viva auth-scope deploy, `docker compose logs
--tail=30` showed 17 identical lines:

```
waldo-wtf  | sync tick complete: 4 account(s), 0 ok, 12 error(s)
```

There was no way to tell from the log alone whether:
- the scheduler was still ticking (old errors persisting) or
- the scheduler had stalled (one bad tick repeating in the buffer)

We had to cross-check `sync_log` by ts to work out that the ticks WERE
advancing and that re-consent had landed for 2 of 4 accounts. Timestamps
on each line would have answered the question in one glance.

`docker compose logs --timestamps` solves this at the Docker layer, but
it's:
1. off by default — every operator has to remember the flag,
2. invisible anywhere logs are consumed without Docker (e.g. `tee`'d
   files, error screenshots the operator pastes in chat,
   journalctl/container log dashboards on the NAS).

Baking the timestamp into the app's own log line is cheap and fixes all
three consumption paths uniformly.

## Scope boundary

**In scope:**

1. Prefix every `Logger.info` / `Logger.error` output with
   `[YYYY-MM-DDTHH:MM:SS.sssZ] ` (ISO-8601 UTC, millisecond precision).
2. Timestamp comes from an injected `Clock`, not from `new Date()` — the
   project already has a Clock seam and this is a composition-root
   construction detail, not a "now is now" call inside business logic
   (see [testability-patterns.md §3](../tdd/testability-patterns.md)).
3. Construction lives in `src/logger.ts` via a
   `createTimestampedConsoleLogger(clock)` factory. The existing
   `consoleLogger` constant stays exported (backwards-compat for any
   test using the zero-arg form) but is marked deprecated in a one-line
   JSDoc — new code uses the factory.
4. Composition-root wiring: `src/index.ts` constructs the timestamped
   logger with its existing `systemClock` (already in scope there).
5. **No change** to log CONTENT. Just a prefix. Existing log lines like
   `sync tick complete: 4 account(s), 0 ok, 12 error(s)` keep their
   exact string — only a `[2026-04-22T10:33:15.123Z] ` prefix is added.
6. **No change** to the `Logger` interface — still
   `info(message: string): void` + `error(message: string): void`.
   Adding a structured-field second argument is the *next* logger slice,
   not this one.

**Out of scope** (deliberately deferred — flag if discovered, don't
silently expand):

- Migrating `console.log` / `console.error` calls that bypass the
  `Logger` seam (there's one in [src/mcp/mcp-server.ts:170](../../src/mcp/mcp-server.ts#L170)
  — MCP tool-handler errors). Those get timestamps in a separate slice
  once we've decided whether MCP tool errors belong in the shared
  logger or in their own sink.
- CLI output (all the `opts.print ?? console.log` paths in
  [src/cli.ts](../../src/cli.ts)). CLI output is interactive
  human-facing text (`Added account: eric.wauters@...`), not a log
  stream. Timestamps on those would be noise. Skipped.
- Structured logging (`logger.info(event_name, {k: v})`). That's the
  larger follow-up the codebase anticipates; this slice is a pure
  prefix-only change so we don't conflate it.
- Color / TTY detection. Prod runs non-TTY (Docker), no reason to make
  this slice care.
- Configurability (env var to disable timestamps, pick timezone, switch
  to epoch). YAGNI — one format, always UTC ISO, always on.
- Log levels (debug/trace). Interface stays info/error.

## Files to create / touch

- **Edit** [src/logger.ts](../../src/logger.ts)
  — add `createTimestampedConsoleLogger(clock: Clock): Logger`. Leave
  `consoleLogger` exported (zero-arg fallback, uses `Date.now()`
  internally — only used in tests/one-shot CLI commands where clock
  injection is overkill). Add a JSDoc `@deprecated` note on
  `consoleLogger` pointing at the factory for production wiring.
- **Edit** [src/logger.test.ts](../../src/logger.test.ts)
  — current test exercises `consoleLogger`; add new cases for the
  factory covering the ISO prefix format and correct clock usage.
- **Edit** [src/index.ts](../../src/index.ts)
  — swap the `consoleLogger` import/use for `createTimestampedConsoleLogger(clock)`.
  The composition root already constructs a `systemClock` for the
  sync scheduler — reuse it here.
- **Edit** [docs/changelog.md](../changelog.md) — entry under
  today's date.
- **Move** this plan to `docs/plans/done/timestamped-logs.md` via
  `/docs-update` archive step.

## Seams involved

`logger` + `clock`. No graph, store, msal, fs, http changes.

## RED test list

- **AC1**: `createTimestampedConsoleLogger(clock).info("hello")`
  writes `"[<iso>] hello"` to `console.log` where `<iso>` is
  `clock.now().toISOString()`.
  - test file: [src/logger.test.ts](../../src/logger.test.ts)
  - test name: `"createTimestampedConsoleLogger prefixes info lines with clock.now().toISOString() in brackets"`
  - seams touched: logger, clock
  - edge cases: multi-line messages get the prefix exactly once, at
    the start — not on every internal newline. (Keeps grep-ability:
    `^\[2026-` is a line-start-of-log-event anchor.)

- **AC2**: `createTimestampedConsoleLogger(clock).error("boom")`
  writes to `console.error` (not `console.log`) with the same prefix.
  - test file: [src/logger.test.ts](../../src/logger.test.ts)
  - test name: `"createTimestampedConsoleLogger prefixes error lines and routes to console.error"`
  - seams touched: logger, clock
  - edge cases: none.

- **AC3**: each call re-reads `clock.now()` — a logger constructed at
  T0 and used again at T1 emits the T1 timestamp, not T0.
  - test file: [src/logger.test.ts](../../src/logger.test.ts)
  - test name: `"createTimestampedConsoleLogger reads clock.now() on every call, not at construction"`
  - seams touched: logger, clock
  - edge cases: guards against the accidental
    `const ts = clock.now()` closure at factory time.

- **AC4**: the original `consoleLogger` constant still works
  unchanged — keeps the existing `logger.test.ts` case green.
  - test file: [src/logger.test.ts](../../src/logger.test.ts)
  - test name: existing `"forwards info to console.log and error to console.error"` stays as-is.
  - seams touched: logger
  - edge cases: the existing test is the backwards-compat guard.

No index.ts test added — composition-root wiring is covered by
[src/__meta__/seam-boundaries.test.ts](../../src/__meta__/seam-boundaries.test.ts)
(if it already asserts "index.ts uses a Clock" — if not, the wiring
change is a one-line swap that the local-smoke boot probe will
exercise via real stdout).

## Open questions / assumptions

1. **Assumption**: the existing `systemClock` injected into the sync
   scheduler in `src/index.ts` is in scope at the point we construct
   the logger. If it's constructed *after* the logger today, we swap
   the order — one-line change, not a refactor.
2. **Assumption**: millisecond precision is right. Microseconds would
   be overkill; second precision would lose the "did these two log
   lines interleave?" signal we want. Happy to adjust to seconds-only
   if waldo prefers less noise (`2026-04-22T10:33:15Z`).
3. **Assumption**: UTC is right. Matches `sync_log.ts` semantics (also
   stored as epoch-ms → read as UTC). Local time in logs would diverge
   from DB timestamps and make correlation harder.
4. **Question for waldo**: should the CLI `opts.print` paths
   (`Added account: ...`, `Backfill done: ...`) also get timestamps?
   My default is NO — that output is interactive human-facing, not a
   log stream. Flag if you disagree.

## Risks

- **Risk**: a downstream consumer parses log lines by prefix and breaks
  when the `[...]` shows up at column 0. → grep shows only
  `src/logger.test.ts` and `docker compose logs` as consumers; no
  fragile downstream.
- **Risk**: the prefix adds ~30 bytes per log line. Across a year of
  30s sync ticks that's ~30 MB. Acceptable — Docker log rotation
  handles it and the diagnostic value is worth far more.
- **Risk**: tests that assert exact log content break because they no
  longer match `"sync tick complete: ..."` as a full-line string. →
  grep for `.toBe(` / `.toEqual(` on logger output — if any, change to
  `.toContain(` / suffix-match. Current
  [whatsapp-watcher.test.ts](../../src/sync/whatsapp-watcher.test.ts)
  already uses `.toContain` + `.includes`, so low impact expected.
- **Risk**: `docker compose logs --timestamps` now shows **two**
  timestamps per line (Docker's + ours). Slightly redundant but not
  wrong, and the app-side one survives through journalctl/tee/
  screenshot paths the Docker one doesn't. Acceptable.

## Out-of-scope follow-ups

- Migrate `console.error` in [src/mcp/mcp-server.ts:170](../../src/mcp/mcp-server.ts#L170)
  to use the shared `Logger` (then it gets timestamps too).
- Extend `Logger` to `logger.info(event: string, details?: object)`
  — the structured-log interface called out in
  [ai-maintainability.md §9](../tdd/ai-maintainability.md). Bigger
  slice; deliberately separate.
- Add a `--log-level` env var / `WALDO_LOG_LEVEL` and a
  `logger.debug(...)` method once there's a reason to.
- Mount the NAS container log volume to a persistent path so the
  timestamped logs survive container recreation.

## Definition of done

- All 4 ACs have a named test, all green.
- `npm test -- --coverage` passes the 90% gate.
- `/security-scan` PASS.
- `/docs-update` PASS — changelog entry, plan archived to
  `docs/plans/done/timestamped-logs.md`.
- `/local-smoke` shows timestamped output in the boot log
  (`waldo.WTF MCP server listening` is prefixed).
- Not part of the coding DoD: operator runs `/deploy-nas` and
  re-checks `docker compose logs --tail=30` — every line should now
  start with `[2026-...]`.
