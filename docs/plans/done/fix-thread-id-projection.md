# Fix — expose `threadId` in MCP tool projections

## Task
Add `threadId` to the projected wire shape of `search`, `get_recent_activity`, and `get_thread` so Claude can extract a valid thread id from any hit and feed it back into `get_thread`.

## Scope boundary
**In:**
- `ProjectedSearchMessage` (search.ts) carries optional `threadId`.
- `ProjectedMessage` (get-recent-activity.ts) carries optional `threadId`.
- `ProjectedThreadMessage` (get-thread.ts) carries optional `threadId` (for symmetry — a thread result should echo its own id).
- Tests assert the field round-trips from `Message.threadId` through each handler.
- e2e-http test asserts a search hit for a known Teams message exposes `threadId`.

**Out (deferred):**
- Indexing Teams attachment / adaptive-card text into FTS (separate slice — the "CSP Portal returns almost nothing" complaint).
- Any schema or sync-writer change. `threadId` is already persisted for Teams (schema v3) and Outlook (slice 3, schema unchanged — stored via existing `thread_id` column).
- Renaming `thread_id` ↔ `threadId` on the input schema of `get_thread` (param stays `thread_id`).
- A dedicated `get_message` / `include_body` surface (Slice C territory).

## Files to create / touch
- [src/mcp/tools/search.ts](../../src/mcp/tools/search.ts) — add `threadId` to `ProjectedSearchMessage` + `project()`.
- [src/mcp/tools/get-recent-activity.ts](../../src/mcp/tools/get-recent-activity.ts) — add `threadId` to `ProjectedMessage` + `project()`.
- [src/mcp/tools/get-thread.ts](../../src/mcp/tools/get-thread.ts) — add `threadId` to `ProjectedThreadMessage` + `project()`.
- [src/mcp/tools/search.test.ts](../../src/mcp/tools/search.test.ts) — new AC test.
- [src/mcp/tools/get-recent-activity.test.ts](../../src/mcp/tools/get-recent-activity.test.ts) — new AC test.
- [src/mcp/tools/get-thread.test.ts](../../src/mcp/tools/get-thread.test.ts) — new AC test.
- [src/mcp/e2e-http.test.ts](../../src/mcp/e2e-http.test.ts) — extend the search assertion to check `threadId` surfaces on the wire.
- [docs/changelog.md](../../docs/changelog.md), [docs/user-guide.md](../../docs/user-guide.md) — mention the new field.

## Seams involved
None. Pure projection change inside the MCP handler layer. Uses existing `InMemoryMessageStore` fake in unit tests and real `SqliteMessageStore` in the e2e test.

## RED test list
- **AC1**: `search` projection includes `threadId` when the underlying `Message.threadId` is set.
  - test file: `src/mcp/tools/search.test.ts`
  - test name: `"projects threadId when the message has one"`
  - seams touched: store (InMemoryMessageStore)
  - edge cases: absent `threadId` → field omitted (not `undefined` on the wire).
- **AC2**: `get_recent_activity` projection includes `threadId` when set.
  - test file: `src/mcp/tools/get-recent-activity.test.ts`
  - test name: `"projects threadId when the message has one"`
  - seams touched: store, clock
  - edge cases: mix of Teams (threadId set) + Outlook (threadId set via conversationId) + one message with no threadId.
- **AC3**: `get_thread` projection echoes `threadId` on every returned message.
  - test file: `src/mcp/tools/get-thread.test.ts`
  - test name: `"projects threadId on every returned message"`
  - seams touched: store
  - edge cases: all messages share the same threadId (that's the definition of a thread), so just assert it's present.
- **AC4**: e2e-http — a `search` JSON-RPC call against a real SQLite store surfaces `threadId` on the wire.
  - test file: `src/mcp/e2e-http.test.ts`
  - test name: `"search hits expose threadId so get_thread can be called"` (or extend the existing search assertion)
  - seams touched: http, store (real sqlite `:memory:`)
  - edge cases: none — this is the round-trip guard.

## Open questions / assumptions
- **Assumption:** the param name on `get_thread` input stays `thread_id` (snake_case) to match existing behavior and avoid a breaking schema change. Only the *output* projections gain a `threadId` (camelCase, matching the rest of the projection). Flag: if you'd rather align on one casing, say so before I start.
- **Assumption:** no migration needed. For Teams, `threadId` = Teams `chat.id` and has been populated since Weekend 4 slice 2. For Outlook, it's populated as of Weekend 4.5 slice 3 (conversationId). Pre-slice-3 Outlook rows have `threadId = NULL` — fine, field is optional and omitted.

## Risks
- **Wire-shape change**: existing Claude Desktop conversations that cached tool schemas won't break (adding an optional field is additive). No rollback needed beyond reverting the commit.
- **Coverage regression**: the three new projection branches must be hit. Covered by ACs 1–3 directly.

## Out-of-scope follow-ups
- Teams attachment / adaptive-card FTS indexing (separate `/tdd-cycle`).
- Consider: should `get_thread` accept `threadId` (camelCase) as an alias for `thread_id` so the JSON round-trips cleanly? Cosmetic — defer until someone complains.
- Consider: richer `get_thread` input validation error when the id doesn't match any row (currently returns `{count:0, messages:[]}` — silent).
