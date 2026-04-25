# Slice plan — Event-loop watchdog (A2.1)

Parent plan: [server-hang-autoheal.md](server-hang-autoheal.md) §2.1.

## Goal

A standalone watchdog that detects a wedged Node event loop by
measuring `setTimeout` lag against the injected `Clock`. After 3
consecutive over-budget intervals it calls `onWedge()`. Plan A3
is the real fix; this is defense-in-depth.

## Files to add

- `src/health/event-loop-watchdog.ts` — exports
  `startEventLoopWatchdog(opts: {
    clock: Clock;
    logger: Logger;
    intervalMs: number;
    maxLagMs: number;
    onWedge: () => void;
    setTimer?: (fn, ms) => TimerHandle;  // test seam
  }): { stop: () => void }`.
  Implementation:
  - schedule `setTimeout(intervalMs)`; record `clock.now()` at schedule
    time
  - on fire: actual = `clock.now() - scheduled`; if `actual > intervalMs
    + maxLagMs`, increment `consecutiveOverBudget`; else reset to 0
  - if `consecutiveOverBudget >= 3`, call `onWedge()` once and stop
  - `stop()` clears the pending timer and prevents further firings
- `src/health/event-loop-watchdog.test.ts` — 4 RED tests.

## Seams

- `Clock` (existing) — `clock.now()` for lag measurement.
- `setTimer` injection (mirroring SyncScheduler) — lets tests drive
  ticks deterministically without relying on Vitest fake timers
  globally. Default = `nodeSetTimer` using `setTimeout`.
- `Logger` (existing) — emit a single `event_loop_watchdog_wedged`
  line before invoking `onWedge`.

## RED test list

1. `wedge fires after 3 consecutive over-budget intervals` — fake
   clock advances by `intervalMs + 2*maxLagMs` between schedule and
   fire on every tick; `onWedge` called exactly once after the 3rd
   tick.
2. `single slow interval does not trigger wedge` — one over-budget
   tick, then two on-time ticks; counter resets to 0; `onWedge`
   never called.
3. `stop() prevents further firings` — schedule, advance 1 tick (not
   wedged), call `stop()`, drive 5 more ticks via the fake timer; no
   `onWedge` even though every tick is over-budget.
4. `uses injected clock, not Date.now` — `Date.now` would say "no
   lag", but `clock.now()` shows lag every tick; assert `onWedge` is
   called purely from `clock` math.

## Out of scope (this slice)

- Bootstrap wiring — Slice A2.3.
- Multiple `onWedge` invocations or re-arming — once wedged, the
  watchdog is done; the bootstrap caller decides what to do (almost
  always: log + `process.exit(1)`).
- Calibrating the default thresholds — Slice A2.3 sets
  `intervalMs=5000, maxLagMs=1000` per parent plan §2.1.

## Risks

- **False positives on heavy SQLite WAL checkpoints**: a sustained
  >15s on-loop block is itself a bug. If we observe false fires
  in production, raise `maxLagMs`; do not soften the
  3-consecutive rule (a true wedge will satisfy any lag threshold).
- **Coverage of timer paths**: `setTimer` injection makes every
  branch deterministic.

## Definition of done

- 4 new tests green; coverage ≥90% line+branch on
  `event-loop-watchdog.ts`.
- `/security-scan` clean.
- `/docs-update` run.
