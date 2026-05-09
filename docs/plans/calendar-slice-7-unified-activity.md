# Calendar — Slice 7: unified `get_recent_activity` (heterogeneous feed)

Parent: [calendar-overview.md](./calendar-overview.md). Predecessors:
[slice 4](./calendar-slice-4-sync-and-scope.md),
[slice 6](./calendar-slice-6-mcp-and-cli.md).

## Task

Fold events into the existing `get_recent_activity` MCP tool so a
single call returns a chronological feed mixing past messages with
upcoming meetings — the "what's on my plate" query the design
conversation locked in.

## Scope boundary

**IN this slice**

- Extend `get_recent_activity` schema:
  - **New optional input:** `kinds?: ("message" | "event")[]`,
    default `["message", "event"]`. Existing callers passing only
    legacy params keep working — they get the unified feed.
  - **New optional input:** `to?: string` (ISO). Default
    `clock.now() + 7d` when `kinds` includes `"event"`, else
    `clock.now()` (the existing behaviour). Required to express
    "give me a window that covers upcoming meetings".
  - Existing `hours` input keeps its meaning: it sets `from =
    clock.now() - hours`. With events in the picture, a typical
    call is `{ hours: 24 }` (defaults `to` to `now+7d`,
    so the feed covers "yesterday's mail and the next week's
    meetings").
- Output shape changes from a flat `messages: Message[]` to a
  discriminated union:
  ```ts
  {
    items: Array<
      | { kind: "message"; at: string; message: Message }
      | { kind: "event"; at: string; event: CalendarEvent;
          attendees: EventAttendee[] }
    >
  }
  ```
  Where `at` is the unified sort key:
  - For messages: `created_at`.
  - For events: `start_at`.
  Items ordered by `at` ascending (an upcoming meeting at 10am
  comes after a 9am message but before an 11am one — chronology
  beats kind).
- Backwards-compatibility shim: when the request **only** asks for
  `kinds: ["message"]`, the response is identical in shape to the
  pre-slice-7 output. This keeps the existing
  `weekend-3-slice-1-get-recent-activity` callers working untouched.
  Achieved by branching on `kinds` in the handler, not by versioning
  the tool.
- Backed by a new `MessageStore.getRecentItems({from, to, kinds, accounts})`
  that runs the union in SQL. The cleanest implementation uses
  `UNION ALL` of two SELECTs over `messages` and `events`,
  projecting a common shape, then `ORDER BY at`. Pagination cap:
  500 items total. (Today's `getRecentMessages` has no cap; we add
  one here because mixing in events would otherwise blow up
  half-day windows on busy accounts.)

**OUT (deferred)**

- `kind: "viva-post"` etc. as separate kinds — Viva and WhatsApp
  posts already round-trip as `Message`. Promoting them to their
  own kinds is speculative; defer.
- Cursor-based pagination beyond the 500 cap. Defer until a real
  query asks for it.
- Steering — slice 8.
- Search integration. Out of scope for the base feature.

## Files to create / touch

- [src/mcp/tools/get-recent-activity.ts](../../src/mcp/tools/get-recent-activity.ts)
  — extend.
- [src/mcp/tools/get-recent-activity.test.ts](../../src/mcp/tools/get-recent-activity.test.ts)
  — extend.
- [src/store/message-store.ts](../../src/store/message-store.ts) —
  add `getRecentItems`.
- [src/store/message-store-contract.ts](../../src/store/message-store-contract.ts)
  — tests.
- [src/store/sqlite-message-store.ts](../../src/store/sqlite-message-store.ts)
  — implement (UNION ALL).
- (in-memory fake) — implement.
- [src/mcp/mcp-server.ts](../../src/mcp/mcp-server.ts) — input schema
  update if surfaced.
- [src/mcp/e2e-http.test.ts](../../src/mcp/e2e-http.test.ts) — e2e.

## Seams involved

- `mcp` — primary.
- `store` — new union reader.
- `clock` — defaulting.

## RED test list

- AC1: existing call shape (no `kinds`, just `hours`) returns the
  unified feed
  - test file: `src/mcp/tools/get-recent-activity.test.ts`
  - test name: `"get_recent_activity defaults kinds to [message,event] and returns mixed items"`
  - seams touched: mcp, store, clock
  - edge cases: lake has only messages (event side empty); only
    events; both.

- AC2: explicit `kinds: ["message"]` preserves the legacy response
  shape
  - test file: `src/mcp/tools/get-recent-activity.test.ts`
  - test name: `"get_recent_activity with kinds=[message] keeps the legacy messages-only output"`
  - seams touched: mcp, store
  - edge cases: legacy callers don't break; `items` not present in
    this branch — only `messages` is.

- AC3: explicit `kinds: ["event"]` returns events only, in the new
  shape
  - test file: `src/mcp/tools/get-recent-activity.test.ts`
  - test name: `"get_recent_activity with kinds=[event] returns event items only"`
  - seams touched: mcp, store
  - edge cases: zero events.

- AC4: items are ordered by `at` ascending across kinds
  - test file: `src/mcp/tools/get-recent-activity.test.ts`
  - test name: `"items are ordered by at ascending across both kinds"`
  - seams touched: mcp, store
  - edge cases: message and event with the same `at` (stable
    ordering: message before event — matches the SQL order in
    `UNION ALL` with kind-as-tiebreaker).

- AC5: when `kinds` includes `"event"`, default `to` is
  `clock.now() + 7d`
  - test file: `src/mcp/tools/get-recent-activity.test.ts`
  - test name: `"default to is now+7d when events are requested"`
  - seams touched: mcp, clock
  - edge cases: caller supplies `hours: 24`; default `to` covers
    upcoming meetings.

- AC6: 500-item cap
  - test file: `src/mcp/tools/get-recent-activity.test.ts`
  - test name: `"items are capped at 500 with the oldest dropped"`
  - seams touched: mcp, store
  - edge cases: 1000 items in window → 500 returned; the 500 are
    the most recent by `at`.

- AC7: store-level `getRecentItems` runs the union in one query
  - test file: contract suite
  - test name: `"getRecentItems unions messages and events ordered by at with a 500 cap"`
  - seams touched: store
  - edge cases: empty messages, empty events, mixed.

- AC8: e2e — `get_recent_activity` with default args returns mixed
  items via HTTP
  - test file: `src/mcp/e2e-http.test.ts`
  - test name: `"e2e: get_recent_activity returns mixed message+event items"`
  - seams touched: mcp, store, http
  - edge cases: real SQLite, both tables populated.

## Open questions / assumptions

1. **Open:** The tie-break rule when a message and an event share
   `at` to the millisecond. Defaulting to "message first" because
   that's the historical order; FRAME confirms.
2. **Open:** Whether the legacy-shape branch (`kinds=[message]` →
   `messages` not `items`) is worth the complexity vs. forcing all
   callers to migrate. Today's only callers are Claude Desktop and
   the e2e test, both of which we control. **Tentative decision:**
   keep the branch in slice 7, mark it deprecated in
   [docs/changelog.md](../../docs/changelog.md), and remove it as a
   follow-up after one weekend of real use.
3. **Open:** 500-item cap — picked to bound response size on a busy
   day. Pin during FRAME; tests assert the value.
4. **Open:** Should attendees be inlined on every event item in the
   feed, or only fetched on-demand by `get_event`? Inlined is
   ergonomically nicer for a single-call feed but enlarges the
   response. Default to inlined; revisit if responses get too big.

## Risks

- **Response size.** A heterogeneous feed of messages + events +
  attendees can balloon. The 500 cap and the 7-day default to-window
  are the brakes. Mitigation: `local-smoke` exercises the response
  size; if it crosses 1MB on a real account, the cap drops.
- **Routing regression.** Claude has been routing "summarize my
  recent activity" to `get_recent_activity` reliably. Changing the
  output shape risks the LLM mis-handling the new fields.
  Mitigation: AC2's legacy-shape branch covers the most common
  caller; the tool description gets a hard rewrite this slice to
  signal the new mixed shape.
- **Sort key surprises.** "What just happened" suddenly includes
  things that **haven't happened yet** (upcoming meetings). The
  feed is correct but the framing isn't obvious. Mitigation: tool
  description names the new behaviour ("recent activity and
  upcoming meetings within the window").

## Out-of-scope follow-ups

- Slice 8: steering on events.
- Cursor pagination on the feed.
- Removing the legacy `messages` branch after one weekend of real
  use.
- A second tool for "**only** what happened" (no future) — defer
  unless the unified feed proves too noisy.
