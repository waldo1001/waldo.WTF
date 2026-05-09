# Calendar — Slice 4: `syncCalendarEvents` + `Calendars.Read` scope + scheduler

Parent: [calendar-overview.md](./calendar-overview.md). Predecessors:
[slice 1](./calendar-slice-1-schema-and-store.md),
[slice 2](./calendar-slice-2-client-seam.md),
[slice 3](./calendar-slice-3-http-client.md).

## Task

Land the per-account calendar sync job, wire it into the scheduler so
it runs on every tick, and add `Calendars.Read` to the MSAL delegated
scope set so the client actually receives a working token.

## Scope boundary

**IN this slice**

- New `src/sync/sync-calendar.ts`:
  - `syncCalendarEvents(input)` where `input` =
    `{ account, store, calendarClient, clock, logger, tenantId }`.
  - On first run (no `delta_link` row in `sync_state` for
    `(account, source="calendar")`), uses the rolling window
    `[clock.now() - 7d, clock.now() + 30d]` — formatted as ISO UTC.
  - Walks pages until Graph returns a `deltaLink`, calling
    `store.upsertEvents(...)` per page and
    `store.deleteEvents(...)` for `removedIds` per page.
  - Persists the final `deltaLink` to `sync_state`
    `(account, source="calendar", folder="default")`.
  - On `auth-401` from the client: calls a `forceRefresh()` callback
    once, retries once, surfaces `auth-401` to caller on second fail.
    Mirrors
    [src/sync/sync-teams.ts](../../src/sync/sync-teams.ts) /
    [src/sync/sync-viva.ts](../../src/sync/sync-viva.ts).
  - On `delta-invalid`: clears the `deltaLink`, restarts walk from
    the window. Logs an `"info"`-level "delta cursor reset" line.
  - On `rate-limit`: stops walking, returns. Scheduler will retry
    next tick.
  - On `transient-5xx`: stops walking, returns; same as rate-limit.
  - Appends a `sync_log` row per call: `source="calendar"`,
    status `"ok"` / `"error"`, optional `error_class`,
    `messages_added` (event count + attendees? — pin during FRAME;
    we'll log event count only).
- MSAL scope addition in
  [src/auth/msal-auth-client.ts](../../src/auth/msal-auth-client.ts):
  - `Calendars.Read` joins the existing delegated scope set.
  - Mixed-resource handling already in place from
    [docs/plans/done/fix-msal-mixed-resource-scopes.md](./done/fix-msal-mixed-resource-scopes.md);
    confirm during FRAME the new scope sits in the same Graph
    resource bucket and doesn't trigger a second consent prompt for
    accounts that have already consented to `Mail.Read`,
    `Chat.Read`, etc.
  - Re-consent flow — bumping the scope set forces all existing
    accounts through one device-code re-login on next sync. Document
    this in `docs/changelog.md` (slice's `/docs-update` step).
- Scheduler wiring in
  [src/sync/sync-scheduler.ts](../../src/sync/sync-scheduler.ts):
  - On each tick, after Inbox / Sent / Teams / Viva / WhatsApp,
    call `syncCalendarEvents(account)` for each account that has at
    least one `delta_link` row already (i.e., calendar sync runs for
    every account by default — there's no per-account opt-in
    structure like Viva subscriptions, because the calendar is
    per-account-singleton).
  - Each account's sync is independent: a 401 on one account doesn't
    block another.
- New `src/index.ts` wiring:
  - Construct `HttpCalendarClient` with the same `getAccessToken` as
    Teams / Viva.
  - Pass into the scheduler.

**OUT (deferred)**

- MCP tool surface. Slice 6 ships `get_upcoming_events`.
- Meeting↔chat link population. Slice 5.
- CLI flags (`--calendar-list`, `--calendar-resync`). Slice 6.
- Folding into `get_recent_activity`. Slice 7.
- Steering integration. Slice 8.
- A "horizon refresh" job that bumps the `[now-7d, now+30d]` window
  forward on a schedule — explicit follow-up.

## Files to create / touch

- [src/sync/sync-calendar.ts](../../src/sync/sync-calendar.ts) — new.
- [src/sync/sync-calendar.test.ts](../../src/sync/sync-calendar.test.ts)
  — new. Drives via `FakeCalendarClient` + `InMemoryMessageStore`.
- [src/auth/msal-auth-client.ts](../../src/auth/msal-auth-client.ts)
  — add scope.
- [src/auth/msal-auth-client.test.ts](../../src/auth/msal-auth-client.test.ts)
  — new test for the scope set including `Calendars.Read`.
- [src/sync/sync-scheduler.ts](../../src/sync/sync-scheduler.ts) —
  add per-tick call.
- [src/sync/sync-scheduler.test.ts](../../src/sync/sync-scheduler.test.ts)
  — new test that scheduler invokes calendar sync for each account.
- [src/index.ts](../../src/index.ts) — wire up.
- [src/index.test.ts](../../src/index.test.ts) — assert the
  HttpCalendarClient is constructed and passed in.

## Seams involved

- `msal` — primary (scope addition).
- `graph` — via `CalendarClient`.
- `store` — `upsertEvents` / `deleteEvents` from slice 1 and the
  `sync_state` / `sync_log` ops that already exist.
- `clock` — windowing and `sync_log` timestamps.
- `logger` — operational lines.

## RED test list

- AC1: first run with no `sync_state` row uses the
  `[now-7d, now+30d]` window
  - test file: `src/sync/sync-calendar.test.ts`
  - test name: `"first sync uses the rolling [now-7d, now+30d] window"`
  - seams touched: graph, store, clock
  - edge cases: store has zero rows, exactly one calendar event in
    window, exactly one outside (excluded by the client; we only
    assert we asked for the right window).

- AC2: subsequent run resumes from the persisted `delta_link`
  - test file: `src/sync/sync-calendar.test.ts`
  - test name: `"subsequent sync resumes from the stored delta link"`
  - seams touched: graph, store
  - edge cases: stored `delta_link` is still valid; multi-page walk
    on resume.

- AC3: pages are upserted in order, page-by-page (not buffered to
  end)
  - test file: `src/sync/sync-calendar.test.ts`
  - test name: `"events are upserted page-by-page so a mid-walk crash leaves a usable lake"`
  - seams touched: graph, store
  - edge cases: 3-page walk with crash injected after page 2;
    `delta_link` not advanced on crash.

- AC4: `removedIds` from a page become `deleteEvents` calls
  - test file: `src/sync/sync-calendar.test.ts`
  - test name: `"removedIds become deleteEvents on the store"`
  - seams touched: graph, store
  - edge cases: page contains both upserts and removals; removal of
    an event we never had (no-op via slice 1's contract).

- AC5: 401 triggers `forceRefresh()` + one retry, surfaces on second
  401
  - test file: `src/sync/sync-calendar.test.ts`
  - test name: `"401 forces token refresh and retries once"`
  - seams touched: graph, store, logger
  - edge cases: 401 then 200 (success); 401 then 401 (surface);
    `forceRefresh` rejects (surface).

- AC6: 410 (`delta-invalid`) clears the cursor and restarts
  - test file: `src/sync/sync-calendar.test.ts`
  - test name: `"delta-invalid clears the stored cursor and restarts from the window"`
  - seams touched: graph, store, logger
  - edge cases: confirm `sync_state` row is deleted (or `delta_link`
    nulled — match the existing pattern in `sync-teams.ts`); next
    call uses the window again.

- AC7: 429 stops walking, returns gracefully, leaves cursor untouched
  - test file: `src/sync/sync-calendar.test.ts`
  - test name: `"rate-limit stops the walk and surfaces a sync_log row"`
  - seams touched: graph, store, logger
  - edge cases: rate-limit hit on first page (no upserts persisted,
    no cursor advance); rate-limit hit on page 3 (pages 1–2 persisted,
    cursor advanced to page-2 nextLink so retry resumes).

- AC8: 5xx behaves like 429
  - test file: `src/sync/sync-calendar.test.ts`
  - test name: `"transient-5xx stops the walk and surfaces a sync_log row"`
  - seams touched: graph, store, logger
  - edge cases: same as AC7 but with 503.

- AC9: a `sync_log` row is written per call (ok or error)
  - test file: `src/sync/sync-calendar.test.ts`
  - test name: `"each syncCalendarEvents call appends a sync_log row"`
  - seams touched: store, clock
  - edge cases: ok; auth-401; rate-limit; delta-invalid; transient-5xx.
    `error_class` is set on errors, null on ok.

- AC10: MSAL scope set includes `Calendars.Read`
  - test file: `src/auth/msal-auth-client.test.ts`
  - test name: `"MSAL scope set includes Calendars.Read alongside existing scopes"`
  - seams touched: msal
  - edge cases: confirm against the live constant; not a magic string
    sprinkled at call sites.

- AC11: scheduler invokes calendar sync per account on every tick
  - test file: `src/sync/sync-scheduler.test.ts`
  - test name: `"scheduler runs syncCalendarEvents for each account on every tick"`
  - seams touched: clock
  - edge cases: zero accounts (skip); two accounts (both run); one
    account's sync throws (the other still runs).

- AC12: `index.ts` constructs `HttpCalendarClient` and threads it
  through to the scheduler
  - test file: `src/index.test.ts`
  - test name: `"main wires HttpCalendarClient into the scheduler"`
  - seams touched: msal, graph
  - edge cases: bootstrap-only; no live network calls in this test.

## Open questions / assumptions

1. **Assumption:** `sync_state.folder` for calendar is `"default"`.
   Calendars don't have a folder concept; pinning to a constant keeps
   the schema PK clean. FRAME confirms.
2. **Assumption:** Re-consent on scope addition is acceptable. The
   alternative (incremental consent on first calendar use) is cleaner
   UX but a meaningful seam change to MSAL wiring. We accept the
   one-time re-login and document it.
3. **Assumption:** `messages_added` in `sync_log` for a calendar tick
   logs the **event** count, not attendee rows. Steering and
   diagnose-sync-health currently treat that column as "user-visible
   item count" and an event is one item.
4. **Open:** Does `diagnose_sync_health` need a calendar-specific
   finding category? Today its categories cover auth / rate-limit /
   delta-invalid / stale / repeated-failure / viva-sub-drift /
   never-synced / unknown-error. The first five apply to calendar
   already; "stale" already triggers via the union of `sync_state`
   and `sync_log`. No code change here, but FRAME confirms a
   never-synced calendar account surfaces correctly.
5. **Open:** Window math edge case — if `clock.now()` is exactly the
   epoch boundary on a sync tick, do `now-7d` and `now+30d` round
   the same way? Pin in tests; trivial.

## Risks

- **Re-consent surprise.** Adding a scope forces every cached
  account to re-login. Mitigation: changelog entry written by
  `/docs-update` calls this out at the top, and the live smoke
  exercises it.
- **Scheduler ticks getting slower.** Calendar sync adds another
  Graph round-trip per account per tick (default 5 min). Mitigation:
  the per-tick budget is already comfortably below the tick interval
  with five sources; one more is in the noise. The watchdog
  ([docs/plans/done/event-loop-watchdog-slice.md](./done/event-loop-watchdog-slice.md))
  catches a regression.
- **Cross-account error blast radius.** A bad token on one account
  must not stop calendar sync on the others. AC11 pins this.

## Out-of-scope follow-ups

- Slice 5: meeting↔chat link.
- Slice 6: MCP tool + CLI flags.
- Horizon refresh — a job that nudges the window forward weekly so
  events 31 days out eventually appear without a `--calendar-resync`.
- Tenant-isolated calendar reads for guest accounts (probably not
  supported by Graph; flag if hit).
