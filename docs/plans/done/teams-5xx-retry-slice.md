# Slice plan — HttpTeamsClient 5xx retry (single slice)

Parent plan: [teams-transient-5xx-retry.md](teams-transient-5xx-retry.md).

## Goal

Add a transient-5xx (502/503/504) retry loop with jittered backoff to
`HttpTeamsClient.#request()` so one upstream Graph blip doesn't flip a
whole sync tick into the error column for the affected account.

## Files to touch

- `src/sources/http-teams-client.ts` — extend constructor with `sleep`,
  `random`, `maxRetries` (all optional, sensible defaults). Wrap
  `#request` body in retry loop that returns/breaks on terminal
  outcomes and `await sleep(...)` between attempts. Bearer-redaction
  must run before the retry decision.
- `src/sources/http-teams-client.test.ts` — append the 10 RED tests
  enumerated in the parent plan §"RED test list".

## Seams

- **http** (existing) — `FetchLike`. Tests already use `scriptFetch`
  helper; extend it to accept N scripted responses.
- **sleep** (NEW) — `sleep: (ms: number) => Promise<void>`. Default is
  `(ms) => new Promise((r) => setTimeout(r, ms))`. Tests pass a stub
  that records the ms args without actually waiting.
- **random** (NEW) — `random: () => number` returning [0, 1). Default
  is `Math.random`. Tests pin to deterministic values.

Both new fields optional. No production wiring changes needed in
`src/index.ts` — defaults preserve current behavior for callers that
omit them.

## Retry policy (recap)

```
attempt 1: immediate
  → 2xx: return
  → 401: throw TokenExpiredError (no retry)
  → 429: throw GraphRateLimitedError (no retry)
  → 500: throw (no retry — tight whitelist)
  → 502/503/504: backoff, retry if attempts left
  → other 4xx: throw (no retry)

attempt 2: sleep(250 + random() * 250)   // 250–500ms
attempt 3: sleep(750 + random() * 750)   // 750–1500ms
total wall-clock budget: ~2s worst case
```

## RED test list

The 10 tests listed in the parent plan §"RED test list":

1. `retries on 502 and returns success on second attempt`
2. `retries on 503 then 504 then succeeds on third attempt`
3. `gives up after maxRetries=2 and surfaces the last 5xx body`
4. `does not retry on 401`
5. `does not retry on 429`
6. `does not retry on 404 or other 4xx`
7. `does not retry on 500`
8. `does not retry on 2xx`
9. `jitter uses injected random source`
10. `redacts bearer from final error body even after retries`

Each test asserts the exact number of fetch calls (so a regression
to "retry too eagerly" or "retry not at all" trips immediately) and,
where relevant, the sleep ms value.

## Out of scope (this slice)

- Apply the same retry pattern to `HttpGraphClient`,
  `HttpYammerClient`, `HttpTeamsChannelClient`. Per parent plan: only
  Teams shows production 5xx flap today; mirroring preemptively
  violates "don't design for hypothetical future requirements."
- Any change to `classify-error.ts` or `diagnose-sync-health.ts`.
- Network-layer (connection-error) retry. The reported symptom is a
  502 *response*.

## Risks

- **Hiding genuine outages**: a real Graph outage now produces a
  delayed error (≤2s). Accepted — invisible at the 15-min tick scale.
- **Test flakiness from real timers**: mitigated by the injected
  `sleep` seam. A test that imports `setTimeout` is a bug.

## Definition of done

- All 10 RED tests green.
- Coverage on `http-teams-client.ts` ≥ 90% line + branch (currently
  100% per the latest test run; must stay there).
- `/security-scan` passes (test 10 is the dedicated guard).
- `/docs-update` run; changelog entry under today's date.
