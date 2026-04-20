# Plan — `get_thread` MCP tool (Weekend 4.5 slice 1)

> **Status:** PLAN, awaiting user approval per CLAUDE.md TDD loop.

## Task

Add a `get_thread(thread_id, limit?)` MCP tool that returns every
message in a single conversation, ordered oldest→newest, projected the
same way `get_recent_activity` projects (no `body`/`rawJson` leak).

## Why now

Brief §6 lists four v1 tools. Three shipped in Weekend 3
(`get_recent_activity`, `get_sync_status`, `search`). `get_thread` was
silently missing from [PROGRESS.md](../../PROGRESS.md) until today. A
user hitting `search` today gets back `message.id` values but has no
way to ask the server *"give me the whole thread around this hit"* —
they'd have to widen `hours` and filter client-side, which defeats the
point. `get_thread` closes that loop.

## Scope boundary

**IN**

- New `MessageStore.getThread(threadId, limit?)` method on the
  contract ([src/store/message-store.ts](../../src/store/message-store.ts)),
  with SQLite + in-memory implementations. Contract tests in
  [src/store/message-store-contract.ts](../../src/store/message-store-contract.ts)
  so both impls stay honest.
- New handler `src/mcp/tools/get-thread.ts` + descriptor
  `GET_THREAD_TOOL`, wired into the SDK dispatcher in
  [src/mcp/mcp-server.ts](../../src/mcp/mcp-server.ts).
- Reuse the existing `project(...)` projection (same shape as
  `get_recent_activity`): `id`, `source`, `account`, `threadName`,
  `senderName`, `senderEmail`, `sentAt`, `snippet`, `chatType`,
  `replyToId`, `mentions`. **Never** `body` or `rawJson`.
- Input validation via `InvalidParamsError` (already wired to
  `McpError(InvalidParams)` by the SDK adapter).
- E2E scenario added to [src/mcp/e2e-http.test.ts](../../src/mcp/e2e-http.test.ts).
- User-guide + Claude Desktop wiring docs updated.

**OUT**

- Thread identification across sources. A Teams `chat_id` and an
  Outlook `thread_name` are unrelated spaces — the tool takes a single
  opaque `thread_id` string and the store decides how to resolve it
  (see "Open question" below).
- Threading reconstruction from `reply_to_id`. We rely on the storage
  grouping we already have (`thread_name` for Outlook, `chat_id` for
  Teams). `replyToId` stays in the projection for clients that want to
  build a tree, but the tool returns a flat list.
- Pagination beyond a `limit`. Thread sizes are bounded in practice
  (a 10k-message chat is exotic). `limit` defaults to 200, max 500.
- Search over thread contents. That's `search`.

## Open question

**How does the caller identify a thread?** Two candidates:

- **A. Single opaque id.** The tool takes `thread_id: string` and the
  store resolves it by trying both `chat_id` (Teams) and
  `thread_name` (Outlook). Simple for Claude (it can pass whatever
  string it got from a previous tool result) but ambiguous at the
  edges.
- **B. Composite.** The tool takes `{source, account, thread_id}` so
  the caller specifies which space the id lives in. Less ambiguous,
  more ceremony.

**Assumption (pending confirmation):** go with A and have the store
search `chat_id` first, then fall back to `thread_name`. Messages from
a single call MUST all come from the same account+source pair — if
an id happens to match across accounts, we return the first hit and
log a warning (the tool stays deterministic per call). Flag this to
the user at FRAME time so the decision is explicit.

## Files to create / touch

- **New** [src/mcp/tools/get-thread.ts](../../src/mcp/tools/get-thread.ts) —
  `GET_THREAD_TOOL` descriptor + `handleGetThread` handler. Reuses
  `InvalidParamsError` from `get-recent-activity.ts`.
- **New** [src/mcp/tools/get-thread.test.ts](../../src/mcp/tools/get-thread.test.ts) —
  handler-level unit tests.
- [src/store/message-store.ts](../../src/store/message-store.ts) —
  add `getThread(threadId, limit?)` to the `MessageStore` interface.
- [src/store/message-store-contract.ts](../../src/store/message-store-contract.ts) —
  contract tests that both impls must pass.
- [src/store/sqlite-message-store.ts](../../src/store/sqlite-message-store.ts) —
  SQL implementation. Prepared statement,
  `SELECT ... WHERE chat_id = ? OR (thread_name = ? AND account = ?)
  ORDER BY sent_at ASC LIMIT ?`.
- [src/testing/in-memory-message-store.ts](../../src/testing/in-memory-message-store.ts) —
  in-memory equivalent.
- [src/mcp/mcp-server.ts](../../src/mcp/mcp-server.ts) — register
  `GET_THREAD_TOOL` + `handleGetThread` in `TOOL_DESCRIPTORS` /
  `TOOL_HANDLERS`.
- [src/mcp/mcp-server.test.ts](../../src/mcp/mcp-server.test.ts) —
  assert the new tool is in `tools/list` and that `tools/call` wraps
  its result in a content block.
- [src/mcp/e2e-http.test.ts](../../src/mcp/e2e-http.test.ts) — one new
  scenario that upserts a multi-message Outlook thread + a Teams chat
  and calls `get_thread` against each over real HTTP.
- [docs/user-guide.md](../user-guide.md) — advertise the tool.
- [docs/claude-desktop-wiring.md](../claude-desktop-wiring.md) — add
  to the tool list.
- [docs/changelog.md](../changelog.md), [PROGRESS.md](../../PROGRESS.md).

## Seams involved

store, clock (for the handler's `now()` in projection), mcp.

## RED test list

1. **Store contract — returns empty array for unknown id.**
   `store.getThread("nope")` resolves to `[]` on both impls.
2. **Store contract — returns Outlook thread by `thread_name` ordered
   oldest→newest.** Seeded three messages in the same thread + one
   outside; result has the three in `sent_at ASC` order.
3. **Store contract — returns Teams chat by `chat_id`.** Seeded via
   the `chat_id` column (already written by the Teams sync path in
   slice 2 of the endpoint rework).
4. **Store contract — respects `limit`.** Seeded 250 messages in one
   thread, `getThread(id, 50)` returns the 50 oldest.
5. **Store contract — default limit is 200 when unspecified.**
6. **Handler — `thread_id` required.** `handleGetThread(store, clock,
   {} as any)` rejects with `InvalidParamsError`.
7. **Handler — projects same shape as `get_recent_activity`.** No
   `body`, no `rawJson` in the result.
8. **Handler — snippet falls back to `bodyHtml` when `body` missing**
   (matches Teams behavior already in `get_recent_activity`).
9. **MCP server — `tools/list` now includes `get_thread`** with an
   `inputSchema` requiring `thread_id`.
10. **MCP server — `tools/call get_thread` wraps result in a text
    content block**, driven by SDK `InMemoryTransport` client.
11. **MCP server — invalid params maps to
    `McpError(InvalidParams)`.**
12. **E2E HTTP — Outlook thread end-to-end.** `:memory:`
    `SqliteMessageStore` + real `fetch` + `StreamableHTTPClientTransport`.
13. **E2E HTTP — Teams chat end-to-end.**

## Risks

- **Open question A vs B unresolved.** Flagging at FRAME time is
  mandatory; if the user prefers B, the entire input schema changes
  and some RED tests are rewritten. Don't write RED #6/#9/#12 until
  this is confirmed.
- **Thread size blowup.** A 69k-char `get_recent_activity` response
  already landed in Claude Desktop yesterday. `limit` + projection
  drop `body` but `snippet` can still balloon if we pick the wrong
  cap. Keep snippet capped via the existing `SNIPPET_MAX = 280`.
- **SQLite index coverage.** `(thread_name, account)` and `(chat_id)`
  may not have indexes. Check [src/store/schema.ts](../../src/store/schema.ts);
  add if missing (additive schema bump, not a migration).
- **Cross-account id collision.** Two accounts with a thread named
  "Re: Lunch" would collide under option A. Mitigation: tie-break by
  account in the query (see assumption above).

## Out-of-scope follow-ups

- Thread-tree reconstruction from `reply_to_id` (client can do it).
- Cross-source thread stitching (an email thread that became a Teams
  chat — not a real use case yet).
- Pagination cursors beyond `limit`.
- A `get_thread_by_message_id` variant that looks up the thread from
  a single message id. Probably wanted later; defer until a real
  `search` → `get_thread` workflow asks for it.
