# Fix: event-loop watchdog detects single long blocks (not just consecutive)

## Task

Extend [`startEventLoopWatchdog`](../../src/health/event-loop-watchdog.ts) so that
**any single tick that lags by more than `singleBlockMs`** fires `onWedge()`
immediately, instead of requiring 3 consecutive over-budget ticks. Default
`singleBlockMs = 30_000` (30 s). Configurable via env var
`WALDO_WATCHDOG_SINGLE_BLOCK_MS`.

## Context

Today's autoheal log proved that the in-process defenses (event-loop
watchdog + self-probe) **do not catch the actual production wedge**.
Two autoheal restarts at 16:03 UTC and 16:43 UTC, each ~2 minutes after
a user query that hung. Both required the *external* autoheal sidecar
to fire because:

- [event-loop-watchdog.ts:42-54](../../src/health/event-loop-watchdog.ts:42)
  uses "3 consecutive over-budget ticks" logic. A single 90-second block
  produces ONE giant-lag tick (when the loop unblocks), then `consecutive`
  resets to 0 on the next normal tick. Wedge invisible.
- [self-probe.ts:56-94](../../src/health/self-probe.ts:56) is in-process.
  When the loop is blocked, its scheduled probe can't run — it's queued
  behind the block. When the loop unblocks, the queued probe fires,
  succeeds (server is responsive again), `consecutive` resets. Wedge
  invisible.

Autoheal sees the wedge live because its healthcheck runs from a
separate container — but autoheal's only response is "restart the
container". We get no log line correlating the wedge with the inbound
request that caused it, and we depend on a sidecar to recover from a
problem we *should* be able to detect ourselves.

The actual ROOT cause of the wedge (most likely a slow synchronous
better-sqlite3 query in `search` / `get_recent_activity` /
`get_thread` against the production-sized DB) is **out of scope** for
this cycle. This cycle only adds the *detection* — once shipped, the
next wedge will produce a `event_loop_watchdog_wedged` log line
preceded by the request that triggered it, giving us the data needed
to write the *fix* in a follow-up cycle.

## Goal

When the event loop is blocked for ≥ `singleBlockMs`, the watchdog
fires `onWedge()` after that one tick — not after 3 consecutive over-budget
ticks. Existing "3 small lags = wedge" behavior is preserved as a
secondary guard. Process exits with the SIGKILL fallback already wired
in [index.ts:131-135](../../src/index.ts:131), letting Docker's
`restart: unless-stopped` recover us instead of waiting for autoheal's
~90 s healthcheck cycle.

## Scope boundary

**In:**
- [src/health/event-loop-watchdog.ts](../../src/health/event-loop-watchdog.ts) — add `singleBlockMs` option; fire `onWedge()` immediately when one tick exceeds it.
- [src/health/event-loop-watchdog.test.ts](../../src/health/event-loop-watchdog.test.ts) — RED tests for single-block firing, regression for 3-consecutive firing, regression for the no-fire case.
- [src/config.ts](../../src/config.ts) — parse `WALDO_WATCHDOG_SINGLE_BLOCK_MS` (default 30000).
- [src/config.test.ts](../../src/config.test.ts) — RED tests for the new env var (default + override + invalid).
- [src/index.ts](../../src/index.ts) — pass `singleBlockMs: config.watchdogSingleBlockMs` when starting the watchdog.
- [src/index.test.ts](../../src/index.test.ts) — RED test that the value is plumbed through.
- [docs/setup.md](../../docs/setup.md) — document the new env var alongside `WALDO_WATCHDOG_DISABLED`.

**Out:**
- [self-probe.ts](../../src/health/self-probe.ts) — its in-process design is fundamentally unable to detect in-process wedges. Out-of-process detection is autoheal's job. Don't paper over the design with another threshold.
- The actual slow-query fix (deferred to follow-up cycle once the new log line tells us which tool / query is the culprit).
- Tool-entry logging (would help correlate wedges with requests but is a separate concern; deferred to its own cycle).
- `process.on('unhandledRejection')` handler (separate concern; not the cause of today's wedge per the analysis — autoheal needed to fire, meaning the process didn't exit on its own).
- Per-tool-call timeout / circuit breaker (deferred — needs the wedge cause data first).

## Files to touch

| File | Change |
| --- | --- |
| [src/health/event-loop-watchdog.ts](../../src/health/event-loop-watchdog.ts) | Add `singleBlockMs: number` to `EventLoopWatchdogOptions`. Inside the tick callback, after computing `actualMs`, branch: if `actualMs - intervalMs > singleBlockMs`, log `event_loop_watchdog_single_block` and fire `onWedge()` immediately. Existing consecutive-budget logic stays as the secondary guard. |
| [src/health/event-loop-watchdog.test.ts](../../src/health/event-loop-watchdog.test.ts) | +3 tests: single-block fires after 1 tick; 3 small lags still fire (regression); 1 small lag does not fire (regression). |
| [src/config.ts](../../src/config.ts) | Parse `WALDO_WATCHDOG_SINGLE_BLOCK_MS` → `config.watchdogSingleBlockMs: number` (default `30_000`, must be a positive integer when set). |
| [src/config.test.ts](../../src/config.test.ts) | +3 tests: default 30000, override via env, invalid value rejected. |
| [src/index.ts](../../src/index.ts) | Pass `singleBlockMs: config.watchdogSingleBlockMs` to `startEventLoopWatchdog`. Add a `WATCHDOG_EVENT_LOOP_SINGLE_BLOCK_MS_DEFAULT` const if needed for clarity. |
| [src/index.test.ts](../../src/index.test.ts) | +1 test asserting the value flows from config to the watchdog start call. |
| [docs/setup.md](../../docs/setup.md) | Document `WALDO_WATCHDOG_SINGLE_BLOCK_MS` next to `WALDO_WATCHDOG_DISABLED`. |

## Seams

Already in place:
- `setTimer: SetTimerFn` injection on `EventLoopWatchdogOptions` for deterministic timing in tests.
- `clock: Clock` injection for measured "now" reads.
- `processExit` and `scheduleKill` overrides on `MainOverrides` for boot-path testing.

No new seams needed.

## RED test list

**A. event-loop-watchdog.test.ts**

1. `it("fires onWedge after a single tick that exceeds singleBlockMs")` — manual setTimer + manual clock. Schedule the first tick for t=5000. Advance clock to t=5000+singleBlockMs+intervalMs+1 BEFORE firing the queued tick (simulating a long block during which the loop was frozen). Fire the tick. Assert `onWedge` was called exactly once.
2. `it("fires onWedge after 3 consecutive over-budget ticks (regression)")` — manual setTimer + clock. Configure intervalMs=5000, maxLagMs=1000, singleBlockMs=30000. Schedule tick, advance clock by intervalMs+1500 (= 6500ms — over `intervalMs+maxLagMs`=6000 but under singleBlockMs+intervalMs=35000), fire tick. Repeat 3×. Assert `onWedge` fired exactly once at the 3rd tick.
3. `it("does not fire onWedge for a single small over-budget tick (regression)")` — same shape: one over-budget-but-under-singleBlock tick, no fire.
4. `it("does not fire onWedge for an on-time tick (regression)")` — existing behavior, kept.

**B. config.test.ts**

5. `it("defaults watchdogSingleBlockMs to 30000ms when env unset")`.
6. `it("parses WALDO_WATCHDOG_SINGLE_BLOCK_MS as a positive integer")`.
7. `it("rejects WALDO_WATCHDOG_SINGLE_BLOCK_MS=0 / negative / non-integer")` — should throw a `ConfigError` with a meaningful message.

**C. index.test.ts**

8. `it("passes config.watchdogSingleBlockMs into startEventLoopWatchdog")` — capture the watchdog start args via `overrides.startEventLoopWatchdog`, assert the value flows through.

## Risks

- **Setting `singleBlockMs` too low could fire on legitimate slow operations** (e.g., a real 25 s sync transaction). 30 s default is conservative — well above any healthy operation in this codebase but well below autoheal's 90 s recovery cycle. If we see false positives, raise the env var.
- **Process restart loses any in-flight MCP responses.** Same as today's autoheal restart — accepted cost; a wedged response is already lost.
- **`process.exit(1)` from inside the watchdog tick happens *during* a wedge.** The SIGKILL fallback at [index.ts:131-135](../../src/index.ts:131) covers the case where `process.exit` itself stalls. Already wired and tested.

## Verification

1. `npm test` — full suite green; coverage ≥ 90 % on touched files.
2. `/security-scan` — must PASS.
3. `/docs-update` — changelog + setup.md.
4. `/local-smoke` — boot path still works with the new env var unset (default applies).
5. Commit + `/deploy-nas`.
6. **Live verification on the NAS**:
   - Tail `docker logs -f waldo-wtf` and wait for a wedge (the pattern was ~40 min today — may or may not repeat).
   - When it happens, expect `event_loop_watchdog_single_block` followed by `watchdog: server wedged, exiting` followed by Docker restart (via `restart: unless-stopped`), all within 30 s of the wedge starting — **before** autoheal's 90 s cycle.
   - The log lines IMMEDIATELY PRECEDING the wedge identify what was running. That's the data we need for the next cycle (root cause fix).
   - If 24 h pass with no wedge, that's also informative — re-evaluate whether 30 s threshold is right.
