# Plan — Fix `src/index.ts` entrypoint + scheduler start

## Task
Make `npx tsx src/index.ts` actually run waldo.WTF: start the sync
scheduler, bind the MCP HTTP server, log startup + per-tick progress,
and shut down cleanly on `SIGINT` / `SIGTERM`.

## Scope boundary

**IN**
- `main()` calls `scheduler.start()` before returning so the first tick
  runs and the interval is armed.
- A new `runFromCli()` function that calls `main()`, logs a startup
  line, subscribes to `SIGINT` + `SIGTERM` → `shutdown()`, and logs
  each sync tick result.
- A direct-execution guard at the bottom of `src/index.ts` that calls
  `runFromCli()` when the file is executed directly (`tsx src/index.ts`
  or `node dist/index.js`), but stays silent when imported.
- Extending `MainOptions` with optional DI overrides
  (`auth`, `graph`, `teams`, `store`, `setTimer`, `logger`) so tests
  can drive `main()` without touching MSAL / Graph / SQLite / real
  timers.
- A tiny `Logger` seam (`{ info(msg), error(msg) }`) injected into
  `runFromCli()` and the scheduler-tick hook. Default impl wraps
  `console.log` / `console.error`.
- Per-tick log line: the scheduler already records `sync_log` rows;
  we hook into the scheduler's tick completion via a new optional
  `onTickComplete` callback the scheduler accepts, or — simpler — we
  wrap `runOnce()` externally. **Decision:** add an optional
  `onTickComplete(result)` to `SyncSchedulerDeps`. It is called once
  per `runOnce()` with a summary `{ startedAt, finishedAt, accounts, errors }`.

**OUT**
- Structured JSON logging, log levels, log rotation. Plain strings.
- Metrics/telemetry beyond the log line.
- A separate `bin/` entrypoint or CLI help text — `cli.ts` already
  owns `--add-account`. `index.ts` stays "run the server".
- Rewiring `cli.ts` to share composition with `index.ts`. Out of scope.
- Graceful drain of in-flight sync ticks on shutdown beyond
  `scheduler.stop()` (which already clears the timer).

## Files to create / touch

- `src/index.ts` — add `runFromCli`, extend `MainOptions`,
  call `scheduler.start()`, add direct-run guard.
- `src/index.test.ts` — new tests for the behaviors below.
- `src/sync/sync-scheduler.ts` — add optional `onTickComplete`
  to deps; call it in `finally` of `runOnce()`.
- `src/sync/sync-scheduler.test.ts` — one new test for
  `onTickComplete` contract.
- `src/logger.ts` (new) — `Logger` interface + `consoleLogger` default.
- `src/logger.test.ts` (new) — one test for `consoleLogger` pass-through.

## Seams involved
- **scheduler** (new `onTickComplete` dep)
- **logger** (new seam)
- **signal handlers** (injected via `runFromCli` options for test)
- **fs, clock, store, graph, teams, auth** — reused, now injectable
  through `MainOptions` overrides

## RED test list

- **AC1**: `main()` starts the scheduler.
  - test file: `src/index.test.ts`
  - test name: `"main() calls scheduler.start so the first tick runs before returning"`
  - seams: scheduler (real), auth/graph/teams/store (fakes), setTimer (fake)
  - edges: no accounts → still completes; `setTimer` must be called
    exactly once (interval armed).

- **AC2**: `main()` shutdown is idempotent and stops the scheduler +
  closes the HTTP server + closes the DB.
  - test file: `src/index.test.ts`
  - test name: `"shutdown() stops the scheduler, closes the server, and is safe to call twice"`
  - seams: as AC1
  - edges: double-call must not throw.

- **AC3**: `runFromCli()` logs a startup line and one line per tick via
  the injected logger.
  - test file: `src/index.test.ts`
  - test name: `"runFromCli logs startup and one line per completed sync tick"`
  - seams: logger (capture), scheduler, fakes
  - edges: zero-account tick still logs.

- **AC4**: `runFromCli()` wires `SIGINT` and `SIGTERM` to `shutdown()`.
  - test file: `src/index.test.ts`
  - test name: `"runFromCli invokes shutdown on SIGINT and SIGTERM"`
  - seams: injected `signals` object (`{ on(signal, handler) }`) so
    we never touch real `process`.
  - edges: only first signal triggers shutdown; second is a no-op.

- **AC5**: `SyncScheduler.runOnce()` calls `onTickComplete` once per
  tick, after the `sync_log` rows have been written, with a summary
  of accounts attempted and errors captured.
  - test file: `src/sync/sync-scheduler.test.ts`
  - test name: `"runOnce invokes onTickComplete with the tick summary after sync_log writes"`
  - seams: fake auth/graph/teams/store/clock
  - edges: mix of ok + error; ensure callback still fires on error.

- **AC6**: `consoleLogger.info` writes to `console.log` and
  `consoleLogger.error` writes to `console.error` (pass-through).
  - test file: `src/logger.test.ts`
  - test name: `"consoleLogger forwards info to console.log and error to console.error"`
  - seams: spy on console
  - edges: none.

## Open questions / assumptions

1. **Direct-run guard** — assumption: `import.meta.url === \`file://${process.argv[1]}\``
   is adequate on Node 22 + tsx. The guard is a two-line untested
   shim (`/* c8 ignore next 2 */`) because it can only be exercised
   by actually running the file as a script. All real behavior lives
   in `runFromCli()` which **is** tested.
2. **`onTickComplete` placement** — assumption: the scheduler is the
   right place to surface tick-level progress, not `index.ts` wrapping
   `runOnce`. Rationale: keeps the logging observable to any future
   composition root (CLI, integration test, future metrics exporter).
   Confirm?
3. **Shutdown idempotence** — assumption: double-shutdown should be a
   silent no-op. Alternative is "throw on second call" which feels
   strict for a signal handler that might race itself.
4. **Test drives real `createMcpHttpServer`** — assumption: fine
   because it binds to `127.0.0.1` on an ephemeral port when we pass
   `port: 0`. We'll add `port: 0` support via `MainOptions.portOverride`
   if `loadConfig` doesn't already allow port 0. Quick check:
   `loadConfig` reads `WALDO_PORT` as number with default 8765 — a
   test env with `WALDO_PORT=0` will work, so no override needed.

## Risks

- **Scheduler's first tick is async and might write to real Graph** if
  fakes aren't wired through `MainOptions`. Mitigation: required DI in
  tests, never defaulted to real in test calls.
- **Signal-handler tests leaking into other tests** if we touch real
  `process`. Mitigation: injected `signals` seam; production default
  uses `process.on` but tests never use the default.
- **`onTickComplete` change risks breaking existing scheduler tests.**
  Making it optional with a `?.()` call keeps existing tests green.
- **Direct-run guard false-positive under test runners** that execute
  modules via dynamic import. Mitigation: tests import `main` /
  `runFromCli` directly and never exercise the guard.

## Out-of-scope follow-ups

- Structured logging / log levels / JSON logs.
- Metrics endpoint on the MCP server (`/metrics`).
- Sharing composition root between `cli.ts` and `index.ts`.
- Graceful in-flight tick drain on shutdown.
- Process-level unhandled rejection / exception handlers.
