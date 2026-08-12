# Calendar — Slice 6: `find_events` MCP tool + CLI flags

Parent: [calendar-overview.md](../calendar-overview.md). Predecessor:
[slice 4](./calendar-slice-4-sync-and-scope.md). Optional predecessor:
[slice 5](./calendar-slice-5-meeting-chat-link.md) — slice 6 ships
fine without 5; the `chat_id` field just won't be reliably populated
until 5 lands.

## Task

Expose the calendar lake to the user: a dedicated MCP tool that covers
both "what's on my plate this week" (agenda) **and** "when did we meet
about X" / "did I already plan this" (history search over up to a year
of synced events), plus CLI flags for operator-side inspection and
resync. The tool is named `find_events` rather than
`get_upcoming_events` because it is no longer purely forward-looking —
slice 4 backfills a year of history, and this tool is how a Claude
conversation reaches it.

## Scope boundary

**IN this slice**

- New MCP tool, `find_events`:
  - Input:
    ```ts
    {
      from?: string,             // ISO; default: clock.now(); MAY lie in the past
      to?: string,               // ISO; default: from + 7d
      accounts?: string[],       // default: all known accounts
      subject_contains?: string, // case-insensitive substring match on events.subject
      attendee?: string,         // case-insensitive substring match on attendee
                                 // display name OR email OR organizer name/email
      order?: "asc" | "desc",    // by start_at; default "asc"
      limit?: number             // default 100, max 250
    }
    ```
  - Validates:
    - `to > from`, else `InvalidParams`.
    - **If neither `subject_contains` nor `attendee` is set:**
      `to - from <= 92d` (one quarter cap to keep unfiltered dumps
      bounded; matches the brief's "we want focused answers, not a
      dump"). This is the old AC4 cap, unchanged.
    - **If either filter is set:** the 92d cap does **not** apply —
      the window may span the full synced range (up to the ~425-day
      history from slice 4). `limit` is what bounds the response
      instead. This is new: it's what makes "when did we meet about
      xyz" work across a year of history without a full dump.
  - Output:
    ```ts
    {
      events: Array<CalendarEvent & { attendees: EventAttendee[] }>,
      truncated: boolean   // true when `limit` cut off further matches
    }
    ```
    ordered by `start_at` per the `order` param (default ascending).
    `truncated: true` tells the calling Claude conversation there are
    more matches than shown, so it should narrow the query (tighter
    window, more specific `subject_contains`) rather than assume
    completeness.
  - Backed by a new `MessageStore.findEvents({from, to, accounts,
    subjectContains, attendee, order, limit})` that wraps slice-1's
    `getEventsInRange` shape but adds the filter predicates and the
    ordering/limit — see the SQL sketch below.
  - Steering rules **not** applied here (slice 8 wires them in).
    This tool ships with the same default behaviour as
    `get_recent_activity` had before steering — the next slice
    closes the gap.
- CLI flags in [src/cli.ts](../../../src/cli.ts):
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
  - `--calendar-enable` / `--calendar-disable` already landed in
    [slice 4](./calendar-slice-4-sync-and-scope.md) — not part of this
    slice's diff, listed here only for operator-facing completeness.
- Tool description (the string Claude reads to know when to invoke
  it) explicitly mentions: "agenda", "calendar", "meeting", "planned",
  "when did we meet", "upcoming", "appointment" — to win the routing
  decision against generic message-search tools for both agenda AND
  history-style questions. The description also tells the model when
  to use `order: "desc"` (history questions — "when did we meet about
  X" wants the most recent match first) vs the default `"asc"`
  (agenda questions — "what's next").

**Store method SQL sketch** (for `findEvents`, illustrative — exact
parameterization decided during FRAME):

```sql
SELECT e.*, ... FROM events e
WHERE e.account IN (...)
  AND e.start_at <= :to AND e.end_at >= :from
  AND (:subjectContains IS NULL
       OR e.subject LIKE '%' || :subjectContainsEscaped || '%' ESCAPE '\' COLLATE NOCASE)
  AND (:attendee IS NULL
       OR e.organizer_name LIKE '%' || :attendeeEscaped || '%' ESCAPE '\' COLLATE NOCASE
       OR e.organizer_email LIKE '%' || :attendeeEscaped || '%' ESCAPE '\' COLLATE NOCASE
       OR EXISTS (
         SELECT 1 FROM event_attendees ea
         WHERE ea.account = e.account AND ea.event_id = e.event_id
           AND (ea.display_name LIKE '%' || :attendeeEscaped || '%' ESCAPE '\' COLLATE NOCASE
                OR ea.attendee_email LIKE '%' || :attendeeEscaped || '%' ESCAPE '\' COLLATE NOCASE)
       ))
ORDER BY e.start_at ASC|DESC
LIMIT :limit + 1   -- fetch one extra row to compute `truncated` without a COUNT(*)
```

`%` and `_` in the user-supplied filter strings are escaped before
substitution (SQLite `LIKE ... ESCAPE '\'`) so a literal `%` in a
subject or name doesn't act as a wildcard.

**OUT (deferred)**

- Steering. Slice 8.
- Full-text ranking / FTS5 over event subject or body. The
  `subject_contains`/`attendee` filters above are plain `LIKE`
  substring matches, not ranked search — that distinction stays a
  follow-up per the overview's cross-cutting decisions.
- `get_event_attendees(eventId)` standalone tool — not needed; the
  attendees are inlined on every event row.

## Files to create / touch

- [src/mcp/tools/find-events.ts](../../../src/mcp/tools/find-events.ts)
  — new.
- [src/mcp/tools/find-events.test.ts](../../../src/mcp/tools/find-events.test.ts)
  — new.
- [src/store/message-store.ts](../../../src/store/message-store.ts) —
  add `findEvents`.
- [src/store/message-store-contract.ts](../../../src/store/message-store-contract.ts)
  — add tests.
- [src/store/sqlite-message-store.ts](../../../src/store/sqlite-message-store.ts)
  — implement the SQL sketch above.
- (in-memory fake) — implement equivalent filter/order/limit semantics
  in plain JS.
- [src/mcp/mcp-server.ts](../../../src/mcp/mcp-server.ts) — register.
- [src/mcp/mcp-server.test.ts](../../../src/mcp/mcp-server.test.ts) —
  registry assertion.
- [src/mcp/e2e-http.test.ts](../../../src/mcp/e2e-http.test.ts) — add a
  case driving the new tool through the full HTTP stack.
- [src/cli.ts](../../../src/cli.ts) — `--calendar-list`,
  `--calendar-resync`.
- [src/cli.test.ts](../../../src/cli.test.ts) — new cases.

## Seams involved

- `mcp` — primary.
- `store` — new reader.
- `clock` — input defaulting.
- `fs` — none directly; CLI lives behind the existing fs seam.

## RED test list

- AC1: `findEvents` over multiple accounts returns a single ordered
  list
  - test file: contract suite
  - test name: `"findEvents merges accounts and orders by start_at"`
  - seams touched: store
  - edge cases: zero accounts (empty); one account; two accounts with
    interleaved start times; `order: "desc"` reverses the result.

- AC2: tool defaults `from` to `clock.now()` and `to` to `from + 7d`
  - test file: `src/mcp/tools/find-events.test.ts`
  - test name: `"find_events defaults to a 7-day window from now"`
  - seams touched: mcp, store, clock
  - edge cases: caller supplies neither; caller supplies `from` only.

- AC3: tool rejects `to <= from`
  - test file: `src/mcp/tools/find-events.test.ts`
  - test name: `"find_events rejects to <= from with InvalidParams"`
  - seams touched: mcp
  - edge cases: equal; reversed; one-second-too-small.

- AC4: tool rejects windows wider than 92 days **when unfiltered**
  - test file: `src/mcp/tools/find-events.test.ts`
  - test name: `"find_events rejects windows wider than a quarter when no filter is set"`
  - seams touched: mcp
  - edge cases: 92d exact (allowed); 92d + 1ms (rejected); message
    names the 92-day cap explicitly (AC4's old "actionable error"
    requirement, preserved).

- AC4b: the 92-day cap does **not** apply when `subject_contains` or
  `attendee` is set
  - test file: `src/mcp/tools/find-events.test.ts`
  - test name: `"find_events allows windows wider than a quarter when subject_contains or attendee is set"`
  - seams touched: mcp, store
  - edge cases: 300-day window with `subject_contains` set (accepted);
    same window with neither filter set (rejected, confirming AC4
    still holds); 300-day window with `attendee` set (accepted).

- AC5: tool returns events with attendees inlined
  - test file: `src/mcp/tools/find-events.test.ts`
  - test name: `"find_events inlines attendees per event"`
  - seams touched: mcp, store
  - edge cases: event with zero attendees → `attendees: []`.

- AC5b: `subject_contains` matches case-insensitively and treats `%`
  and `_` as literal characters, not wildcards
  - test file: contract suite
  - test name: `"findEvents subject_contains matches case-insensitively and escapes SQL LIKE metacharacters"`
  - seams touched: store
  - edge cases: mixed-case match; a subject literally containing `%`
    or `_` is only matched when the filter string contains that exact
    character, not treated as a wildcard; substring (not just prefix)
    match.

- AC5c: `attendee` matches attendee display name, attendee email, or
  organizer name/email
  - test file: contract suite
  - test name: `"findEvents attendee matches display name, email, or organizer"`
  - seams touched: store
  - edge cases: matches on an attendee who is not the organizer;
    matches on the organizer when they're not separately listed as an
    attendee; no match returns empty, not an error.

- AC5d: `limit` bounds the result count and sets `truncated`
  - test file: `src/mcp/tools/find-events.test.ts` + contract suite
  - test name: `"find_events caps results at limit and sets truncated when more match"`
  - seams touched: mcp, store
  - edge cases: exactly `limit` matches → `truncated: false`;
    `limit + 1` matches → returns `limit` rows, `truncated: true`;
    caller-supplied `limit` above 250 is clamped to 250, not rejected;
    default `limit` (100) applies when omitted.

- AC6: tool registered in `tools/list`
  - test file: `src/mcp/mcp-server.test.ts`
  - test name: `"mcp server registers find_events"`
  - seams touched: mcp

- AC6b: tool description contains the routing anchor terms
  - test file: `src/mcp/tools/find-events.test.ts`
  - test name: `"find_events description mentions calendar, agenda, meeting, and when-did-we-meet phrasing"`
  - seams touched: mcp
  - edge cases: pins the literal substrings so wording can't silently
    drift and break routing (mirrors the intent of the old AC's open
    question #4).

- AC7: e2e — tool callable end-to-end via HTTP transport
  - test file: `src/mcp/e2e-http.test.ts`
  - test name: `"e2e: find_events returns events from a real SQLite lake"`
  - seams touched: mcp, store, http
  - edge cases: include one case that exercises `subject_contains`
    through the full HTTP stack, not just the unfiltered path.

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

1. **Assumption:** 92-day cap for unfiltered queries. Picked to be
   "one quarter, no more, no less" so a "what's coming up this
   quarter" query works but "the next year" doesn't. Filtered queries
   (subject/attendee) are exempt from this cap per AC4b — FRAME
   confirms both halves or pushes back.
2. **Open:** Should `from` be inclusive and `to` exclusive (the
   norm in this codebase)? Pin in tests.
3. **Open:** CLI output format — re-using the `--list-accounts`
   table style, but events have a `subject` column that can wrap.
   Truncate at 60 chars with `…`. Confirm.
4. **Resolved (was open):** Tool description text now has a fixed set
   of anchor terms (AC6b) — "calendar", "agenda", "meeting", "planned",
   "when did we meet", "upcoming", "appointment" — plus explicit
   guidance on `order: asc` vs `desc`. FRAME still drafts the exact
   prose; the test just pins that these terms survive.
5. **Open:** `limit` default (100) / max (250) — chosen to keep a
   single tool response well within a reasonable MCP payload size even
   with attendees inlined on every row. FRAME confirms these numbers
   are sane against a worst-case attendee count.

## Risks

- **Routing confusion.** If Claude routes "what's on my agenda this
  week" or "when did we meet about X" to `search` or
  `get_recent_activity` instead of `find_events`, the feature is
  invisible. Mitigation: the description has anchor terms for both
  agenda and history phrasing (AC6b); slice 7 (unified feed) further
  reduces this risk by making the wrong route still useful.
- **Stale lake = empty result.** If the scheduler hasn't run yet
  for a freshly-enabled account, `find_events` returns `[]`
  silently. The diagnose-sync-health tool already covers
  "never-synced" detection, but the user's first call here might
  surprise them. Mitigation: changelog entry calls this out;
  `--calendar-list` mirrors the empty result so the surprise is
  consistent across surfaces.
- **Window width footgun (unfiltered only).** A 7-day default is fine
  until someone asks "the next 90 days" with no filter. The cap holds.
  The error must be actionable — pin the message in AC4 to mention the
  cap and to suggest adding a `subject_contains`/`attendee` filter as
  the escape hatch.
- **Unbounded filtered scan cost.** A filtered query can now scan up
  to ~425 days of events per account. Mitigation: the `event_attendees`
  join uses the `(account, event_id)` index from slice 1; `limit`
  bounds the response size regardless of match count; if this proves
  slow in the live smoke, an index on `events(account, subject)` is a
  cheap follow-up (not pre-built here — avoid a speculative index with
  no measured need).

## Out-of-scope follow-ups

- Slice 7: unified `get_recent_activity` with `kind` discriminator.
- Slice 8: steering on events.
- Full-text ranked search (FTS5) over event subject / body — the
  `LIKE`-based filters here are a deliberately cheap substitute, not a
  step toward FTS5. If ranking or relevance scoring is ever needed,
  that's a new, separate follow-up.
