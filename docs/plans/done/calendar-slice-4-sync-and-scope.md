# Calendar — Slice 4: `syncCalendarEvents` + per-account opt-in + `Calendars.Read` scope + scheduler

Parent: [calendar-overview.md](../calendar-overview.md). Predecessors:
[slice 1](./calendar-slice-1-schema-and-store.md),
[slice 2](./calendar-slice-2-client-seam.md),
[slice 3](./calendar-slice-3-http-client.md).

## Task

Land the per-account calendar sync job, a **per-account opt-in store**
so only accounts the user explicitly enables get calendar sync, wire
the job into the scheduler (gated on opt-in) so it runs on every tick
for enabled accounts, and add `Calendars.Read` as a **separate**
delegated scope set (`CALENDAR_SCOPES`) requested only at
`--calendar-enable` time — never joining the base `SCOPES` used for
every account's silent token refresh.

Calendar is opt-in because Graph calendar access is per-user consent
and the user only wants 2 of several accounts synced. Keeping
`Calendars.Read` out of base `SCOPES` means enabling calendar for one
account triggers exactly one device-code re-login for that account and
zero re-prompts for every other account — no blanket re-consent.

## Scope boundary

**IN this slice**

- New `src/store/calendar-account-store.ts` — mirrors
  [src/store/viva-subscription-store.ts](../../../src/store/viva-subscription-store.ts)
  in shape (interface + `Sqlite*` impl against the `calendar_accounts`
  table from [slice 1](./calendar-slice-1-schema-and-store.md) + a
  contract suite + an in-memory fake):
  ```ts
  export interface CalendarAccountStore {
    enable(input: { account: string; tenantId?: string }): Promise<CalendarAccount>;
    disable(account: string): Promise<{ removed: boolean }>;  // deletes the row; synced events are NOT deleted
    isEnabled(account: string): Promise<boolean>;
    setTranscriptsEnabled(account: string, enabled: boolean): Promise<CalendarAccount | null>;
    listEnabled(): Promise<readonly CalendarAccount[]>;
    listAll(): Promise<readonly CalendarAccount[]>;
  }
  ```
  - `enable()` on an already-enabled account is **idempotent** — returns
    the existing row unchanged, not a `StoreError("conflict")`.
    (Contrast with `VivaSubscriptionStore.subscribe()`, which does
    reject duplicates — re-enabling calendar is an expected operator
    action, re-subscribing to the same Viva community isn't.)
  - `disable()` deletes the `calendar_accounts` row only. `events` /
    `event_attendees` rows for that account are untouched — disabling
    stops future sync, it doesn't erase history.
  - `setTranscriptsEnabled` exists here (schema column already landed
    in slice 1) but is unused until the transcripts sub-slices; wiring
    it up now avoids a second store touch later.
- New `src/auth/msal-auth-client.ts` scope constant, **separate from**
  `SCOPES`:
  ```ts
  export const CALENDAR_SCOPES = ["Calendars.Read"] as const;
  ```
  `SCOPES` (`Mail.Read`, `Chat.Read`) is **unchanged** — this is the
  opt-in mechanism. `CALENDAR_SCOPES` is requested only:
  (a) interactively, by `--calendar-enable`, via
  `loginWithDeviceCode(onPrompt, { scopes: [...SCOPES, ...CALENDAR_SCOPES] })`;
  (b) silently, by calendar sync, via
  `getTokenSilent(account, { scopes: CALENDAR_SCOPES })` — both
  parameters already exist on `AuthClient`
  ([src/auth/auth-client.ts](../../../src/auth/auth-client.ts)), no
  seam change needed.
- New CLI flags in [src/cli.ts](../../../src/cli.ts):
  - `--calendar-enable <account>`: runs `loginWithDeviceCode` with
    `[...SCOPES, ...CALENDAR_SCOPES]`, verifies the returned
    `Account.username` case-insensitively matches the requested
    account (mirror the `--add-account` post-check around
    [src/cli.ts:1472-1485](../../../src/cli.ts)), then calls
    `calendarAccounts.enable({ account, tenantId })`. If the device-code
    flow rejects with `isConsentRequiredError` (from
    [src/auth/msal-auth-client.ts:32](../../../src/auth/msal-auth-client.ts)),
    print the same remediation style as the Teams-channel path (see
    around `src/cli.ts:1001`): name the scope (`Calendars.Read`) and
    the tenant, and don't write the store row.
  - `--calendar-disable <account>`: calls `disable()`, prints whether a
    row was removed. Explicitly documents (in its own output) that
    already-synced events are kept.
- New `src/sync/sync-calendar.ts`:
  - `syncCalendarEvents(input)` where `input` =
    `{ account, store, calendarClient, clock, logger, tenantId }`.
  - On first run (no `delta_link` row in `sync_state` for
    `(account, source="calendar")`), uses the rolling window
    `[clock.now() - 365d, clock.now() + 60d]` — formatted as ISO UTC.
    See the "Window math" open question below for the 425-day range
    risk and its fallback.
  - Walks pages until Graph returns a `deltaLink`, calling
    `store.upsertEvents(...)` per page and
    `store.deleteEvents(...)` for `removedIds` per page.
  - Persists the final `deltaLink` to `sync_state`
    `(account, source="calendar", folder="default")`.
  - On `auth-401` from the client: calls a `forceRefresh()` callback
    once, retries once, surfaces `auth-401` to caller on second fail.
    Mirrors
    [src/sync/sync-teams.ts](../../../src/sync/sync-teams.ts) /
    [src/sync/sync-viva.ts](../../../src/sync/sync-viva.ts).
  - On `delta-invalid`: clears the `deltaLink`, restarts walk from
    the window. Logs an `"info"`-level "delta cursor reset" line.
  - On `rate-limit`: stops walking, returns. Scheduler will retry
    next tick.
  - On `transient-5xx`: stops walking, returns; same as rate-limit.
  - Appends a `sync_log` row per call: `source="calendar"`,
    status `"ok"` / `"error"`, optional `error_class`,
    `messages_added` (event count + attendees? — pin during FRAME;
    we'll log event count only).
- Scheduler wiring in
  [src/sync/sync-scheduler.ts](../../../src/sync/sync-scheduler.ts):
  - On each tick, after Inbox / Sent / Teams / Viva / WhatsApp, for
    each account: skip entirely unless
    `await this.deps.calendarAccounts.isEnabled(account.username)` —
    mirror the existing Teams-channel / Viva per-account skip pattern
    at [src/sync/sync-scheduler.ts:179-232](../../../src/sync/sync-scheduler.ts).
    Only then call `syncCalendarEvents(account)` with a silent token
    requested via `CALENDAR_SCOPES`.
  - A silent-token `isConsentRequiredError` (admin revoked consent
    after enable, or a tenant policy change) logs one consent-rejection
    `sync_log` row for that account per scheduler run and skips —
    mirror [src/sync/sync-scheduler.ts:207-215](../../../src/sync/sync-scheduler.ts).
  - Each account's sync is independent: a 401 on one account doesn't
    block another.
- New `src/index.ts` wiring:
  - Construct `HttpCalendarClient` with the same `getAccessToken` as
    Teams / Viva.
  - Construct `SqliteCalendarAccountStore` and pass both it and the
    client into the scheduler.

**OUT (deferred)**

- MCP tool surface. Slice 6 ships `find_events`.
- Meeting↔chat link population. Slice 5.
- CLI flags `--calendar-list`, `--calendar-resync`. Slice 6.
  (`--calendar-enable` / `--calendar-disable` are IN this slice — they
  gate whether there's anything to list/resync.)
- Folding into `get_recent_activity`. Slice 7.
- Steering integration. Slice 8.
- Transcripts scope (`OnlineMeetingTranscript.Read.All`),
  `--transcripts-enable`, `transcripts_enabled` gating in the scheduler
  — the transcripts sub-slices
  ([calendar-transcripts.md](./calendar-transcripts.md)), which build on
  the `CalendarAccountStore` and CLI pattern landed here.
- A "horizon refresh" job that bumps the `[now-365d, now+60d]` window
  forward on a schedule — explicit follow-up.

## Files to create / touch

- [src/store/calendar-account-store.ts](../../../src/store/calendar-account-store.ts)
  — new. `CalendarAccountStore` interface + `SqliteCalendarAccountStore`,
  mirrors [src/store/viva-subscription-store.ts](../../../src/store/viva-subscription-store.ts).
- [src/store/calendar-account-store-contract.ts](../../../src/store/calendar-account-store-contract.ts)
  — new. Mirrors
  [src/store/viva-subscription-store-contract.ts](../../../src/store/viva-subscription-store-contract.ts).
- [src/store/calendar-account-store.test.ts](../../../src/store/calendar-account-store.test.ts)
  — new. Sqlite impl driven through the contract suite + sqlite-specific
  edge cases (constraint behavior).
- In-memory fake (wherever
  [src/store/viva-subscription-store.ts](../../../src/store/viva-subscription-store.ts)'s
  sibling fake lives — confirm during FRAME) — new, driven through the
  same contract suite.
- [src/sync/sync-calendar.ts](../../../src/sync/sync-calendar.ts) — new.
- [src/sync/sync-calendar.test.ts](../../../src/sync/sync-calendar.test.ts)
  — new. Drives via `FakeCalendarClient` + `InMemoryMessageStore`.
- [src/auth/msal-auth-client.ts](../../../src/auth/msal-auth-client.ts)
  — add `CALENDAR_SCOPES` constant (separate from `SCOPES`).
- [src/auth/msal-auth-client.test.ts](../../../src/auth/msal-auth-client.test.ts)
  — new tests: `SCOPES` unchanged; `CALENDAR_SCOPES` equals exactly
  `["Calendars.Read"]`.
- [src/cli.ts](../../../src/cli.ts) — `--calendar-enable <account>`,
  `--calendar-disable <account>`.
- [src/cli.test.ts](../../../src/cli.test.ts) — new cases for both flags,
  including the consent-rejection remediation message and the
  username-mismatch rejection.
- [src/sync/sync-scheduler.ts](../../../src/sync/sync-scheduler.ts) —
  add per-tick call gated on `calendarAccounts.isEnabled(...)`.
- [src/sync/sync-scheduler.test.ts](../../../src/sync/sync-scheduler.test.ts)
  — new test that scheduler invokes calendar sync only for enabled
  accounts.
- [src/index.ts](../../../src/index.ts) — wire up
  `SqliteCalendarAccountStore` + `HttpCalendarClient`.
- [src/index.test.ts](../../../src/index.test.ts) — assert both are
  constructed and passed in.

## Seams involved

- `msal` — primary (new scope constant, scoped token requests).
- `graph` — via `CalendarClient`.
- `store` — `upsertEvents` / `deleteEvents` from slice 1, the new
  `CalendarAccountStore`, and the `sync_state` / `sync_log` ops that
  already exist.
- `clock` — windowing, `enabled_at`, and `sync_log` timestamps.
- `logger` — operational lines.

## RED test list

- AC1: first run with no `sync_state` row uses the
  `[now-365d, now+60d]` window
  - test file: `src/sync/sync-calendar.test.ts`
  - test name: `"first sync uses the rolling [now-365d, now+60d] window"`
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

- AC10: `SCOPES` is unchanged and `CALENDAR_SCOPES` is a separate,
  exact constant
  - test file: `src/auth/msal-auth-client.test.ts`
  - test name: `"SCOPES still equals exactly Mail.Read and Chat.Read; CALENDAR_SCOPES equals exactly Calendars.Read"`
  - seams touched: msal
  - edge cases: confirm against the live constants, not magic strings
    sprinkled at call sites; confirm `CALENDAR_SCOPES` is never spread
    into `SCOPES` anywhere in the module.

- AC11: scheduler invokes calendar sync only for accounts enabled in
  `CalendarAccountStore`
  - test file: `src/sync/sync-scheduler.test.ts`
  - test name: `"scheduler runs syncCalendarEvents only for accounts enabled in CalendarAccountStore"`
  - seams touched: store, clock
  - edge cases: zero enabled accounts (no calendar Graph calls at all,
    other sources still run); two enabled + one disabled (only the two
    run); one enabled account's sync throws (the other enabled account
    still runs, disabled account never touched).

- AC12: silent-token consent rejection during scheduled calendar sync
  logs one `sync_log` row and skips, without affecting other accounts
  - test file: `src/sync/sync-scheduler.test.ts`
  - test name: `"calendar consent rejection logs one sync_log row per account per tick and does not block other accounts"`
  - seams touched: store, msal, logger
  - edge cases: `isConsentRequiredError` on one enabled account; a
    second enabled account still syncs normally in the same tick.

- AC13: `CalendarAccountStore.enable` is idempotent; `disable` removes
  only the opt-in row, not synced events
  - test file: contract suite via `calendar-account-store.test.ts` +
    the in-memory fake's test
  - test name: `"enable is idempotent and disable keeps existing events"`
  - seams touched: store
  - edge cases: enable twice returns the same row (no conflict error);
    disable an account with existing `events` rows leaves them queryable
    via `getEventsInRange`; disable an unknown account returns
    `{ removed: false }`.

- AC14: `--calendar-enable <account>` requests `[...SCOPES,
  ...CALENDAR_SCOPES]`, rejects a username mismatch, and writes the
  store row only on success
  - test file: `src/cli.test.ts`
  - test name: `"--calendar-enable device-codes with Calendars.Read and writes the opt-in row on match"`
  - seams touched: msal, store, fs
  - edge cases: device-code returns a different username than requested
    (reject, no store write, exit non-zero); `isConsentRequiredError`
    (print remediation naming the scope and tenant, no store write);
    happy path writes exactly one `calendar_accounts` row.

- AC15: `--calendar-disable <account>` removes the opt-in row and
  reports whether one existed
  - test file: `src/cli.test.ts`
  - test name: `"--calendar-disable removes the opt-in row"`
  - seams touched: store
  - edge cases: account currently enabled (removed, message says so);
    account not enabled (no-op, exit 0, message says so).

- AC16: `index.ts` constructs `HttpCalendarClient` and
  `SqliteCalendarAccountStore`, threading both through to the scheduler
  - test file: `src/index.test.ts`
  - test name: `"main wires HttpCalendarClient and CalendarAccountStore into the scheduler"`
  - seams touched: msal, graph, store
  - edge cases: bootstrap-only; no live network calls in this test.

## Open questions / assumptions

1. **Assumption:** `sync_state.folder` for calendar is `"default"`.
   Calendars don't have a folder concept; pinning to a constant keeps
   the schema PK clean. FRAME confirms.
2. **Resolved (was: re-consent on scope addition):** `Calendars.Read`
   is a separate `CALENDAR_SCOPES` set, never joined into base
   `SCOPES`. Only accounts the operator runs `--calendar-enable`
   against ever see the consent prompt; every other account is
   unaffected — no blanket re-login.
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
   never-synced-but-enabled calendar account surfaces correctly, and
   that a disabled account is correctly excluded from "never-synced"
   noise (it was never supposed to sync).
5. **Open:** Window math edge case — if `clock.now()` is exactly the
   epoch boundary on a sync tick, do `now-365d` and `now+60d` round
   the same way? Pin in tests; trivial.
6. **Open — FRAME must confirm before coding:** does Graph's
   `/me/calendarView/delta` accept a ~425-day
   `startDateTime`/`endDateTime` range in the initial request? If
   Graph rejects or silently truncates a range this wide, fall back to:
   an initial **backfill** pass using plain (non-delta)
   `GET /me/calendarView?startDateTime=...&endDateTime=...` paged in
   90-day chunks across `[now-365d, now-7d]` (upsert-only, no delta
   token stored for these chunks), immediately followed by starting the
   **delta** walk over `[now-7d, now+60d]` as originally scoped. Record
   whichever path FRAME confirms directly in this doc's "IN this slice"
   section before RED begins, so `sync-calendar.ts`'s shape is decided
   once, not mid-implementation.

## Risks

- **Consent friction on enable.** `--calendar-enable` requires an
  interactive device-code login per account, and if the tenant blocks
  user consent for `Calendars.Read`, the operator needs a tenant admin
  to grant it first (same shape as `--teams-admin-consent`). Mitigation:
  the CLI error message names the exact scope and tenant when
  `isConsentRequiredError` fires, so the operator knows what to hand to
  their admin.
- **Scheduler ticks getting slower.** Calendar sync adds another
  Graph round-trip per *enabled* account per tick (default 5 min).
  Mitigation: bounded to at most 2 accounts by the user's own opt-in
  choice; the per-tick budget is already comfortably below the tick
  interval with five sources. The watchdog
  ([docs/plans/done/event-loop-watchdog-slice.md](./event-loop-watchdog-slice.md))
  catches a regression.
- **Cross-account error blast radius.** A bad token on one enabled
  account must not stop calendar sync on the other. AC11/AC12 pin this.
- **Large initial backfill.** A 365-day window on first enable is a
  materially bigger first sync than the originally-planned 37-day
  window. Mitigation: AC3's page-by-page persistence means a mid-walk
  crash doesn't lose progress; this is a one-time cost per newly-enabled
  account, not a recurring one.

## Out-of-scope follow-ups

- Slice 5: meeting↔chat link.
- Slice 6: MCP tool + `--calendar-list` / `--calendar-resync` CLI flags.
- Transcripts sub-slices in
  [calendar-transcripts.md](./calendar-transcripts.md) — build directly
  on `CalendarAccountStore` and the `--calendar-enable` CLI pattern
  landed here.
- Horizon refresh — a job that nudges the forward edge of the window
  ahead weekly so events beyond `+60d` eventually appear without a
  `--calendar-resync`.
- Tenant-isolated calendar reads for guest accounts (probably not
  supported by Graph; flag if hit).
