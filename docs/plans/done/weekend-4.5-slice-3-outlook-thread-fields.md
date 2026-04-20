# Weekend 4.5 Slice 3 — Outlook thread fields

## Task

Capture `conversationId` and `subject` from Graph inbox messages and
persist them as `Message.threadId` / `Message.threadName`, so the
existing `get_thread` MCP tool returns Outlook conversations (not just
Teams chats).

## Scope boundary

**IN**

- Add `conversationId?: string` to the `GraphMessage` DTO. (`subject`
  is already there.)
- In [src/sync/sync-inbox.ts](../../src/sync/sync-inbox.ts) `toMessage`,
  populate `threadId` from `g.conversationId` and `threadName` from
  `g.subject` when present.
- Update existing sync-inbox tests / fixtures as needed and add
  targeted RED tests for the new mapping.

**OUT** (deferred)

- Any change to `HttpGraphClient` (no `$select` is used today; Graph
  returns `conversationId` + `subject` by default).
- A migration / backfill of pre-existing rows. Naturally rewritten on
  next delta touch; otherwise `threadId` stays `NULL` for old rows.
- Changes to the `get_thread` handler itself — it already queries by
  `threadId` and is source-agnostic.
- Outlook threading via `inReplyTo` / `internetMessageId` (different
  feature; conversationId is the Microsoft-blessed thread key).
- Schema change. `messages.thread_id` / `thread_name` columns already
  exist (Weekend 4 slice 2) and `SqliteMessageStore` already
  roundtrips them.

## Files to create / touch

- [src/sources/graph.ts](../../src/sources/graph.ts) — add
  `conversationId?: string` to `GraphMessage`.
- [src/sync/sync-inbox.ts](../../src/sync/sync-inbox.ts) — map
  `conversationId` → `threadId`, `subject` → `threadName` in
  `toMessage`.
- [src/sync/sync-inbox.test.ts](../../src/sync/sync-inbox.test.ts) — new
  tests (see RED list); existing fixtures may pick up `conversationId`
  for free via the `makeGraphMessage` helper.
- [PROGRESS.md](../../PROGRESS.md) — tick the Weekend 4.5 follow-up box.
- [docs/changelog.md](../../docs/changelog.md) — slice entry (via
  `/docs-update`).

## Seams involved

- **graph** (DTO field added)
- **store** (only via existing `Message` fields; no contract change)

## RED test list

- AC1: `syncInbox` populates `threadId` from `conversationId` and
  `threadName` from `subject` on upserted messages.
  - test file: `src/sync/sync-inbox.test.ts`
  - test name: `"populates threadId/threadName from conversationId+subject"`
  - seams touched: graph, store
  - edge cases: standard happy path with both fields present

- AC2: When `conversationId` is missing on the Graph DTO, `threadId`
  is omitted from the upserted `Message` (no empty string, no
  literal `"undefined"`).
  - test file: `src/sync/sync-inbox.test.ts`
  - test name: `"omits threadId when conversationId is missing"`
  - seams touched: graph, store
  - edge cases: defensive — older mocks / odd Graph responses

- AC3: When `subject` is `null`, `threadName` is omitted (mirrors how
  `body` already handles missing fields).
  - test file: `src/sync/sync-inbox.test.ts`
  - test name: `"omits threadName when subject is null"`
  - seams touched: graph, store
  - edge cases: Graph returns `subject: null` for some message classes

- AC4 (integration via existing path): `get_thread` returns the
  Outlook messages that share a `conversationId`, ordered by
  `sentAt`. Validated through `InMemoryMessageStore.getThread` in a
  sync-inbox test (no new tool test needed — `get_thread` handler
  logic is unchanged and already covered).
  - test file: `src/sync/sync-inbox.test.ts`
  - test name: `"two synced messages with same conversationId are retrievable as a thread"`
  - seams touched: store
  - edge cases: two messages, same thread, different `sentAt`

## Open questions / assumptions

- **Assumption**: Graph's default `/messages/delta` projection
  includes `conversationId` and `subject`. (Confirmed by spec — both
  are default `message` resource fields and `HttpGraphClient` does
  not pass `$select`, so the live wire response will carry them.)
- **Assumption**: We do not need a backfill pass. Old rows with
  `thread_id IS NULL` will be naturally overwritten on the next
  delta update touching that message; users who care can clear
  `delta-state.json` for a full resync. Flagging here so you can
  override if you'd rather force it.
- **Assumption**: We keep `threadId` raw (Graph's opaque
  conversationId) — no `outlook:` namespace prefix. Teams uses raw
  chat IDs the same way, so this is consistent. Confirm if you'd
  prefer namespaced thread IDs.

## Risks

- Test fixtures that destructure `GraphMessage` strictly may break if
  they don't include `conversationId`. Mitigation: the field is
  optional, and `makeGraphMessage` uses spread defaults.
- A message whose `conversationId` collides with a Teams `chatId`
  could in theory blend threads. In practice Graph conversation IDs
  and Teams chat IDs share no namespace and `get_thread` is read-only,
  so the worst case is a single tool returning more rows than
  expected. Acceptable for v1.

## Out-of-scope follow-ups

- Live smoke through Claude Desktop: *"show me the full thread about
  X"* on a real Outlook conversation.
- Decide whether to namespace `threadId` (`outlook:<convId>` /
  `teams:<chatId>`) once we have a second source of collisions.
- Backfill old rows by clearing the Outlook delta token on next
  release (operator note, not code).
