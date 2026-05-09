# Calendar import — feature overview

## Why

Today the lake holds messages (Outlook, Teams chat, Teams channel, Viva,
WhatsApp). The natural next axis is the user's **agenda**: meetings on
the calendar, with their attendees, and — for online meetings — a link
to the Teams chat that lives alongside the meeting. With agenda data in
the lake, "what's on my plate this week", "what was the last Teams
conversation about my 1:1 with X", and "what did the people invited to
that meeting message about it" all become single MCP calls.

## Shape of the feature

End state of the **base** feature (slices 1–8, no transcripts):

- New `events` and `event_attendees` tables in the lake, populated
  from Microsoft Graph `/me/calendarView/delta` on every sync tick.
- For online meetings, `events.chat_id` is resolved to the Teams
  meeting-chat thread already stored in `messages.thread_id`, so a
  meeting and its chat are joinable with a single SQL key.
- One new MCP tool, `get_upcoming_events`, plus events folded into
  `get_recent_activity` as a heterogeneous feed (`kind: "message" |
  "event"`, shared `at` timestamp, default window covering past
  messages **and** upcoming meetings).
- Steering rules grow two new predicate types
  (`event_organizer_email`, `event_subject_contains`) so the user can
  mute noisy meetings the same way they mute noisy senders.
- New CLI flags for parity with existing sources
  (`--calendar-list`, `--calendar-resync`).
- New delegated Graph scope: `Calendars.Read`.

**Transcripts** (Teams Premium, app-only consent, VTT parsing) live
behind a separate optional follow-up plan ([calendar-transcripts.md](./calendar-transcripts.md))
that does not block any of the base slices.

## Slicing

Each slice is one TDD cycle. Bigger work is **always** split — the
prior multi-piece features (Teams channels, Viva, OAuth) all came in
5–8 slices, and this is the same shape.

| # | Slice                          | What it lands                                                                 | Plan |
|---|--------------------------------|-------------------------------------------------------------------------------|------|
| 1 | Schema + store seam            | `events` + `event_attendees` tables, `MessageStore` ops, types                | [calendar-slice-1-schema-and-store.md](./calendar-slice-1-schema-and-store.md) |
| 2 | `CalendarClient` seam + fake   | Interface + `FakeCalendarClient`, no HTTP, no sync                            | [calendar-slice-2-client-seam.md](./calendar-slice-2-client-seam.md) |
| 3 | `HttpCalendarClient`           | Real Graph `/me/calendarView/delta` impl, paging, `@removed`, error mapping   | [calendar-slice-3-http-client.md](./calendar-slice-3-http-client.md) |
| 4 | Sync job + scope + scheduler   | `syncCalendarEvents`, `Calendars.Read` scope, scheduler wiring, `sync_log`    | [calendar-slice-4-sync-and-scope.md](./calendar-slice-4-sync-and-scope.md) |
| 5 | Meeting ↔ Teams chat link      | Populate `events.chat_id`, add `get_event` tool joining linked messages       | [calendar-slice-5-meeting-chat-link.md](./calendar-slice-5-meeting-chat-link.md) |
| 6 | `get_upcoming_events` + CLI    | New MCP tool, `--calendar-list`, `--calendar-resync` flags                    | [calendar-slice-6-mcp-and-cli.md](./calendar-slice-6-mcp-and-cli.md) |
| 7 | Unified `get_recent_activity`  | `kind` discriminator, shared sort key, default window covers past + future    | [calendar-slice-7-unified-activity.md](./calendar-slice-7-unified-activity.md) |
| 8 | Event steering                 | Two new predicate types, `buildSteeringPredicate` applies to events           | [calendar-slice-8-event-steering.md](./calendar-slice-8-event-steering.md) |
| — | (Optional) Transcripts         | Premium-gated app-only OAuth, VTT parser, transcript table, `get_event_transcript` | [calendar-transcripts.md](./calendar-transcripts.md) |

## Order rules

- Slices 1–4 are strictly sequential: each depends on the previous.
- Slice 5 depends on slice 4 (the sync job has to run before there's
  anything to link).
- Slice 6 can land **before** slice 5; the tool just won't include
  `chat_id` in its output until 5 lands. Doing 6 before 5 trades a
  brief feature gap for earlier user-facing value.
- Slice 7 depends on slice 6 (otherwise nothing reads events) and on
  the schema from slice 1, but is independent of slice 5.
- Slice 8 depends on slice 7 (steering needs an event reader to
  filter) and slice 6 (the tool surface that consumes the filter).
- Transcripts depend on slice 4 (events have to exist first).

## Cross-cutting decisions (locked at overview level)

These are the decisions every slice plan assumes. If any of them
moves, the plan it touches has to move too.

- **Sync horizon model.** First sync per account walks
  `/me/calendarView/delta` over a rolling window
  `[now - 7d, now + 30d]`. Subsequent ticks resume from the
  per-account `@odata.deltaLink`. The window does **not** float on
  every tick — that's a property of the delta token. A future
  "nightly horizon refresh" job (out of scope for the base feature)
  will bump the window forward.
- **Event identity.** Primary key is `(account, event_id)`, where
  `event_id` is whatever Graph returns from the calendarView delta
  page — i.e. recurring series fan out to one row per occurrence as
  Graph hands them to us. We do not expand recurrence ourselves.
- **Storage shape.** Events live on `MessageStore`, not on a new
  `EventStore`. Every other lake source already lives there, the
  steering filter expects one store, and slice 7 needs a single
  transactional view across messages and events. Renaming
  `MessageStore` → `LakeStore` is a separate refactor and out of scope
  for this feature.
- **Online-meeting fields.** `events.online_meeting_url`,
  `events.online_meeting_id`, `events.chat_id` are all nullable on
  the row. They are populated only when Graph's `onlineMeeting`
  payload is non-null on the event. Non-online meetings carry NULL
  for all three.
- **Cancelled events.** Graph signals cancellations via `isCancelled`.
  We persist them with `is_cancelled = 1` rather than deleting the
  row, so the user can still ask "what got cancelled this week".
  `getEventsInRange` returns them; filtering is the caller's job.
- **Time zones.** `start_at` and `end_at` are always stored as ISO-8601
  UTC strings. `is_all_day` is a separate flag because Graph treats
  all-day events as `00:00:00 → 24:00:00` in the user's tz, which is
  not faithfully representable as a single UTC range without context.
- **No FTS5 in the base feature.** Subject + body for events are not
  added to `messages_fts` (or a new `events_fts`). Free-text search
  over event content is a follow-up after the base ships.

## Definition of done for the base feature

- All 8 base slices merged with their `/tdd-cycle` artifacts (plan
  archived, ≥90% line+branch on touched files, `/security-scan`
  clean, `/docs-update` run).
- A live smoke against a real test tenant: `--calendar-resync`, one
  scheduler tick, `get_upcoming_events`, and `get_recent_activity`
  all return real-looking results, with at least one online meeting
  carrying a non-null `chat_id` whose Teams messages are also in the
  lake.
- `docs/changelog.md` covers calendar end-to-end.
- `waldo.WTF-project-brief.md` §3 framing updated to acknowledge
  agenda alongside messaging (the brief currently calls the lake a
  "messaging" lake — that wording was challenged at the top of the
  design conversation and needs to land before slice 1 ships).
