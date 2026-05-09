# Calendar — Slice 1: schema v16 + `events` store seam

## Task

Land the SQLite schema + `MessageStore` operations needed to hold Microsoft
Graph calendar events (and their attendees) in the lake, behind a
testable seam, with **no** Graph client, sync job, MCP tool, or CLI
wiring yet.

## Scope boundary

**IN this slice**

- Schema migration v15 → v16:
  - `events` table (PK `(account, event_id)`).
  - `event_attendees` table (PK `(account, event_id, attendee_email)`,
    FK on `(account, event_id)` with `ON DELETE CASCADE`).
  - Supporting indexes for the queries we know we need
    (`events(start_at)`, `events(account, start_at)`).
- New types in [src/store/types.ts](../../src/store/types.ts):
  - `CalendarEvent`
  - `EventAttendee`
  - `EventResponseStatus`
    (`'none' | 'accepted' | 'tentative' | 'declined' | 'notResponded' | 'organizer'`).
- New `MessageStore` methods (on the contract, the in-memory fake, and the
  SQLite impl):
  - `upsertEvents(events: CalendarEvent[]): void` — atomic upsert,
    replaces attendees for each upserted event.
  - `deleteEvents(keys: { account: string; eventId: string }[]): void`
    — removes events + their attendees (cascade).
  - `getEventsInRange(account, fromIso, toIso): CalendarEvent[]` —
    returns events whose `[startAt, endAt]` overlaps the window,
    ordered by `startAt` ascending. Returns attendees joined in.
- The `events` row carries the columns we'll need later but not wire
  in this slice, so we don't have to bump the schema again:
  `tenant_id`, `chat_id` (online-meeting Teams chat), `online_meeting_url`,
  `online_meeting_id`, `is_cancelled`, `is_all_day`, `last_modified_at`,
  `raw_json`.

**OUT (deferred to later slices)**

- Slice 2: `CalendarClient` seam + `FakeCalendarClient`.
- Slice 3: `HttpCalendarClient` against `/me/calendarView/delta`.
- Slice 4: `syncCalendarEvents` job + scheduler wiring + `Calendars.Read`
  scope addition.
- Slice 5: meeting ↔ Teams chat link population (resolves `chat_id`
  from `onlineMeeting.chatInfo.threadId`, surfaces linked messages
  via `get_event` / by membership in the same `chat_id` query).
- Slice 6: MCP tool `get_upcoming_events` + CLI flags.
- Slice 7: fold events into `get_recent_activity` as a heterogeneous
  feed (`kind: "message" | "event"` discriminator), shared sort key,
  default window covering both directions.
- Slice 8: steering rules apply to events — extend predicate types
  (`subject_contains`, plus a `kind` filter so the user can mute "all
  events from organizer X" without muting their messages).
- Transcripts are a **separate plan** entirely (license-gated, app-only
  consent, VTT parser, separate `transcript_segments` table).

## Files to create / touch

- [src/store/schema.ts](../../src/store/schema.ts) — bump
  `CURRENT_SCHEMA_VERSION` to 16, add `migrateV16(db)` with the two
  CREATE TABLE statements + indexes + `applyMigrations` step.
- [src/store/schema.test.ts](../../src/store/schema.test.ts) — new
  cases for v15 → v16 migration (idempotent; tables present; indexes
  present; FK cascade observable).
- [src/store/types.ts](../../src/store/types.ts) — `CalendarEvent`,
  `EventAttendee`, `EventResponseStatus`.
- [src/store/types.test.ts](../../src/store/types.test.ts) — type-level
  shape assertions where they exist for siblings.
- [src/store/message-store-contract.ts](../../src/store/message-store-contract.ts)
  — add `upsertEvents`, `deleteEvents`, `getEventsInRange` to the
  contract test suite.
- [src/store/message-store.ts](../../src/store/message-store.ts) — extend
  `MessageStore` interface with the three new methods.
- [src/store/sqlite-message-store.ts](../../src/store/sqlite-message-store.ts)
  — implement against schema v16, transactional upsert (events row +
  attendee replace-set in one tx).
- [src/store/sqlite-message-store.test.ts](../../src/store/sqlite-message-store.test.ts)
  — drive via the shared contract suite + sqlite-specific edge cases.
- `src/store/in-memory-message-store.ts` (or wherever the fake lives —
  confirm during FRAME) — mirror semantics.
- [src/store/message-store.test.ts](../../src/store/message-store.test.ts)
  — fake's pass through the contract suite.

No changes to `src/sync/`, `src/sources/`, `src/mcp/`, `src/cli.ts`,
`src/index.ts`, `src/auth/`. That's deliberate — this slice is a
testable foundation, nothing more.

## Seams involved

- `store` — primary. Everything in this slice is about extending the
  MessageStore contract + its two implementations.
- `clock` — only at the test boundary, for deterministic
  `last_modified_at` and range queries.

No `graph`, no `msal`, no `fs`, no `http`, no `logger` work in this
slice.

## RED test list

- AC1: schema v16 migration creates `events` and `event_attendees`
  - test file: `src/store/schema.test.ts`
  - test name: `"v16 migration creates events and event_attendees tables with expected columns"`
  - seams touched: store
  - edge cases: idempotent re-apply (v16 → v16 no-op); from-fresh
    (v0 → v16 in one shot) creates them too.

- AC2: schema v16 migration adds `(events.start_at)` and
  `(events.account, events.start_at)` indexes
  - test file: `src/store/schema.test.ts`
  - test name: `"v16 migration adds events range-query indexes"`
  - seams touched: store
  - edge cases: index list survives a re-apply.

- AC3: `upsertEvents` inserts a brand-new event with attendees in one tx
  - test file: contract suite, hit via `sqlite-message-store.test.ts`
    + `message-store.test.ts` (fake)
  - test name: `"upsertEvents inserts a new event with its attendees"`
  - seams touched: store, clock
  - edge cases: zero attendees; one organizer-only; many; unicode subject.

- AC4: `upsertEvents` updates an existing event and **replaces** its
  attendee set (no orphan rows)
  - test file: contract suite
  - test name: `"upsertEvents replaces attendees on update, not append"`
  - seams touched: store
  - edge cases: attendee dropped; attendee response_status changed;
    attendee email case-folded consistently.

- AC5: `deleteEvents` removes the event + cascades to attendees
  - test file: contract suite
  - test name: `"deleteEvents removes the event and its attendees"`
  - seams touched: store
  - edge cases: delete event that doesn't exist (no-op, no throw);
    delete with empty list (no-op).

- AC6: `getEventsInRange` returns events whose `[startAt, endAt]`
  overlaps the window, ordered by `startAt` asc, and includes attendees
  - test file: contract suite
  - test name: `"getEventsInRange returns overlapping events ordered by start_at with attendees joined"`
  - seams touched: store
  - edge cases: event entirely before window (excluded); entirely
    after (excluded); spans the window (included); starts before
    window ends inside (included); cancelled events (still returned —
    filtering is the caller's job in this slice); other-account events
    (excluded — `account` is in the query).

- AC7: `CalendarEvent` / `EventAttendee` types compile and round-trip
  through the store unchanged for the columns we persist
  - test file: contract suite (the round-trip is the assertion;
    no separate type-level test unless siblings have one)
  - test name: `"upsert + getEventsInRange round-trips all CalendarEvent columns"`
  - seams touched: store
  - edge cases: `chat_id`, `online_meeting_url`, `tenant_id` all
    nullable and round-trip as null when unset; `is_all_day` boolean
    round-trips through the SQLite 0/1 conversion.

- AC8: writing two events with the same `event_id` under different
  accounts does not collide (PK is `(account, event_id)`)
  - test file: contract suite
  - test name: `"events PK is composite (account, event_id)"`
  - seams touched: store
  - edge cases: confirms multi-tenant isolation up front.

## Open questions / assumptions

1. **Assumption:** Event identity is `(account, event_id)` — `event_id`
   is Graph's `id` for the event-instance the calendarView returned
   (so a recurrence series fans out to many `event_id`s, one per
   instance). Confirm during FRAME against the Graph
   `/me/calendarView/delta` doc and the existing `messages` PK
   convention.
2. **Assumption:** `events.chat_id` is plain text matching the Teams
   `chat.id` we already store on chat messages. We're **not** adding
   the FK now (Teams chats live in `messages.thread_id`, not in their
   own `chats` table), so `chat_id` is informational until slice 5
   wires the join. Confirm during FRAME.
3. **Assumption:** Bolt onto `MessageStore` rather than introducing a
   new `EventStore` contract. Rationale: every prior lake-source
   (Teams, Viva, WhatsApp) lives on `MessageStore`, the steering
   filter expects one store, and `get_recent_activity` (slice 7) will
   want a single transactional view. A future rename to `LakeStore`
   is a separate refactor and explicitly **out of scope**.
4. **Assumption:** No FTS5 for events in this slice. Subject + body
   indexing into `messages_fts` (or a new `events_fts`) is part of
   slice 7's search story, not this one.
5. **Open:** `attendee_email` casing — the existing `messages.from`
   stores the address verbatim from Graph. Some clients send mixed
   case. For the PK to be reliable, we should `lower()` it on insert.
   Decide during FRAME; tests will pin the chosen rule.

## Risks

- **Schema bump churn.** v16 is the 16th migration on this DB; adding
  speculative columns we don't populate yet (`chat_id`,
  `online_meeting_url`, `online_meeting_id`, `is_cancelled`,
  `tenant_id`, `raw_json`) means we don't have to bump again in
  slices 2–6. Risk: those columns turn out to need different shapes
  once Graph payloads land. Mitigation: they're all nullable, all
  ignored by every code path in this slice, and a column rename in
  v17 is cheap.
- **Contract suite drift.** Adding three methods to the shared
  contract means `InMemoryMessageStore` and `SqliteMessageStore` both
  need to pass the same suite. If their semantics diverge silently
  (e.g. fake stores `is_all_day` as `boolean` while sqlite stores
  `0|1`), production code will be tested against the wrong shape.
  Mitigation: every assertion goes through the contract suite, never
  the impl-specific test, for the round-trip cases.
- **Cascade behavior.** `event_attendees` FK with `ON DELETE CASCADE`
  is the cleanest, but `better-sqlite3` requires
  `PRAGMA foreign_keys = ON` per connection. `openDatabase` already
  sets this — confirm during FRAME and make AC5 fail loudly if it
  doesn't.

## Out-of-scope follow-ups

- **Slice 2:** `CalendarClient` seam + `FakeCalendarClient` (mirrors
  `TeamsClient` / `FakeTeamsClient` shape).
- **Slice 3:** `HttpCalendarClient` — `/me/calendarView/delta` with
  `startDateTime` / `endDateTime` window, page walk via `@odata.nextLink`,
  delta token via `@odata.deltaLink`, `@removed` semantics, 401 / 410 /
  429 mapping reused from `classifyError`.
- **Slice 4:** `Calendars.Read` delegated scope added to MSAL,
  `syncCalendarEvents` job, scheduler tick wiring, `sync_log` rows for
  `source = "calendar"`. Sync horizon = rolling `[now - 7d, now + 30d]`
  unless a delta token already exists for the account.
- **Slice 5:** Populate `events.chat_id` from
  `onlineMeeting.chatInfo.threadId` during sync; expose
  `get_event(eventId)` MCP tool that joins linked Teams chat messages.
- **Slice 6:** `get_upcoming_events(from, to, accounts?)` MCP tool;
  `--calendar-list` CLI flag.
- **Slice 7:** Heterogeneous `get_recent_activity` — `kind`
  discriminator, shared sort key, default window covering past
  messages + upcoming events.
- **Slice 8:** Steering rules apply to events — new predicate types
  `subject_contains` and `kind`, wired through `buildSteeringPredicate`.
- **Separate plan (not a slice of this feature):** transcripts —
  `OnlineMeetingTranscript.Read.All` (likely app-only, tenant admin
  consent), VTT parser, `transcript_segments` table, search
  integration. License-gated (Teams Premium).
