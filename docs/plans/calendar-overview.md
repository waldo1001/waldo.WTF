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

- New `events`, `event_attendees`, and `calendar_accounts` tables in
  the lake. Events are populated from Microsoft Graph
  `/me/calendarView/delta` on every sync tick, **only for accounts the
  operator has explicitly opted in** via `--calendar-enable`.
- Calendar is **per-account opt-in**, not on-by-default. Only accounts
  with a `calendar_accounts` row (enabled via `--calendar-enable
  <account>`, removable via `--calendar-disable <account>`) get synced.
  This matters because the user only wants 2 of several lake accounts
  carrying calendar data.
- For online meetings, `events.chat_id` is resolved to the Teams
  meeting-chat thread already stored in `messages.thread_id`, so a
  meeting and its chat are joinable with a single SQL key.
- One new MCP tool, **`find_events`** — agenda lookups (upcoming, next
  7 days) *and* history/search lookups (`subject_contains`, `attendee`
  filters spanning the full synced range) in one tool — plus events
  folded into `get_recent_activity` as a heterogeneous feed
  (`kind: "message" | "event"`, shared `at` timestamp, default window
  covering past messages **and** upcoming meetings).
- Steering rules grow two new predicate types
  (`event_organizer_email`, `event_subject_contains`) so the user can
  mute noisy meetings the same way they mute noisy senders.
- New CLI flags: `--calendar-enable <account>` / `--calendar-disable
  <account>` (opt-in control, slice 4), `--calendar-list` /
  `--calendar-resync` (parity with existing sources, slice 6).
- New delegated Graph scope: `Calendars.Read`, exposed as its own
  `CALENDAR_SCOPES` constant — **never merged into the base `SCOPES`**
  used for every account's silent token refresh. Requesting it happens
  only at `--calendar-enable` time, for that one account. This is what
  makes opt-in real: enabling calendar for account A never re-prompts
  or re-consents accounts B, C, D.

**Transcripts** are a committed follow-on (slices 9–14 below,
[calendar-transcripts.md](./done/calendar-transcripts.md)), not merely
optional. Verified against current Microsoft Graph docs
(learn.microsoft.com/graph/api/calltranscript-get,
learn.microsoft.com/graph/teams-licenses): transcripts use **delegated**
`OnlineMeetingTranscript.Read.All` (no app-only auth, no second app
registration, no tenant-admin-consent flow beyond ordinary delegated
scope consent) and are **not gated behind Teams Premium** — the two
real gates are whether a given meeting was actually transcribed, and
Graph's per-tenant metering (~600 free minutes/month, then HTTP 402
without an Azure billing link). Transcripts inherit the same
per-account opt-in model as calendar, plus their own
`transcripts_enabled` column, and remain strictly sequenced after the
base slices — none of the base slices' scope or shape changed to
accommodate them.

## Slicing

Each slice is one TDD cycle. Bigger work is **always** split — the
prior multi-piece features (Teams channels, Viva, OAuth) all came in
5–8 slices, and this is the same shape.

| # | Slice                          | What it lands                                                                 | Plan |
|---|--------------------------------|-------------------------------------------------------------------------------|------|
| 1 | Schema + store seam ✅ (2026-08-12) | `events` + `event_attendees` + `calendar_accounts` tables, `MessageStore` ops, types | [done/calendar-slice-1-schema-and-store.md](./done/calendar-slice-1-schema-and-store.md) |
| 2 | `CalendarClient` seam + fake ✅ (2026-08-12) | Interface + `FakeCalendarClient`, no HTTP, no sync                            | [done/calendar-slice-2-client-seam.md](./done/calendar-slice-2-client-seam.md) |
| 3 | `HttpCalendarClient` ✅ (2026-08-12) | Real Graph `/me/calendarView/delta` impl, paging, `@removed`, error mapping   | [done/calendar-slice-3-http-client.md](./done/calendar-slice-3-http-client.md) |
| 4 | Sync job + opt-in + scope + scheduler ✅ (2026-08-12) | `syncCalendarEvents`, `CalendarAccountStore` opt-in, `CALENDAR_SCOPES`, `--calendar-enable/disable`, scheduler wiring, `sync_log` | [done/calendar-slice-4-sync-and-scope.md](./done/calendar-slice-4-sync-and-scope.md) |
| 5 | Meeting ↔ Teams chat link ✅ (2026-08-12) | Populate `events.chat_id`, add `get_event` tool joining linked messages       | [done/calendar-slice-5-meeting-chat-link.md](./done/calendar-slice-5-meeting-chat-link.md) |
| 6 | `find_events` + CLI ✅ (2026-08-12) | New MCP tool with subject/attendee filters, `--calendar-list`, `--calendar-resync` flags | [done/calendar-slice-6-mcp-and-cli.md](./done/calendar-slice-6-mcp-and-cli.md) |
| 7 | Unified `get_recent_activity`  | `kind` discriminator, shared sort key, default window covers past + future    | [calendar-slice-7-unified-activity.md](./done/calendar-slice-7-unified-activity.md) |
| 8 | Event steering                 | Two new predicate types, `buildSteeringPredicate` applies to events           | [calendar-slice-8-event-steering.md](./done/calendar-slice-8-event-steering.md) |
| 9 | Transcripts: schema            | `transcripts` + `transcript_segments` tables (v17 → v18), `MessageStore` ops  | [calendar-transcripts.md § T1](./done/calendar-transcripts.md#t1--schema--store-ops) |
| 10 | Transcripts: scope + consent  | `TRANSCRIPT_SCOPES`, `--transcripts-enable`, admin-consent doc                | [calendar-transcripts.md § T2](./done/calendar-transcripts.md#t2--delegated-scope--admin-consent) |
| 11 | Transcripts: client seam       | `TranscriptClient` interface + `FakeTranscriptClient`                        | [calendar-transcripts.md § T3](./done/calendar-transcripts.md#t3--transcriptclient-seam--fake) |
| 12 | Transcripts: HTTP + VTT parser | `HttpTranscriptClient`, VTT → segments, error mapping incl. 402 quota        | [calendar-transcripts.md § T4](./done/calendar-transcripts.md#t4--httptranscriptclient--vtt-parser) |
| 13 | Transcripts: sync job          | `syncTranscripts`, eligibility window, per-tick cap, `sync_log`               | [calendar-transcripts.md § T5](./done/calendar-transcripts.md#t5--synctranscripts-job--scheduler) |
| 14 | Transcripts: MCP surface       | `get_event_transcript`, `include_transcript` on `get_event`                  | [calendar-transcripts.md § T6](./done/calendar-transcripts.md#t6--mcp-surface) |
| — | (Optional) Transcripts FTS5    | `transcript_segments_fts`, `search` tool `kinds` filter                      | [calendar-transcripts.md § T7](./done/calendar-transcripts.md#t7--fts5-search) |

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
- Transcript slice 9 (schema) depends on **slice 8**, not just slice 1
  — schema v17 is already claimed by slice 8's steering enum-widening
  bump, so slice 9's `transcripts`/`transcript_segments` tables land at
  v18 and cannot be built until v17 exists. Slice 10 (scope + consent)
  reuses the `CalendarAccountStore` and `--calendar-enable` CLI pattern
  from slice 4, so it depends on slice 4. Slices 11–14 are
  strictly sequential after 9 and 10. Slice 13 (sync job) strongly
  wants slice 5 landed first (transcript rows are much more useful once
  `get_event` already joins the linked Teams chat), but is not blocked
  by it. Slice 14 (MCP surface) extends `get_event`, so it depends on
  slice 5 for that tool to exist.

## Cross-cutting decisions (locked at overview level)

These are the decisions every slice plan assumes. If any of them
moves, the plan it touches has to move too.

- **Sync horizon model.** First sync per *newly-enabled* account walks
  `/me/calendarView/delta` over a rolling window
  `[now - 365d, now + 60d]` — a full year of history so "when did we
  meet about X" questions work, plus two months of runway. Subsequent
  ticks resume from the per-account `@odata.deltaLink`. The window does
  **not** float on every tick — that's a property of the delta token.
  A future "nightly horizon refresh" job (out of scope for the base
  feature) will bump the window forward. **Implementation note:** if
  Graph rejects a ~425-day initial range, slice 4 has a documented
  chunked-backfill fallback — see that slice's open questions.
- **Calendar is per-account opt-in.** Unlike every other lake source
  (Inbox, Sent, Teams, Viva, WhatsApp), calendar sync does **not** run
  for every known account by default. A new `calendar_accounts` table
  (slice 1) tracks which accounts are opted in; `--calendar-enable
  <account>` / `--calendar-disable <account>` (slice 4) control it; the
  scheduler skips calendar sync entirely for non-enabled accounts.
  `Calendars.Read` is requested as its own `CALENDAR_SCOPES` constant,
  never merged into base `SCOPES` — so enabling one account never
  triggers a consent prompt for any other account. Rationale: the user
  only wants calendar data from 2 of several lake accounts, and this
  avoids the alternative (bump base `SCOPES`, force every account
  through one re-login) entirely.
- **Transcripts are per-account opt-in too, no global env flag.** A
  `transcripts_enabled` column on `calendar_accounts` (set via
  `--transcripts-enable <account>`, slice 10) gates transcript sync per
  account. There is no `WALDO_TRANSCRIPTS_ENABLED` environment variable
  — the per-account column already is the opt-in, so a redundant global
  gate was dropped from the original transcripts plan.
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
- **No FTS5 in the base feature — but cheap LIKE filters ARE in base.**
  Subject + body for events are not added to `messages_fts` (or a new
  `events_fts`); there is no full-text ranking. But `find_events`
  (slice 6) does support plain SQL `LIKE` filters on `subject_contains`
  and `attendee`, because "when is the meeting about xyz" needs *some*
  cheap search over a year of history, and building the full FTS5
  machinery for that is disproportionate. FTS5 over transcript segments
  remains a genuinely optional follow-up (slice 14's T7).
- **`calendar_accounts` is CLI-only, never MCP-writable.** Enabling or
  disabling calendar/transcripts for an account is an operator action
  taken from the machine running the sync, the same trust tier as
  `--add-account`. No MCP tool reads or writes this table. This means
  the CLAUDE.md "read-only forever" exception carved out for steering
  rules does **not** need to grow to cover calendar opt-in — it's
  outside the MCP surface entirely.

## Definition of done for the base feature

- All 8 base slices merged with their `/tdd-cycle` artifacts (plan
  archived, ≥90% line+branch on touched files, `/security-scan`
  clean, `/docs-update` run).
- A live smoke against a real test tenant:
  - `--calendar-enable <account>` for exactly one of the test tenant's
    accounts, confirming the device-code prompt appears and a
    `calendar_accounts` row is written.
  - A second signed-in account in the same tenant is confirmed **not**
    prompted for consent and **not** synced (no `events` rows, no
    `sync_log` rows with `source="calendar"` for that account) after a
    scheduler tick.
  - `--calendar-resync`, one scheduler tick, `find_events` (both a
    plain window query and a `subject_contains`/`attendee`-filtered
    query), and `get_recent_activity` all return real-looking results,
    with at least one online meeting carrying a non-null `chat_id`
    whose Teams messages are also in the lake.
- `docs/changelog.md` covers calendar end-to-end, including the
  per-account opt-in model and the `--calendar-enable`/`disable` flags.
- `waldo.WTF-project-brief.md` §3 framing updated to acknowledge
  agenda alongside messaging (the brief currently calls the lake a
  "messaging" lake — that wording was challenged at the top of the
  design conversation and needs to land before slice 1 ships).

## Definition of done for transcripts (slices 9–14)

- All 6 committed transcript slices merged with their `/tdd-cycle`
  artifacts (T7/FTS5 remains genuinely optional and is not required
  for this definition of done).
- A live smoke against a real test tenant with at least one recently
  transcribed online meeting: `--transcripts-enable <account>`,
  one scheduler tick, `get_event_transcript` returns real segments for
  that meeting, and `include_transcript: true` on `get_event` returns
  the same segments inline.
- A live smoke confirming the `not-available` path: an account with a
  synced online meeting that was never transcribed returns `transcript:
  null, segments: []` from `get_event_transcript`, not an error.
- `docs/changelog.md` covers transcripts end-to-end: the delegated-scope
  consent step, the metering/402 behavior and cost implication, and the
  meeting-expiration eligibility window.
