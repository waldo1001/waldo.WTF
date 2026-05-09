# Calendar — Slice 6: `get_upcoming_events` MCP tool + CLI flags

Parent: [calendar-overview.md](./calendar-overview.md). Predecessor:
[slice 4](./calendar-slice-4-sync-and-scope.md). Optional predecessor:
[slice 5](./calendar-slice-5-meeting-chat-link.md) — slice 6 ships
fine without 5; the `chat_id` field just won't be reliably populated
until 5 lands.

## Task

Expose the calendar lake to the user: a dedicated MCP tool for
"what's on my plate this week" and CLI flags for operator-side
inspection and resync.

## Scope boundary

**IN this slice**

- New MCP tool, `get_upcoming_events`:
  - Input:
    ```ts
    {
      from?: string,         // ISO; default: clock.now()
      to?: string,           // ISO; default: from + 7d
      accounts?: string[]    // default: all known accounts
    }
    ```
  - Validates: `to > from`, `to - from <= 92d` (one quarter cap to
    keep responses bounded; matches the brief's "we want focused
    answers, not a dump").
  - Output: `{ events: Array<CalendarEvent & { attendees: EventAttendee[] }> }`,
    ordered by `start_at` ascending.
  - Backed by a new `MessageStore.getUpcomingEvents({from, to, accounts})`
    that wraps slice-1's `getEventsInRange` with multi-account
    union and the same ordering.
  - Steering rules **not** applied here (slice 8 wires them in).
    This tool ships with the same default behaviour as
    `get_recent_activity` had before steering — the next slice
    closes the gap.
- CLI flags in [src/cli.ts](../../src/cli.ts):
  - `--calendar-list` — prints upcoming events for the next 7 days
    across all accounts. Output format mirrors `--list-accounts`:
    one line per event, columns
    `account | start_at | duration | subject | online?`. Read-only.
  - `--calendar-resync [account]` — clears the `delta_link` for
    `(account, source="calendar")` and writes a marker so the next
    scheduler tick re-walks the window. Without `account`, clears
    every account's calendar cursor. Mirrors how
    `--viva-discover` / `--steer-*` are wired — read-mostly with a
    single bounded write.
- Tool description (the string Claude reads to know when to invoke
  it) explicitly mentions: "agenda", "calendar", "meetings",
  "upcoming", "this week", to win the routing decision against
  generic message-search tools.

**OUT (deferred)**

- Past events query — `get_upcoming_events` is forward-looking by
  name and contract. Slice 7 covers "what was on my plate
  yesterday" via the unified feed.
- Steering. Slice 8.
- Search over event subject / body. Out of scope for the base
  feature.
- `get_event_attendees(eventId)` standalone tool — not needed; the
  attendees are inlined on every event row.

## Files to create / touch

- [src/mcp/tools/get-upcoming-events.ts](../../src/mcp/tools/get-upcoming-events.ts)
  — new.
- [src/mcp/tools/get-upcoming-events.test.ts](../../src/mcp/tools/get-upcoming-events.test.ts)
  — new.
- [src/store/message-store.ts](../../src/store/message-store.ts) —
  add `getUpcomingEvents`.
- [src/store/message-store-contract.ts](../../src/store/message-store-contract.ts)
  — add tests.
- [src/store/sqlite-message-store.ts](../../src/store/sqlite-message-store.ts)
  — implement.
- (in-memory fake) — implement.
- [src/mcp/mcp-server.ts](../../src/mcp/mcp-server.ts) — register.
- [src/mcp/mcp-server.test.ts](../../src/mcp/mcp-server.test.ts) —
  registry assertion.
- [src/mcp/e2e-http.test.ts](../../src/mcp/e2e-http.test.ts) — add a
  case driving the new tool through the full HTTP stack.
- [src/cli.ts](../../src/cli.ts) — `--calendar-list`,
  `--calendar-resync`.
- [src/cli.test.ts](../../src/cli.test.ts) — new cases.

## Seams involved

- `mcp` — primary.
- `store` — new reader.
- `clock` — input defaulting.
- `fs` — none directly; CLI lives behind the existing fs seam.

## RED test list

- AC1: `getUpcomingEvents` over multiple accounts returns a single
  ordered list
  - test file: contract suite
  - test name: `"getUpcomingEvents merges accounts and orders by start_at"`
  - seams touched: store
  - edge cases: zero accounts (empty); one account (just calls
    `getEventsInRange` once); two accounts with interleaved start
    times.

- AC2: tool defaults `from` to `clock.now()` and `to` to `from + 7d`
  - test file: `src/mcp/tools/get-upcoming-events.test.ts`
  - test name: `"get_upcoming_events defaults to a 7-day window from now"`
  - seams touched: mcp, store, clock
  - edge cases: caller supplies neither; caller supplies `from` only.

- AC3: tool rejects `to <= from`
  - test file: `src/mcp/tools/get-upcoming-events.test.ts`
  - test name: `"get_upcoming_events rejects to <= from with InvalidParams"`
  - seams touched: mcp
  - edge cases: equal; reversed; one-second-too-small.

- AC4: tool rejects windows wider than 92 days
  - test file: `src/mcp/tools/get-upcoming-events.test.ts`
  - test name: `"get_upcoming_events rejects windows wider than a quarter"`
  - seams touched: mcp
  - edge cases: 92d exact (allowed); 92d + 1ms (rejected).

- AC5: tool returns events with attendees inlined
  - test file: `src/mcp/tools/get-upcoming-events.test.ts`
  - test name: `"get_upcoming_events inlines attendees per event"`
  - seams touched: mcp, store
  - edge cases: event with zero attendees → `attendees: []`.

- AC6: tool registered in `tools/list`
  - test file: `src/mcp/mcp-server.test.ts`
  - test name: `"mcp server registers get_upcoming_events"`
  - seams touched: mcp

- AC7: e2e — tool callable end-to-end via HTTP transport
  - test file: `src/mcp/e2e-http.test.ts`
  - test name: `"e2e: get_upcoming_events returns events from a real SQLite lake"`
  - seams touched: mcp, store, http

- AC8: `--calendar-list` prints upcoming events
  - test file: `src/cli.test.ts`
  - test name: `"--calendar-list prints next 7 days across accounts"`
  - seams touched: store, fs
  - edge cases: empty lake (prints "no upcoming events"); two
    accounts; events sorted by start time.

- AC9: `--calendar-resync` without an account clears every cursor
  - test file: `src/cli.test.ts`
  - test name: `"--calendar-resync clears every calendar delta cursor"`
  - seams touched: store
  - edge cases: confirms `sync_state` row count for `source="calendar"`
    drops to zero (or `delta_link` nulled, mirroring slice 4).

- AC10: `--calendar-resync <account>` clears just that account
  - test file: `src/cli.test.ts`
  - test name: `"--calendar-resync <account> clears just one cursor"`
  - seams touched: store
  - edge cases: account not present (no-op, exit 0, message);
    account present (clears row only for that account).

## Open questions / assumptions

1. **Assumption:** 92-day cap. Picked to be "one quarter, no more,
   no less" so a "what's coming up this quarter" query works but
   "the next year" doesn't. FRAME confirms or pushes back.
2. **Open:** Should `from` be inclusive and `to` exclusive (the
   norm in this codebase)? Pin in tests.
3. **Open:** CLI output format — re-using the `--list-accounts`
   table style, but events have a `subject` column that can wrap.
   Truncate at 60 chars with `…`. Confirm.
4. **Open:** Tool description text. Important for routing — Claude
   has to pick this over `search` when the user asks about agenda.
   FRAME drafts the wording; tests assert key terms appear in it
   so it doesn't drift.

## Risks

- **Routing confusion.** If Claude routes "what's on my agenda this
  week" to `search` or `get_recent_activity` instead of
  `get_upcoming_events`, the feature is invisible. Mitigation: the
  description has anchor terms; slice 7 (unified feed) further
  reduces this risk by making the wrong route still useful.
- **Stale lake = empty result.** If the scheduler hasn't run yet
  for a freshly-added account, `get_upcoming_events` returns `[]`
  silently. The diagnose-sync-health tool already covers
  "never-synced" detection, but the user's first call here might
  surprise them. Mitigation: changelog entry calls this out;
  `--calendar-list` mirrors the empty result so the surprise is
  consistent across surfaces.
- **Window width footgun.** A 7-day default is fine until someone
  asks "the next 90 days". The cap holds. The error must be
  actionable — pin the message in AC4 to mention the cap.

## Out-of-scope follow-ups

- Slice 7: unified `get_recent_activity` with `kind` discriminator.
- Slice 8: steering on events.
- A `get_past_events` companion if we find we need it. Probably
  unnecessary because slice 7's heterogeneous feed covers it.
- Free-text search over event subject / body — explicit follow-up
  after the base feature ships.
