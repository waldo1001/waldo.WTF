# Slice plan — Self-loopback healthcheck (A2.2)

Parent plan: [server-hang-autoheal.md](server-hang-autoheal.md) §2.2.

## Goal

A standalone watchdog that issues an `AbortController`-protected HTTP
GET to `http://127.0.0.1:${port}/health` every `intervalMs`. After
`failuresBeforeWedge` consecutive failures (timeout, non-200, network
error), call `onWedge()`. Complements A2.1 — A2.1 catches a stuck
loop, A2.2 catches an HTTP layer that's running but not answering.

## Files to add

- `src/health/self-probe.ts` — exports
  `startSelfProbe(opts: {
    clock: Clock;
    logger: Logger;
    intervalMs: number;
    timeoutMs: number;
    port: number;
    failuresBeforeWedge: number;
    fetchImpl?: FetchLike;
    onWedge: () => void;
    setTimer?: SetTimerFn;
  }): { stop: () => void }`.
- `src/health/self-probe.test.ts` — 5 RED tests.

## Seams

- `FetchLike` (existing) — same shape as the source clients use; tests
  inject a fake. Default = `globalThis.fetch` wrapped via
  `createFetchWithTimeout`.
  - **Note**: the lint rule from A3.4 only bans bare `fetch` in
    `src/sources/**` and `src/sync/**`. `src/health/**` is outside
    that scope; bare `fetch` here is OK because:
    1. The probe always uses an `AbortController` with `timeoutMs`;
    2. The whole point is to stay independent of the source clients'
       wiring (so a wedge there can't compromise the watchdog).
- `Clock`, `Logger`, `SetTimerFn` — same pattern as A2.1.

## RED test list

1. `success path resets failure counter` — fail / fail / 200 / fail /
   fail; `onWedge` not called (counter resets at the success).
2. `consecutive failures trip wedge exactly once` —
   `failuresBeforeWedge=3`; emit 4 failing responses; `onWedge` fires
   on the 3rd, not again on the 4th.
3. `slow response counted as failure` — fake fetch returns a promise
   that never resolves; `AbortController` fires at `timeoutMs`;
   counted as a failure; after 3 such → `onWedge`.
4. `non-200 counted as failure` — fake fetch returns 503; after 3 →
   `onWedge`.
5. `stop() cancels the next probe` — timer cleared; no further fetch
   issued even if the manual timer would fire.

## Out of scope (this slice)

- Bootstrap wiring — Slice A2.3.
- Re-arm logic after wedge — same as A2.1, single-shot.

## Risks

- **Probe target is the same process**: by design — we want to detect
  *this* process's HTTP layer. If the listener has died but the loop
  is fine, fetch fails fast (ECONNREFUSED) → counted; 3 consecutive
  → `onWedge`.
- **Bare `fetch` in `src/health/**`**: justified per "Seams" note
  above; the directory is outside the lint rule's scope.

## Definition of done

- 5 new tests green; coverage ≥90% on `self-probe.ts`.
- `/security-scan` clean.
- `/docs-update` run.
