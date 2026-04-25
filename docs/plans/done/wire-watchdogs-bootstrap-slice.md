# Slice plan — Wire watchdogs into the bootstrap (A2.3)

Parent plan: [server-hang-autoheal.md](server-hang-autoheal.md) §2.3.

## Goal

Mount both watchdogs (A2.1 event-loop, A2.2 self-probe) at the
composition root in [src/index.ts](../../src/index.ts) so the in-process
defense actually runs in production. Add `WALDO_WATCHDOG_DISABLED=1`
kill switch in [src/config.ts](../../src/config.ts). Wire SIGTERM /
SIGINT to stop the watchdogs *before* `server.close()` so graceful
shutdown does not trip the self-probe. On wedge: log, schedule a
5-second `SIGKILL` fallback (`.unref()`-ed), then `process.exit(1)`.

## Files to touch

- [src/index.ts](../../src/index.ts) — start both watchdogs after
  `server.listen` resolves; stop them at the head of `shutdown()`.
  New overrides: `startEventLoopWatchdog`, `startSelfProbe`, `processExit`,
  `scheduleKill`. Default `scheduleKill` schedules
  `setTimeout(() => process.kill(process.pid, 'SIGKILL'), 5000).unref()`.
- [src/config.ts](../../src/config.ts) — new `watchdogDisabled: boolean`
  field on `Config`. Read from `WALDO_WATCHDOG_DISABLED === "1"`.
- [src/index.test.ts](../../src/index.test.ts) — new tests.
- [src/config.test.ts](../../src/config.test.ts) — new tests.

## Defaults

- Event-loop watchdog: `intervalMs=5_000`, `maxLagMs=1_000`.
- Self-probe: `intervalMs=30_000`, `timeoutMs=5_000`,
  `failuresBeforeWedge=3` (≈90s detection budget — matches Phase 1).

## Seams

- `startEventLoopWatchdog?` and `startSelfProbe?` factories override —
  tests pass spies returning a handle whose `stop()` is also a spy.
- `processExit?` override — defaults to `process.exit`. Tests assert
  called with `1` after a wedge.
- `scheduleKill?` override — defaults to a self-pid `SIGKILL`
  setTimeout. Tests assert it fires before `processExit`.
- Watchdogs are started ONLY when both `WALDO_WATCHDOG_DISABLED !== "1"`
  AND no `WALDO_WATCHDOG_DISABLED` short-circuit applies. The CLI
  paths (`--add-account`, etc.) live outside `main()`, so this slice
  does not need to special-case them — they never call `main()`.

## RED test list

### `src/config.test.ts`
1. `watchdogDisabled defaults to false` — env without
   `WALDO_WATCHDOG_DISABLED` → `false`.
2. `watchdogDisabled is true when WALDO_WATCHDOG_DISABLED=1` — `"1"`
   → `true`.
3. `WALDO_WATCHDOG_DISABLED other than "1" stays false` — `"true"`,
   `"yes"`, `"0"` all → `false`.

### `src/index.test.ts`
4. `main() starts both watchdogs by default` — pass spy factories;
   assert each called exactly once with the expected `intervalMs`
   defaults.
5. `main() does NOT start watchdogs when WALDO_WATCHDOG_DISABLED=1`
   — spy factories never called.
6. `shutdown() stops watchdogs before closing the server` — assert
   each handle's `stop()` was called before `httpServer.close`. Use
   a recorder to capture order.
7. `wedge handler invokes scheduleKill then processExit(1)` — pull
   the `onWedge` arg out of the spy's recorded call, invoke it, and
   assert the recorded order is `scheduleKill` → `processExit(1)`.
   Logger receives an `error`-level line containing `wedged`.
8. `WALDO_WATCHDOG_DISABLED=1: shutdown() does not blow up because
   handles are absent` — happy-path coverage of the no-watchdog
   branch.

## Out of scope (this slice)

- Manual smoke: dev-only `while(true){}` injector that proves the
  watchdog fires inside the container. That belongs in the Plan A2
  cross-slice gate.
- Restart telemetry beyond the existing `logger.error` line.

## Risks

- **process.exit racing finalizers**: the SIGKILL fallback handles
  this. `unref()` keeps it from blocking graceful exits.
- **Watchdog false positives**: kill switch via env var; restart loop
  is bounded by the autoheal sidecar's own backoff (Phase 1).
- **CLI surface**: `--add-account` calls `runFromCli` indirectly via
  `cli.ts`, but the `--add-account` branch returns before `main()`.
  Confirmed by reading [src/cli.ts](../../src/cli.ts).

## Definition of done

- 8 new tests green; coverage ≥90% line+branch on touched files.
- `/security-scan` clean.
- `/docs-update` run; setup.md gains a `WALDO_WATCHDOG_DISABLED` row.
- Plan archived at `docs/plans/done/wire-watchdogs-bootstrap-slice.md`.
