# Slice plan — Wrap 3 HTTP clients with `fetchWithTimeout` (A3.2)

Parent plan: [server-hang-autoheal.md](server-hang-autoheal.md) §3.2.
Predecessor: [done/fetch-with-timeout-slice.md](done/fetch-with-timeout-slice.md).

## Goal

Apply `createFetchWithTimeout` at the `src/index.ts` composition root
so every production fetch from `HttpGraphClient`, `HttpTeamsClient`,
and `HttpYammerClient` carries a hard 60s default timeout. No class
changes — clients already accept a `FetchLike`.

The parent plan mentions a 4th client (`HttpTeamsChannelClient`) but
that file does not exist in the current tree (the 6718193 commit's
implementation isn't on disk). This slice only wraps the 3 real
clients.

## Files to touch

- `src/index.ts` — replace each inline
  `fetch: (input, init) => globalThis.fetch(input, init)` with
  `fetch: createFetchWithTimeout({ fetch: globalThis.fetch, defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS })`.
  Add `const DEFAULT_HTTP_TIMEOUT_MS = 60_000;` at module top.
- `src/sources/http-graph-client.test.ts` — append 1 integration test.
- `src/sources/http-teams-client.test.ts` — append 1 integration test.
- `src/sources/http-yammer-client.test.ts` — append 1 integration test.

## Seams

- **FetchLike** (existing). The hanging-fetch helper respects the
  caller's `signal`, so when the wrapper aborts, the inner promise
  rejects with the wrapper's `TimeoutError`.
- **fake timers** via `vi.useFakeTimers()` so each test runs in <50ms.

## RED test list

One test per existing client test file:

1. `HttpGraphClient: aborts via fetchWithTimeout default when inner
   fetch hangs` — wrap a `hangingFetch` (resolves never; rejects on
   `init.signal.abort`) with `createFetchWithTimeout({ defaultTimeoutMs: 100 })`,
   construct the client with the wrapped fetch, call `getDelta(...)`,
   advance fake timers by 100ms, expect rejection with `name:
   "TimeoutError"`.
2. `HttpTeamsClient: aborts via fetchWithTimeout default when inner
   fetch hangs` — same pattern, call `listChats(token)`.
3. `HttpYammerClient: aborts via fetchWithTimeout default when inner
   fetch hangs` — same pattern, call `getInbox(token)`.

Each test is the regression guard for the actual wedge mode: an
upstream fetch that never completes.

## Out of scope (this slice)

- Configurable timeout via env var. 60s is hardcoded in `index.ts` for
  now; the per-call override is via the existing `signal` arg.
- Server-side request/header timeouts (Slice A3.3).
- Lint rule banning bare `fetch` (Slice A3.4).

## Risks

- **Default too aggressive**: 60s is generous for any sane Graph/Yammer
  delta page; if an endpoint legitimately takes longer, the per-call
  `signal` arg gives an escape hatch. No env-var knob this slice.
- **Test brittleness**: each client integration test fakes timers AND
  fetches via the wrapper. Both seams are stable; no real network in
  tests.

## Definition of done

- All 3 new tests green; existing client tests stay green.
- Coverage on `index.ts` doesn't drop (the new factory call is a
  single line per client).
- `/security-scan` passes.
- `/docs-update` run.
