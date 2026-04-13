# Fix — Populate `raw_json` in sync writers

## Goal

Close the brief §4.10 gap: `messages.raw_json` exists in the schema and
the store roundtrips it, but neither `syncInbox` nor `syncTeams` ever
sets it, so every row in the lake has `raw_json = NULL`. Per the brief,
`raw_json` is the insurance policy — cheap to store, expensive to
regret.

## Where it stands

- Column added in Weekend 2 schema v1 ([src/store/schema.ts](../../src/store/schema.ts)).
- `SqliteMessageStore` + `InMemoryMessageStore` already read/write
  `rawJson` on `Message`.
- Gap introduced in:
  - [src/sync/sync-inbox.ts:27-51](../../src/sync/sync-inbox.ts#L27-L51) — `toMessage` never sets `rawJson` (Weekend 2).
  - [src/sync/sync-teams.ts](../../src/sync/sync-teams.ts) — same omission (Weekend 4 slice 5).
- MCP projections already strip `rawJson` from responses ([src/mcp/tools/get-recent-activity.ts](../../src/mcp/tools/get-recent-activity.ts), [src/mcp/tools/search.ts](../../src/mcp/tools/search.ts)), so no tool surface changes.

## Scope

**IN:**
- `syncInbox.toMessage` sets `rawJson = JSON.stringify(graphMessage)` on
  every non-removed upsert.
- `syncTeams` message mapper does the same with the raw `TeamsMessage`
  DTO.
- Stringification happens once per message before upsert (not lazily).
- Skipped for `@removed` tombstones (they aren't upserted).

**OUT:**
- Backfill of existing rows. Delta resync will naturally refresh over
  time; a migration script is overkill for a personal lake and would
  require re-fetching from Graph anyway. Note in PROGRESS.md and move
  on.
- Changing MCP projections. They already drop `rawJson`.
- Schema changes. Column and migration already exist.
- Any new tool to expose `raw_json`. Brief keeps it as insurance, not a
  surface.

## Files to touch

- [src/sync/sync-inbox.ts](../../src/sync/sync-inbox.ts)
- [src/sync/sync-inbox.test.ts](../../src/sync/sync-inbox.test.ts)
- [src/sync/sync-teams.ts](../../src/sync/sync-teams.ts)
- [src/sync/sync-teams.test.ts](../../src/sync/sync-teams.test.ts)
- [PROGRESS.md](../../PROGRESS.md) — one-line note under Weekend 4 closeout that raw_json retrofit landed and pre-existing rows stay NULL until delta resync.

## Seams

No new seams. The existing `GraphClient` / `TeamsClient` fakes already
return fully-shaped DTOs — the test just needs to assert that whatever
the fake returned comes back out of the store as `rawJson`.

## RED list

### `syncInbox`
1. Upserted message carries `rawJson` equal to
   `JSON.stringify(graphMessage)` of the exact DTO the fake returned
   (round-trip via `InMemoryMessageStore.getRecentMessages` or a
   dedicated store spy).
2. `@removed` entries are still routed to `deleteMessages` and do NOT
   produce a `rawJson` artifact (no behavior regression).
3. Messages without a `from` field (the existing edge case in
   `toMessage`) still get `rawJson` populated.

### `syncTeams`
4. Upserted Teams message carries `rawJson = JSON.stringify(teamsDto)`.
5. `@removed` Teams tombstones do not produce a `rawJson` row.
6. Existing mapping assertions (chatType, replyToId, mentions, etc.)
   remain green — proves the retrofit is additive, not a rewrite.

## Risks

- **DTO identity**: JSON.stringify is sensitive to key order. Tests
  should compare against `JSON.stringify(sameObject)` from the fake, not
  a hand-written literal, to avoid flakiness.
- **Payload size**: Teams/Outlook Graph responses can be tens of KB per
  message with inline HTML. Acceptable for a personal lake; brief
  explicitly calls this out as worth the storage cost.
- **Secrets in raw_json**: Graph message payloads don't contain tokens
  or credentials by construction. No redaction logic needed. Security
  scan in the TDD loop will confirm.

## Out of scope / non-goals

- No `get_raw_message(id)` MCP tool. Brief §6 forbids extending the tool
  surface without real frustration.
- No compression. Premature.
- No retention / pruning of `raw_json`. Brief §8 traps.

## DoD

All tests green, ≥90% line+branch on the two touched sync files,
`/security-scan` clean, PROGRESS.md updated, committed.

**Awaiting approval.**
