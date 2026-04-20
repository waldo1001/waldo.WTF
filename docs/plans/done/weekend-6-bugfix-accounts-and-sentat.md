# Plan: Fix list_accounts empty + sent_at NOT NULL crash

## Task
Fix two independent bugs: (1) sync scheduler never calls `upsertAccount()` so `list_accounts` MCP tool returns empty, (2) Graph messages with null `receivedDateTime` crash the sync with `NOT NULL constraint failed: messages.sent_at`.

## Scope boundary
**IN:** Add `upsertAccount()` call in sync scheduler; make `receivedDateTime` optional in `GraphMessage` and add fallback in `toMessage`; regression tests for both.
**OUT:** Changing the `accounts` table schema, enriching `AccountRecord` with `displayName` from Graph, retry logic for failed syncs.

## Files to create / touch
- `src/sync/sync-scheduler.ts` — call `store.upsertAccount()` for each account
- `src/sync/sync-scheduler.test.ts` — regression test: accounts are upserted
- `src/sources/graph.ts` — make `receivedDateTime` optional (`string | undefined`)
- `src/sync/sync-inbox.ts` — fallback `sentAt` to `importedAt` when `receivedDateTime` is missing
- `src/sync/sync-inbox.test.ts` — regression test: message with null receivedDateTime

## Seams involved
store, graph, clock

## RED test list
- AC1: sync scheduler upserts each account on every tick
  - test file: src/sync/sync-scheduler.test.ts
  - test name: "upserts each account into the store on every tick"
  - seams: store, auth
  - edge cases: multiple accounts, second tick updates existing
- AC2: syncInbox maps a message with missing receivedDateTime using importedAt as fallback
  - test file: src/sync/sync-inbox.test.ts
  - test name: "on a message with missing receivedDateTime, falls back to importedAt for sentAt"
  - seams: graph, store, clock
  - edge cases: undefined vs null

## Open questions / assumptions
- Assumption: `addedAt` for upsertAccount should be `clock.now()` since the auth provider's `Account` type doesn't carry a creation timestamp.
- Assumption: messages with missing `receivedDateTime` should still be imported (with fallback time), not skipped.

## Risks
- If `receivedDateTime` is missing on a `@removed` entry, no impact — removed entries don't go through `toMessage`.

## Out-of-scope follow-ups
- Populate `displayName` on AccountRecord (Graph /me or /organization could provide this)
- Alert/log when `receivedDateTime` is missing (observability)
