# Weekend 4 — Slice 2: Teams message shape + schema v3

## Goal

Prepare the store for Teams ingestion by adding Teams-specific fields
to `Message` and a v3 SQLite migration that adds matching columns,
preserving all v1/v2 data and remaining idempotent.

## Why now

Everything downstream in Weekend 4 (`TeamsClient`, `syncTeams`, MCP
coverage) writes Teams messages through `MessageStore`. Until the
store can hold the extra fields, those slices can't exist.

## Scope

**IN:**
- `Message` gains three optional fields: `chatType` (`"oneOnOne" |
  "group" | "channel"`), `replyToId` (string), `mentions`
  (`readonly string[]`).
- Schema migration 3 adds nullable columns `chat_type`, `reply_to_id`,
  `mentions_json` to `messages`. FTS5 triggers NOT touched (body +
  thread_name + sender_name remain the search surface for v1).
- `SqliteMessageStore.toRow`/`fromRow` + upsert SQL handle the new
  columns (serialize mentions as JSON).
- `InMemoryMessageStore` preserves the new fields on upsert/read.
- Contract tests: roundtrip a Teams-shaped message through upsert →
  getRecentMessages.
- Schema tests: v2→v3 upgrade path, idempotency, new columns exist.

**OUT:**
- `TeamsClient` / `HttpTeamsClient` / sync integration — slices 3-5.
- Any new MCP tool surface — slice 6.
- FTS5 coverage of mentions — defer until real frustration.

## Files

- `src/store/types.ts`
- `src/store/schema.ts`
- `src/store/schema.test.ts`
- `src/store/sqlite-message-store.ts`
- `src/store/message-store-contract.ts` (new roundtrip assertions)
- `src/testing/in-memory-message-store.ts`

## RED list

1. `CURRENT_SCHEMA_VERSION === 3`; fresh db ends up at v3.
2. v2→v3 migration adds `chat_type`, `reply_to_id`, `mentions_json`
   columns and preserves existing rows.
3. v2→v3 migration is idempotent.
4. Contract: upsert a Teams message with `chatType="channel"`,
   `replyToId="root-msg"`, `mentions=["alice","bob"]` and read it back
   via `getRecentMessages`; all three fields round-trip on both
   `InMemoryMessageStore` and `SqliteMessageStore`.
5. Contract: omitting the new fields leaves them `undefined` on read.
6. FTS5 search on body/thread/sender still works post-v3 (regression).

## Risks

- FTS5 rebuild on column add — mitigated because we're not touching
  the indexed columns or external-content mapping.
- Mentions JSON parse errors corrupting a whole read — keep parse
  narrow, treat malformed as `undefined` on read.

## DoD

- All tests green, ≥90% line+branch on touched files.
- Security scan clean.
- Changelog + PROGRESS updated.
- Committed + pushed.

**Auto-approved.**
