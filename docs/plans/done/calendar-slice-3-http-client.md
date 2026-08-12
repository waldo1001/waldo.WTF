# Calendar — Slice 3: `HttpCalendarClient`

Parent: [calendar-overview.md](../calendar-overview.md). Predecessors:
[slice 1](./calendar-slice-1-schema-and-store.md),
[slice 2](./calendar-slice-2-client-seam.md).

## Task

Implement the real Graph-backed `HttpCalendarClient` that satisfies the
slice-2 `CalendarClient` interface, hitting
`/me/calendarView/delta`, walking pages, surfacing `@removed`, and
mapping HTTP errors through the existing `classifyError`.

## Scope boundary

**IN this slice**

- New `src/sources/http-calendar-client.ts`:
  - Constructor takes a `fetch` (the global, injectable for tests),
    a `getAccessToken(account, scope)` callback (matches the
    signature `HttpTeamsClient` already uses), a `Logger`, and a
    `Clock`.
  - One public method, `listCalendarViewDelta`, matching the slice-2
    interface.
  - First-call URL:
    `GET /me/calendarView/delta?startDateTime=<windowStartIso>&endDateTime=<windowEndIso>`
    with `Prefer: outlook.timezone="UTC"` and
    `Prefer: outlook.body-content-type="text"` and
    `Prefer: odata.maxpagesize=50`.
  - Subsequent calls follow the opaque `cursor` (the prior page's
    `@odata.nextLink` or `@odata.deltaLink`) verbatim.
  - Honors timeouts via `fetchWithTimeout`
    ([src/sources/fetch-with-timeout.ts](../../../src/sources/fetch-with-timeout.ts)).
  - Maps responses:
    - 401 → `classifyError` `'auth-401'` (sync loop will force-refresh
      the token and retry once, mirroring how
      [src/sources/http-teams-client.ts](../../../src/sources/http-teams-client.ts)
      does it).
    - 410 → `classifyError` `'delta-invalid'` (cursor expired —
      sync loop will reset the delta token and start over from the
      window).
    - 429 → `classifyError` `'rate-limit'`, surface
      `Retry-After` to the caller.
    - 5xx → retry once with backoff (mirror
      [src/sources/http-teams-client.ts](../../../src/sources/http-teams-client.ts)'s
      retry policy), then `classifyError` `'transient-5xx'`.
  - Token redaction in error messages: never log or surface the
    bearer.
  - Lowers each Graph DTO via the shared
    `mapGraphEventToCalendarEvent` from slice 2; lowering the
    `value[]` array becomes the page's `events`.
  - `@removed` rows on the page become `removedIds: string[]`.
  - Returns whichever of `nextLink` / `deltaLink` Graph included on
    the page.
- Dedicated lint test under `src/sources/__lint__/` to assert the new
  file uses `fetchWithTimeout`, not bare `fetch` (matches the project
  policy locked in by
  [docs/plans/done/lint-bare-fetch-slice.md](./lint-bare-fetch-slice.md)).

**OUT (deferred)**

- MSAL scope expansion (`Calendars.Read`). The slice-3 tests inject a
  fake `getAccessToken` callback; slice 4 owns adding the scope to
  the real MSAL token request.
- The sync loop. This slice ships a client, nothing reads from it
  yet outside its tests.
- Live smoke against a real tenant. Slice 4 owns that.
- FTS5 / search integration. Out of scope for the entire base
  feature.

## Files to create / touch

- [src/sources/http-calendar-client.ts](../../../src/sources/http-calendar-client.ts)
  — new.
- [src/sources/http-calendar-client.test.ts](../../../src/sources/http-calendar-client.test.ts)
  — new. Drives the client with an injected `fetch` returning canned
  Graph responses (loaded from `src/testing/fixtures/`).
- `src/sources/__lint__/http-calendar-client.bare-fetch.test.ts` —
  new lint check.
- `src/testing/fixtures/calendar-view-delta-page-1.json` and friends
  — recorded shapes (sanitized: no real account emails, no real
  tenant ids, no bearer tokens).
- [src/sources/classify-error.ts](../../../src/mcp/tools/classify-error.ts)
  — confirm during FRAME that `'delta-invalid'` already exists; if
  not, add it. (Existing teams-channel sync uses it; almost certain.)

No changes to slice-1 or slice-2 files.

## Seams involved

- `graph` — primary.
- `http` — via `fetchWithTimeout`.
- `clock` — for backoff jitter and Retry-After computation.
- `logger` — error surfacing.

No `store`, `msal`, `fs` work in this slice.

## RED test list

- AC1: initial call hits `/me/calendarView/delta` with the right
  query string and `Prefer` headers
  - test file: `src/sources/http-calendar-client.test.ts`
  - test name: `"initial call requests calendarView/delta with UTC timezone and the window"`
  - seams touched: graph, http
  - edge cases: window passed in via `windowStartIso` /
    `windowEndIso`; no cursor.

- AC2: subsequent call follows the cursor verbatim
  - test file: `src/sources/http-calendar-client.test.ts`
  - test name: `"subsequent call follows the @odata.nextLink cursor"`
  - seams touched: graph, http
  - edge cases: cursor with non-trivial query params; cursor that
    points at a different host (defensive — refuse).

- AC3: page lowers `value[]` to `events` via the shared mapping
  - test file: `src/sources/http-calendar-client.test.ts`
  - test name: `"page lowers Graph events into CalendarEvent rows via shared mapping"`
  - seams touched: graph
  - edge cases: empty `value[]`; mixed online + in-person.

- AC4: page surfaces `@removed` rows as `removedIds`
  - test file: `src/sources/http-calendar-client.test.ts`
  - test name: `"@removed entries become removedIds"`
  - seams touched: graph
  - edge cases: removed-and-added in the same delta (sync loop
    resolves; client just surfaces the order).

- AC5: page returns either `nextLink` or `deltaLink` (never both —
  Graph's behaviour)
  - test file: `src/sources/http-calendar-client.test.ts`
  - test name: `"page exposes nextLink mid-walk and deltaLink on the final page"`
  - seams touched: graph
  - edge cases: single-page walk (only `deltaLink`).

- AC6: 401 maps to `classifyError` `'auth-401'`
  - test file: `src/sources/http-calendar-client.test.ts`
  - test name: `"401 surfaces as auth-401"`
  - seams touched: http, logger
  - edge cases: 401 with empty body; 401 with `WWW-Authenticate`
    header.

- AC7: 410 maps to `'delta-invalid'`
  - test file: `src/sources/http-calendar-client.test.ts`
  - test name: `"410 on a delta cursor surfaces as delta-invalid"`
  - seams touched: http, logger
  - edge cases: 410 with Graph's "resyncRequired" body shape.

- AC8: 429 maps to `'rate-limit'` and exposes `Retry-After`
  - test file: `src/sources/http-calendar-client.test.ts`
  - test name: `"429 surfaces as rate-limit with Retry-After"`
  - seams touched: http, clock, logger
  - edge cases: numeric `Retry-After`; date-form `Retry-After`;
    missing header (default backoff).

- AC9: 5xx retries once, then surfaces `'transient-5xx'`
  - test file: `src/sources/http-calendar-client.test.ts`
  - test name: `"5xx retries once before surfacing transient-5xx"`
  - seams touched: http, clock, logger
  - edge cases: 503-then-200 (success on retry); 503-then-503
    (failure surfaced); 502 / 504 same path.

- AC10: bearer token never appears in surfaced error messages
  - test file: `src/sources/http-calendar-client.test.ts`
  - test name: `"bearer token is redacted from error messages"`
  - seams touched: graph, logger
  - edge cases: 401 path (token came in on the request); 5xx path;
    network error (no response at all).

- AC11: lint test rejects bare `fetch` in
  `http-calendar-client.ts`
  - test file: `src/sources/__lint__/http-calendar-client.bare-fetch.test.ts`
  - test name: `"http-calendar-client.ts uses fetchWithTimeout, not bare fetch"`
  - seams touched: none (static check)
  - edge cases: matches existing lint pattern in the file naming.

## Open questions / assumptions

1. **Assumption:** `getAccessToken(account, scope)` is the same
   contract `HttpTeamsClient` already uses. The scope passed in this
   slice's tests is `"https://graph.microsoft.com/Calendars.Read"`;
   slice 4 wires the real MSAL value behind that name. Confirm
   shape during FRAME.
2. **Assumption:** `Prefer: outlook.timezone="UTC"` flips Graph to
   UTC ISO timestamps. This is documented and we verified it in the
   spike. FRAME re-checks the doc URL.
3. **Open:** `outlook.body-content-type="text"` request header — do we
   want plain-text bodies (consistent with messages from
   `feat-message-bodies-slice-b-include-body`) or HTML? Plain text is
   cheaper and richer-text formatting in invites is rarely useful.
   Default to text; pin in tests.
4. **Open:** Cursor host validation. Graph's nextLinks are
   `graph.microsoft.com` URLs, but a malicious / corrupted cursor
   could point elsewhere. Decide during FRAME whether to assert host
   == `graph.microsoft.com` and treat anything else as a hard error.

## Risks

- **Recorded fixtures going stale.** Graph response shapes evolve.
  Mitigation: fixtures live next to the test, the test fails loudly
  on shape drift (not a silent passthrough), and slice 4's smoke
  catches anything the fixtures don't cover.
- **Retry-After parse bugs.** `Retry-After` can be either a positive
  integer (seconds) or an HTTP-date. Bug in the date branch could
  lead to no backoff at all. Mitigation: AC8 covers both shapes.
- **Bearer leak.** Logging an `Authorization` header into an error
  message is the highest-cost regression. Mitigation: AC10 fails
  loudly, and the existing `redactBearer` utility (used by
  `HttpTeamsClient` and `HttpYammerClient`) is the only path to
  surface error text.

## Out-of-scope follow-uts

- Slice 4: scope addition + sync loop.
- Live smoke is part of slice 4's exit criteria, not this one.
- A shared "Graph delta walker" helper across sources could absorb
  this client + the Teams ones — explicitly out of scope for this
  feature; if we do it later, the seam shapes are already aligned.
