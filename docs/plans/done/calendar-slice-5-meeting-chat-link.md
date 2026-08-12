# Calendar — Slice 5: meeting ↔ Teams chat link

Parent: [calendar-overview.md](../calendar-overview.md). Predecessor:
[slice 4](./calendar-slice-4-sync-and-scope.md).

## Task

For online-meeting events, populate `events.chat_id` so the meeting
row points at the Teams meeting-chat thread that already lives in
`messages.thread_id`, and expose a single MCP call that returns the
event together with the messages from that linked chat.

## Scope boundary

**IN this slice**

- Confirm slice-2's `mapGraphEventToCalendarEvent` already extracts
  `onlineMeeting.chatInfo.threadId` into `chat_id`. If Graph's actual
  shape on the live API differs from the slice-2 fixture (which we
  recorded from a single tenant), this slice corrects it. Rerunning
  AC3/AC4 from slice 2 against new fixtures stays here.
- Verify: a Teams meeting-chat thread carries the same id whether
  surfaced via `events.chat_id` or via the Teams chat sync's
  `messages.thread_id`. They both originate from the
  `19:meeting_*@thread.v2` namespace, but slice 4's smoke run will
  catch a casing or prefix mismatch.
- New MCP tool, `get_event(eventId, account?)`:
  - Input: `eventId` (required), `account` (optional — required only
    when the same `event_id` exists across accounts, which can happen
    if the user is invited as a guest on another tenant).
  - Output:
    ```ts
    {
      event: CalendarEvent,
      attendees: EventAttendee[],
      linkedChat: null | {
        chatId: string,
        messages: Message[]   // last 50 by default
      }
    }
    ```
  - When `event.chat_id` is null, `linkedChat` is null.
  - When `event.chat_id` is set but no messages live under that
    `thread_id` in the lake yet (e.g. the chat sync hasn't run since
    the meeting started), `linkedChat.messages` is `[]` — not an
    error.
  - Steering rules **do not** apply to this tool, mirroring the
    existing carve-out for `get_thread`. Rationale: if the user
    explicitly asks for a specific event, they want everything,
    including messages from senders they've muted.
- New `MessageStore.getEventByKey({account, eventId}): CalendarEvent | null`
  reader. Slice 1 only added `getEventsInRange`; this is the
  point-lookup companion.
- Schema: **none**. The `chat_id` column already exists on the
  `events` table from slice 1.

**OUT (deferred)**

- "Find the event for this chat" — the reverse lookup. Surface only
  if a real query needs it. Out of scope.
- Joining attendees to `messages.from` to score "people who are at
  this meeting and posted in the chat" — speculative; defer until a
  user query asks for it.
- Showing messages from **before** the meeting started — currently
  the meeting-chat thread is created when the meeting is scheduled;
  Teams doesn't backfill chat history for it. So a default chat
  return is "everything from this thread", which is identical to
  "everything related to the meeting". No filter needed.
- Search across linked chats. Slice 7 + standard `search` covers it.

## Files to create / touch

- [src/sources/calendar.ts](../../../src/sources/calendar.ts) —
  potentially fix `mapGraphEventToCalendarEvent` based on what slice 4
  smoke turns up.
- [src/sources/calendar.test.ts](../../../src/sources/calendar.test.ts)
  — corresponding fixture updates.
- [src/store/message-store.ts](../../../src/store/message-store.ts) —
  add `getEventByKey` to the contract.
- [src/store/message-store-contract.ts](../../../src/store/message-store-contract.ts)
  — add tests.
- [src/store/sqlite-message-store.ts](../../../src/store/sqlite-message-store.ts)
  — implement.
- (in-memory fake) — implement.
- [src/mcp/tools/get-event.ts](../../../src/mcp/tools/get-event.ts) — new
  handler.
- [src/mcp/tools/get-event.test.ts](../../../src/mcp/tools/get-event.test.ts)
  — new.
- [src/mcp/mcp-server.ts](../../../src/mcp/mcp-server.ts) — register the
  tool in the `{name → handler}` map.
- [src/mcp/mcp-server.test.ts](../../../src/mcp/mcp-server.test.ts) —
  assert the tool is in `tools/list`.

## Seams involved

- `store` — point-lookup reader.
- `mcp` — new tool handler.
- `clock` — for "last 50 messages" ordering predictability.

## RED test list

- AC1: `getEventByKey` returns the event with attendees joined,
  `null` when not found
  - test file: contract suite
  - test name: `"getEventByKey returns the event with attendees, or null"`
  - seams touched: store
  - edge cases: cross-account isolation (same `eventId` under two
    accounts returns the right one); event with zero attendees.

- AC2: `get_event` tool returns event + attendees + null linked chat
  for an in-person meeting
  - test file: `src/mcp/tools/get-event.test.ts`
  - test name: `"get_event returns event with attendees and null linkedChat for in-person events"`
  - seams touched: mcp, store
  - edge cases: event found, `chat_id` null in the row.

- AC3: `get_event` for an online meeting returns the linked chat with
  its messages
  - test file: `src/mcp/tools/get-event.test.ts`
  - test name: `"get_event returns linkedChat with messages for an online meeting"`
  - seams touched: mcp, store
  - edge cases: 50+ messages exist (top 50 returned, ordered by
    `created_at` desc, mirroring `get_thread`'s slice-1 behaviour
    after [docs/plans/done/fix-get-thread-latest-by-default.md](./fix-get-thread-latest-by-default.md));
    fewer than 50 (all returned).

- AC4: `get_event` for an online meeting whose chat has no messages
  in the lake yet returns `messages: []`
  - test file: `src/mcp/tools/get-event.test.ts`
  - test name: `"get_event returns linkedChat with empty messages when the chat sync has not landed"`
  - seams touched: mcp, store
  - edge cases: `chat_id` is set on the event but no `messages` row
    has that `thread_id`.

- AC5: `get_event` accepts an optional `account` to disambiguate the
  same `event_id` across tenants
  - test file: `src/mcp/tools/get-event.test.ts`
  - test name: `"get_event accepts account to disambiguate cross-tenant event ids"`
  - seams touched: mcp, store
  - edge cases: same `eventId` under two accounts; missing `account`
    when ambiguous → `InvalidParams` error; `account` provided but
    no event under that account → `null` event in the response (not
    a throw).

- AC6: `get_event` does **not** apply steering rules
  - test file: `src/mcp/tools/get-event.test.ts`
  - test name: `"get_event ignores steering rules on linked chat messages"`
  - seams touched: mcp, store
  - edge cases: a steering rule muting a sender on the linked chat is
    ignored; documented in the tool description.

- AC7: tool registered in `tools/list` with correct schema
  - test file: `src/mcp/mcp-server.test.ts`
  - test name: `"mcp server registers get_event with eventId required and account optional"`
  - seams touched: mcp
  - edge cases: tool missing from registry would fail this test.

## Open questions / assumptions

1. **Open:** Whether Graph's `onlineMeeting.chatInfo.threadId` is
   identical to the `chat.id` we already store in `messages.thread_id`
   for Teams chats. The slice-2 fixture says yes; the slice-4 live
   smoke is the first time we'll confirm this against a real online
   meeting. If the casing or prefix differs, this slice owns the
   normalisation (lower in the lowering function or a one-shot
   migration).
2. **Open:** `linkedChat.messages` default cap of 50 — pulled from
   `get_thread`'s convention. Confirm during FRAME the cap is
   acceptable and that we don't need a `limit` parameter on
   `get_event` yet.
3. **Assumption:** Steering carve-out matches `get_thread` and
   `list_accounts`. Documented in the brief §10 resolution and
   [.claude/skills/security-scan/SKILL.md](../../../.claude/skills/security-scan/SKILL.md)
   doesn't flag this. FRAME re-checks the brief.

## Risks

- **Wrong threadId join.** If the threadId Graph returns for an
  online meeting isn't actually what `messages.thread_id` carries,
  every `get_event` call produces an empty `linkedChat.messages` —
  silently wrong, not a thrown error. AC4 pins the empty-but-valid
  case but can't distinguish "correct id, sync hasn't run" from
  "wrong id, sync has run". Mitigation: slice-4 live smoke
  explicitly looks for one online meeting with at least one message
  on its chat; this slice's exit criteria require that smoke to
  return non-empty.
- **Recurrence series collisions.** If two occurrences of the same
  recurring meeting share a `chat_id` (Teams behaviour), a
  `get_event` call on either occurrence shows the union chat. That's
  arguably correct ("show me the chat for this meeting series") but
  surprising for a one-off occurrence query. Document in the tool
  description; do not fix here.

## Out-of-scope follow-ups

- Slice 6: `find_events`.
- Slice 7: unify into `get_recent_activity`.
- A "find chat → event" reverse lookup tool.
- Surfacing the meeting in the Teams-channel side: when a meeting
  happens **inside** a channel (channel-meeting), Graph stores it
  differently. Out of scope; we only handle calendar-driven meetings
  here.
