# Slice plan — `createFetchWithTimeout` (A3.1)

Parent plan: [server-hang-autoheal.md](server-hang-autoheal.md) §3.1.

## Goal

Add a generic `createFetchWithTimeout({ fetch, defaultTimeoutMs }):
FetchLike` wrapper so any outbound HTTP can carry a hard
`AbortController` timeout. No client wiring in this slice — Slice A3.2
applies the wrapper at the `src/index.ts` composition root.

## Files to touch

- `src/sources/http-graph-client.ts` — extend `FetchLike` init with
  optional `signal?: AbortSignal`. Backwards-compatible; the underlying
  `globalThis.fetch` already accepts it.
- `src/sources/fetch-with-timeout.ts` (NEW) — the wrapper factory.
- `src/sources/fetch-with-timeout.test.ts` (NEW) — 5 RED tests below.

## Seams

- **FetchLike** (existing) for the inner fetch.
- **setTimeout / clearTimeout** directly. `vi.useFakeTimers()` stubs
  both; no extra clock seam needed for this slice.

## RED test list

Per parent plan §3.1, verbatim:

1. `aborts at default timeout when caller passes no signal` — fake
   fetch hangs forever; promise rejects with a `TimeoutError`-like at
   `defaultTimeoutMs`.
2. `caller signal aborts before default timeout` — caller's
   `AbortController` fires at 100ms with timeout=10s; fetch aborts at
   100ms with caller's reason preserved.
3. `default timeout aborts before caller signal` — caller's signal
   would fire at 10s with timeout=1s; fetch aborts at 1s with the
   timeout's reason.
4. `successful response within budget passes through unchanged` —
   body/status/headers all forwarded.
5. `cleanup: timer is cleared on successful response` — assert no
   pending timers remain in the fake-timer queue after the promise
   resolves (otherwise we leak a handle per request).

## Out of scope (this slice)

- Wrapping the 3 production HTTP clients (Slice A3.2). The factory
  ships standalone first; no `index.ts` change here.
- Server-side request/header timeouts (Slice A3.3).
- Lint rule banning bare `fetch` (Slice A3.4).

## Risks

- **Breaking the `FetchLike` shape**: adding `signal?: AbortSignal` is
  additive. All 3 existing clients (graph/teams/yammer) ignore the
  field; their tests pass their own scripted fetches that don't
  inspect it. Coverage gates on those clients stay green.
- **Default-timeout choice**: not picked in this slice (no caller).
  Slice A3.2 picks the value (~60s, generous enough for legitimate
  Graph deltas).

## Definition of done

- All 5 RED tests green.
- Coverage on `fetch-with-timeout.ts` ≥ 90% line + branch.
- `/security-scan` passes.
- `/docs-update` run.
