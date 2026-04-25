# Teams HTTP client — retry transient 5xx

## Task

Make `HttpTeamsClient` retry on transient upstream Graph failures
(502/503/504) with a small jittered backoff before surfacing the error.
This stops one upstream Graph blip from flipping a whole sync tick into
the error column for the affected account.

Concrete trigger: production logs at
[2026-04-25T09:19:16Z] show
`WAUTERI@ifacto.be / teams` failing with
`HTTP 502 BadGateway: "Failed to execute backend request"` from
`graph.microsoft.com`. The same account has been flapping in/out of the
"1 error(s)" column for days (see `docker logs waldo-wtf` 2026-04-24
through 2026-04-25). The error originates in `listAllChats()` which sits
*outside* the per-chat try/catch in [sync-teams.ts:172](../../src/sync/sync-teams.ts#L172),
so per-chat isolation does not cover it — and shouldn't have to. The
correct seam is the HTTP client.

## Scope boundary

**IN:**
- Add a transient-5xx retry loop inside `HttpTeamsClient.#request()`
  ([src/sources/http-teams-client.ts:59](../../src/sources/http-teams-client.ts#L59)).
- Retry only on **502, 503, 504**. 2 retries max, jittered backoff
  (~250ms / ~750ms — small enough to fit inside one scheduler tick,
  large enough to clear most Graph blips).
- Inject the delay function so tests don't actually sleep.
- Inject the random jitter source for determinism.
- Tests for: retry-then-success, give-up-after-N, no-retry on 4xx,
  no-retry on 401/429 (those keep their existing typed-error throws),
  no-retry on success.

**OUT (explicit, for separate plans):**
- Same fix in `HttpGraphClient` and `HttpYammerClient`. They have the
  same shape ([http-graph-client.ts:63](../../src/sources/http-graph-client.ts#L63),
  [http-yammer-client.ts:35](../../src/sources/http-yammer-client.ts#L35))
  but we have no production evidence of 5xx flap on those today. Open a
  follow-up plan if/when we see it. Mirroring the change preemptively
  violates "don't design for hypothetical future requirements."
- The 5 "stale" findings currently shown by `diagnose_sync_health` —
  those are a false alarm from the 09:19 container restart's in-flight
  initial tick. Verify they clear on the next successful tick; no code
  change required.
- A "suppress stale during initial tick" polish in
  `diagnose-sync-health.ts` — separate, optional, lower-priority plan.
- Any reclassification of 5xx in `classify-error.ts`. Once retries
  swallow transient blips, there is no error to reclassify.
- Network-layer retry (e.g. `fetch` itself throwing). The reported
  symptom is an HTTP 502 *response*, not a connection error. Keep scope
  tight.

## Files to create / touch

**Touch:**
- `src/sources/http-teams-client.ts` — add retry loop to `#request()`,
  add two new constructor options (`sleep`, `random`) with sensible
  defaults so existing call sites need no change.
- `src/sources/http-teams-client.test.ts` — RED tests (see below).

**Create:** none.

**Do not touch:**
- `src/sync/sync-teams.ts` — leave the per-chat isolation comment and
  `isHardStop` as-is. The retry lives one layer down.
- `src/sources/teams.ts` — no new error types. A 502 that exhausts
  retries throws the same generic `Error("teams request failed: HTTP 502: …")`
  it does today. Diagnose-sync-health's `unknown-error` bucket is fine
  for the rare case where Graph is genuinely down for >2s.

## Seams involved

| Seam | Role |
|---|---|
| **http** | existing `FetchLike` injection in `HttpTeamsClientOptions` |
| **clock / sleep** | NEW — `sleep: (ms: number) => Promise<void>` injected so tests don't actually wait |
| **random** | NEW — `random: () => number` injected for jitter determinism |
| store / msal / fs / logger | untouched |

Both new seams default to real implementations
(`(ms) => new Promise(r => setTimeout(r, ms))` and `Math.random`) so
no production wiring change is needed.

## Design

### Retry policy

```
attempt 1: immediate
  → 2xx: return
  → 401: throw TokenExpiredError (no retry, existing behavior)
  → 429: throw GraphRateLimitedError (no retry, existing behavior)
  → 502/503/504: backoff and retry (attempts left > 0)
  → other 4xx: throw (no retry, existing behavior)
  → other 5xx (500): throw (no retry — see "why not 500" below)

attempt 2: after sleep(250 + jitter * 250)   // 250–500ms
attempt 3: after sleep(750 + jitter * 750)   // 750–1500ms
  (no further retries — total wall-clock budget ≈ 2s worst case)
```

Total budget worst-case: ~2s. That is well under the scheduler's
~15-minute tick interval, so a slow retry never bleeds into the next
tick. It is also under any reasonable user-facing tool call timeout.

### Why not retry 500?

A bare 500 from Graph almost always means a real bug (malformed
request, server-side exception against valid auth) — retrying the same
malformed request gives the same answer. 502/503/504 are
gateway/availability errors where retry has a meaningfully different
chance of success. Keep the retry whitelist tight.

### Why not retry 429?

429 already has its own typed error
(`GraphRateLimitedError(retryAfterSeconds)`) which the scheduler /
viva sync paths handle with a longer-horizon backoff (see
[sync-viva.ts:284](../../src/sync/sync-viva.ts#L284)). Retrying a 429
inside a 2s budget would just waste tokens. Leave the existing
behavior alone.

### Bearer redaction

The existing line 79 (`body.split(token).join("[redacted]")`) must
still run before any retry decision so leaked tokens never reach
retry-loop bookkeeping or the eventual error message. The retry path
must not stash the unredacted body anywhere.

### Constructor signature

```ts
export interface HttpTeamsClientOptions {
  readonly fetch: FetchLike;
  readonly baseUrl?: string;
  readonly preferMaxPageSize?: number;
  readonly sleep?: (ms: number) => Promise<void>;   // NEW
  readonly random?: () => number;                    // NEW, returns [0,1)
  readonly maxRetries?: number;                      // NEW, default 2
}
```

All three new fields optional. Existing call sites compile unchanged.

## RED test list

Each test name encodes one acceptance criterion:

1. `retries on 502 and returns success on second attempt` — fake fetch
   returns 502 then 200; assert exactly 2 fetch calls, returned body
   is the 200's, sleep called once with ms ∈ [250, 500].
2. `retries on 503 then 504 then succeeds on third attempt` — covers
   the full retry budget; assert 3 fetch calls, 2 sleeps with the
   expected windows.
3. `gives up after maxRetries=2 and surfaces the last 5xx body` —
   three consecutive 502s; assert the thrown error message contains
   `HTTP 502` and the redacted body, and that the bearer token does
   not appear anywhere in the message.
4. `does not retry on 401` — fetch returns 401; assert exactly 1
   fetch call, `TokenExpiredError` thrown, sleep not called.
5. `does not retry on 429` — fetch returns 429 with `Retry-After: 30`;
   assert exactly 1 fetch call, `GraphRateLimitedError` thrown with
   `retryAfterSeconds === 30`, sleep not called.
6. `does not retry on 404 or other 4xx` — fetch returns 404; assert
   exactly 1 fetch call, generic Error thrown, sleep not called.
7. `does not retry on 500` — fetch returns 500; assert exactly 1
   fetch call. (Encodes the "tight whitelist" decision so it can't
   silently regress.)
8. `does not retry on 2xx` — fetch returns 200 first try; assert
   exactly 1 fetch call, sleep not called.
9. `jitter uses injected random source` — pin `random()` to 0 and
   assert sleep called with exactly 250ms; pin to 0.999... and assert
   ~500ms. Encodes determinism.
10. `redacts bearer from final error body even after retries` —
    server returns 502 with the bearer echoed in the body on every
    attempt; assert thrown message contains `[redacted]`, never the
    token.

## Risks

- **Hiding genuine outages.** A site-wide Graph outage now produces
  a delayed error (up to 2s late) but still produces an error. Risk
  accepted — 2s is invisible at the tick scale.
- **Retry storm under partial outage.** With 5 accounts × 2 retries =
  worst case 15 extra calls per tick if Graph is fully degraded. Per
  account that's still <1 req/sec, well under any documented Graph
  throttle. Accepted.
- **Test flakiness from real timers.** Mitigated by injecting `sleep`
  — tests must use the injected stub. A test that imports
  `setTimeout` directly is a bug.

## Out-of-scope follow-ups

- Apply the same pattern to `HttpGraphClient` and `HttpYammerClient`
  *only* if/when production logs show 5xx flap on those clients.
- "Suppress stale findings during initial post-restart tick" in
  `diagnose-sync-health.ts`. Cosmetic.
- Re-run `diagnose_sync_health` after the next successful tick to
  confirm the 5 stale entries clear (no code change, just verification).

## Definition of done

- All 10 tests above are green.
- Coverage on `http-teams-client.ts` ≥ 90% line + branch.
- `/security-scan` passes (no token leakage in retry path is the
  specific concern; test 10 covers it).
- `/docs-update` run: changelog gets an entry under
  "Teams sync stability".
- One sync tick observed in the deployed container with a synthetic
  502 (or just the next natural Graph blip) shows no `error(s)` in
  the tick log line. (Operational, not gating — the tests are gating.)

## Test plan after merge / deploy

1. `/local-smoke` to confirm nothing regressed in CLI / `tools/list`.
2. `/deploy-nas` to ship.
3. Watch `docker logs --tail 100 -f waldo-wtf` for one full tick
   cycle (~15 min). Expect `5 account(s), 17 ok, 0 error(s)` even
   when WAUTERI's tick coincides with a Graph blip.
4. Re-run `diagnose_sync_health` — `WAUTERI@ifacto.be:teams` should
   no longer appear under `unknown-error`.
