# Calendar — Slice 2: `CalendarClient` seam + `FakeCalendarClient`

Parent: [calendar-overview.md](./calendar-overview.md). Predecessor:
[slice 1](./calendar-slice-1-schema-and-store.md).

## Task

Define the `CalendarClient` seam (a pure interface) and a
`FakeCalendarClient` driven by injected fixtures, so slice-3+ can
implement and slice-4 can use it without ever talking to real Graph in
tests.

## Scope boundary

**IN this slice**

- New `src/sources/calendar.ts` exporting:
  - `CalendarClient` interface — one method, `listCalendarViewDelta`,
    returning a single page (events + removed ids + optional
    next/delta links). Mirrors the `TeamsClient` /
    `TeamsChannelClient` shape so the sync loop in slice 4 can be
    written generically.
  - `CalendarViewDeltaPage` type.
  - `CalendarViewDeltaInput` type — `account`, optional
    `cursor: string` (either an `@odata.nextLink` for in-progress paging,
    or an `@odata.deltaLink` for a resumed sync), optional
    `windowStartIso` / `windowEndIso` for the **first** call when no
    cursor exists.
  - The Graph-shaped DTOs we need: `GraphCalendarEvent`,
    `GraphAttendee`, `GraphOnlineMeetingInfo` — the **wire** types
    distinct from the lake-storage types in
    [src/store/types.ts](../../src/store/types.ts) (those came in
    slice 1).
  - `mapGraphEventToCalendarEvent(graphEvent, account, tenantId)`: pure
    function that lowers a Graph DTO to the slice-1 `CalendarEvent`
    shape. Lives in this file so the fake and the real client both
    use the same lowering.
- New `src/testing/fake-calendar-client.ts`:
  - Constructor accepts `pages: CalendarViewDeltaPage[]` keyed by
    `cursor ?? "__initial__"`, plus an account allow-list.
  - Returns pages in the order driven by the cursor in the request.
  - Throws a typed error when given an unknown cursor (the sync loop
    will rely on this to surface bugs early).
- Wire mapping tests covering:
  - Typical event → `CalendarEvent` round-trip.
  - Event with `onlineMeeting != null` → `chat_id`,
    `online_meeting_url`, `online_meeting_id` populated.
  - Event with `onlineMeeting === null` → those three fields null.
  - Cancelled event (`isCancelled: true`) → `is_cancelled: 1`.
  - All-day event → `is_all_day: 1`, `start_at` / `end_at` lowered
    per the rule fixed in the overview (`start_at` = ISO of the
    user-tz start in UTC).
  - Attendee response status mapping (`accepted` / `tentative` /
    `declined` / `notResponded` / `none`); organizer recorded as a
    distinct attendee with `responseStatus = "organizer"`.

**OUT (deferred)**

- HTTP I/O of any kind. No `fetch`, no MSAL, no real Graph endpoint.
  That's slice 3.
- Sync loop, scheduler, `sync_log`. That's slice 4.
- MSAL scope expansion. That's slice 4.
- Any persistence. The fake holds pages in memory only.

## Files to create / touch

- [src/sources/calendar.ts](../../src/sources/calendar.ts) — new.
- [src/sources/calendar.test.ts](../../src/sources/calendar.test.ts) —
  new. Covers `mapGraphEventToCalendarEvent`.
- [src/testing/fake-calendar-client.ts](../../src/testing/fake-calendar-client.ts)
  — new.
- [src/testing/fake-calendar-client.test.ts](../../src/testing/fake-calendar-client.test.ts)
  — new. Covers the fake's cursor walking.

No changes to existing files. The interface is new, no consumer
imports it yet.

## Seams involved

- `graph` — defining the seam, no real network.

## RED test list

- AC1: `CalendarClient` interface compiles and exposes
  `listCalendarViewDelta(input): Promise<CalendarViewDeltaPage>`
  - test file: `src/sources/calendar.test.ts`
  - test name: `"CalendarClient interface accepts a CalendarViewDeltaInput and returns a page"`
  - seams touched: graph
  - edge cases: this is mostly a type-level test; runtime assertion
    is on the fake honouring the contract.

- AC2: `mapGraphEventToCalendarEvent` lowers a typical Graph event
  with attendees to a `CalendarEvent` matching the slice-1 shape
  - test file: `src/sources/calendar.test.ts`
  - test name: `"mapGraphEventToCalendarEvent lowers a typical event with attendees"`
  - seams touched: graph
  - edge cases: organizer present, three attendees, ISO timestamps in
    UTC.

- AC3: lowering an online-meeting event populates `chat_id`,
  `online_meeting_url`, `online_meeting_id`
  - test file: `src/sources/calendar.test.ts`
  - test name: `"mapGraphEventToCalendarEvent extracts online meeting fields when present"`
  - seams touched: graph
  - edge cases: `chatInfo.threadId` present; absent (chat_id null);
    `joinUrl` present without `threadId`.

- AC4: lowering a non-online-meeting event leaves those three fields
  null
  - test file: `src/sources/calendar.test.ts`
  - test name: `"mapGraphEventToCalendarEvent leaves online-meeting fields null for in-person events"`
  - seams touched: graph
  - edge cases: `onlineMeeting` is null; `onlineMeeting` is undefined.

- AC5: cancelled event lowers to `is_cancelled: 1`
  - test file: `src/sources/calendar.test.ts`
  - test name: `"mapGraphEventToCalendarEvent surfaces cancellations"`
  - seams touched: graph
  - edge cases: `isCancelled: false` lowers to `0`.

- AC6: all-day event lowers to `is_all_day: 1` with consistent UTC
  bounds
  - test file: `src/sources/calendar.test.ts`
  - test name: `"mapGraphEventToCalendarEvent handles all-day events"`
  - seams touched: graph
  - edge cases: zero-day all-day (single day); multi-day all-day.

- AC7: attendee response-status enumeration round-trips, organizer
  becomes a distinct attendee
  - test file: `src/sources/calendar.test.ts`
  - test name: `"mapGraphEventToCalendarEvent maps attendee response statuses and includes the organizer"`
  - seams touched: graph
  - edge cases: organizer also in attendees list (no double row);
    unknown response value falls back to `'none'`.

- AC8: `FakeCalendarClient` returns pages in cursor order
  - test file: `src/testing/fake-calendar-client.test.ts`
  - test name: `"FakeCalendarClient walks pages by cursor and resolves the deltaLink"`
  - seams touched: graph
  - edge cases: initial call (no cursor) returns first page;
    subsequent call with that page's `nextLink` returns the next;
    final page exposes `deltaLink`, no `nextLink`.

- AC9: `FakeCalendarClient` throws on an unknown cursor
  - test file: `src/testing/fake-calendar-client.test.ts`
  - test name: `"FakeCalendarClient throws on an unknown cursor so loop bugs surface early"`
  - seams touched: graph
  - edge cases: bogus opaque cursor; cursor for a different account.

- AC10: `FakeCalendarClient` rejects accounts not in its allow-list
  - test file: `src/testing/fake-calendar-client.test.ts`
  - test name: `"FakeCalendarClient rejects unknown accounts"`
  - seams touched: graph
  - edge cases: typo on account string; multi-account fixture
    isolation.

## Open questions / assumptions

1. **Assumption:** `cursor: string` is opaque to the sync loop. Either
   `@odata.nextLink` or `@odata.deltaLink` — the loop just stores
   whichever was last handed to it and uses it next tick. Confirm
   during FRAME the `TeamsChannelClient` does the same and we should
   match its shape.
2. **Assumption:** The wire DTO `GraphCalendarEvent` is **not**
   exhaustive. We model only the fields we lower. Fields we don't
   touch are kept on the row via `raw_json` (already in the slice-1
   schema). Confirm during FRAME that no consumer plans to read other
   fields off the typed wire DTO.
3. **Open:** Mapping all-day events. Graph's `start.dateTime` for an
   all-day event is `"YYYY-MM-DDT00:00:00.0000000"` with
   `start.timeZone = "UTC"` if requested via `Prefer: outlook.timezone`.
   We'll request UTC timezone for **all** events to keep the lowering
   pure. FRAME confirms the `Prefer` header is acceptable to add to
   the request signature in slice 3.
4. **Open:** Attendee email casing. Slice 1 fixed `lower()` on insert
   for the PK to be reliable. The mapping function should already
   lower-case here so the lake never sees mixed case. Pin in tests.

## Risks

- **Wire-DTO drift.** Graph adds fields and very occasionally renames
  them. Since the lowering function is the single point that touches
  raw Graph shape, future drift should only require editing one
  function — but only if every consumer goes through it. The risk is
  someone reading raw fields off `raw_json` later; the mitigation is
  comments on the DTO type pointing future readers at the lowering
  function.
- **Fake/real semantic gap.** If `FakeCalendarClient` and
  `HttpCalendarClient` (slice 3) disagree on what an empty page
  looks like, the sync loop tests in slice 4 will pass against the
  fake and break in production. Mitigation: slice 3's tests run
  against a real-shaped fixture loaded from a recorded Graph
  response, and the FRAME of slice 3 explicitly diffs the shapes.

## Out-of-scope follow-ups

- Slice 3: real `HttpCalendarClient` against `/me/calendarView/delta`.
- Slice 4: scope addition + sync wiring.
- Future: a contract-test suite both clients run against (we don't
  have one for `TeamsClient` either; introducing it here would be
  scope creep).
