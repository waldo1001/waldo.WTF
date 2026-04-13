# Weekend 3 — Slice 1: `get_recent_activity` MCP tool

## Goal

Expose the first MCP tool on the existing HTTP server skeleton:
`get_recent_activity(hours, sources?, accounts?)` — returns messages with
`sentAt >= now - hours`, optionally filtered by source and/or account,
newest first, capped at a sane limit.

## Where this sits

Weekend 2 finished: sync loop writes to SQLite, HTTP server skeleton exists
with bearer auth but no tools. This slice lights up the first real
read-path tool so Claude Desktop can eventually ask "what happened in the
last 24 hours?". No MCP SDK yet — we wire the JSON-RPC handler by hand on
top of `createMcpHttpServer`, because (a) it keeps the seam thin, (b) we
already have a working HTTP + auth layer, and (c) one tool doesn't justify
pulling in the SDK. The SDK can land in a later slice once we have 2–3
tools and want protocol conformance.

**Decision to surface**: hand-rolled JSON-RPC vs. `@modelcontextprotocol/sdk`
now. Recommend hand-rolled for this slice; revisit before slice 3.

## Scope

**In:**

1. New `MessageStore` method: `getRecentMessages(opts)` where
   `opts = { since: Date; sources?: readonly MessageSource[]; accounts?: readonly string[]; limit: number }`.
   Returns `readonly Message[]` ordered by `sentAt DESC, id DESC` (id tiebreak
   keeps order stable across equal timestamps).
   - Implement on both `InMemoryMessageStore` and `SqliteMessageStore`.
   - SQLite: parameterized `WHERE sent_at >= ? [AND source IN (...)] [AND account IN (...)] ORDER BY sent_at DESC, id DESC LIMIT ?`.
2. New tool registry module `src/mcp/tools/get-recent-activity.ts` exporting
   a pure function `handleGetRecentActivity(store, clock, params)` that:
   - Validates `hours` (positive number, ≤ 720 = 30 days).
   - Validates optional `sources` (subset of `MessageSource`).
   - Validates optional `accounts` (non-empty strings).
   - Computes `since = clock.now() - hours*3600*1000`.
   - Calls `store.getRecentMessages({ since, sources, accounts, limit: 200 })`.
   - Returns `{ count, messages: [...] }` where each message is projected
     to `{ id, source, account, threadName, senderName, senderEmail, sentAt, snippet }`
     (no `rawJson`, no `bodyHtml` — keeps payload small; snippet = first 280
     chars of `body` if present).
3. Wire a minimal JSON-RPC POST handler into `createMcpHttpServer`:
   - `POST /` with auth → parse JSON body, dispatch method `tools/call`
     with `name: "get_recent_activity"` → invoke handler → reply per
     JSON-RPC 2.0 (`{jsonrpc, id, result}` or `{jsonrpc, id, error}`).
   - `tools/list` also answered statically (name + input schema).
   - Anything else → JSON-RPC `-32601 method not found`.
   - Invalid JSON body → `-32700 parse error`.
   - Validation failures in the tool → `-32602 invalid params`.
   - Inject `store` and `clock` via new `McpHttpServerOptions` fields so
     tests can pass fakes.

**Out (later slices):**

- `get_sync_status()` tool (slice 2).
- `search` tool (slice 4, on top of existing `searchMessages`).
- `@modelcontextprotocol/sdk` adoption (slice 3).
- Claude Desktop wiring + live smoke (slice 5).
- Pagination beyond `limit: 200` — 30-day window × 200 is plenty for v1.

## Files to touch

- `src/store/message-store.ts` — add `getRecentMessages` to interface.
- `src/store/message-store-contract.ts` — contract tests for new method.
- `src/store/sqlite-message-store.ts` — implement.
- `src/testing/` (in-memory store lives in `message-store.ts`? verify) —
  implement in the in-memory fake.
- `src/mcp/tools/get-recent-activity.ts` — new.
- `src/mcp/tools/get-recent-activity.test.ts` — new.
- `src/mcp/http-server.ts` — add JSON-RPC dispatch + new options fields.
- `src/mcp/http-server.test.ts` — new RPC tests.
- `src/index.ts` — pass `store` + `clock` through to `createMcpHttpServer`.
- `PROGRESS.md`, `docs/changelog.md` — update after GREEN.

## Seams

- **Store**: already injectable; extending its interface.
- **Clock**: already injected into sync; reuse `Clock` seam for "now".
- **HTTP**: `createMcpHttpServer` already takes an options bag; add two fields.

No new seams, no new external deps.

## RED test list

Store contract (`message-store-contract.ts`, runs against both impls):

1. `getRecentMessages returns empty when store is empty`
2. `getRecentMessages returns only messages with sentAt >= since`
3. `getRecentMessages orders newest first with id tiebreak on equal sentAt`
4. `getRecentMessages filters by sources when provided`
5. `getRecentMessages filters by accounts when provided`
6. `getRecentMessages applies sources AND accounts filters together`
7. `getRecentMessages honours limit`

Tool handler (`get-recent-activity.test.ts`, pure, no HTTP):

8. `rejects hours <= 0 with invalid-params error`
9. `rejects hours > 720 with invalid-params error`
10. `rejects unknown source values`
11. `rejects empty-string account values`
12. `computes since from injected clock (now - hours)`
13. `projects messages without rawJson/bodyHtml and truncates snippet to 280`
14. `returns count matching messages.length`

HTTP server (`http-server.test.ts`, extends existing):

15. `POST / without auth → 401`
16. `POST / with invalid JSON → JSON-RPC -32700`
17. `POST / with unknown method → JSON-RPC -32601`
18. `POST / tools/list → returns get_recent_activity schema`
19. `POST / tools/call get_recent_activity happy path → result with count+messages`
20. `POST / tools/call with invalid params → JSON-RPC -32602`

## Risks / gotchas

- **SQL column naming**: confirm `sent_at` vs `sentAt` in the schema before
  writing the `WHERE` — existing `searchMessages` is the template.
- **Date round-trip**: SQLite stores ms epoch; contract test must construct
  messages at known ms boundaries to avoid off-by-one on the `>=` edge.
- **In-memory fake location**: verify whether the fake lives in
  `src/store/message-store.ts` or `src/testing/`; update the right file.
- **JSON-RPC id**: must be echoed exactly (number or string or null);
  don't coerce.
- **Body size**: `req.on('data')` accumulation needs a cap (say 1 MB) so a
  hostile client can't exhaust memory. Not a feature — a guardrail.
- **Snippet truncation**: do it in the handler, not the store — keeps the
  store returning full `Message` objects for other callers.

## Out of scope (explicit)

- MCP SDK adoption.
- `get_sync_status`, `search`, or any other tool.
- Teams/WhatsApp sources (still just Outlook).
- Pagination / cursors.
- Rate limiting.
- Any write-path tool. waldo.WTF is read-only forever.

## Definition of done

- All 20 tests above green.
- ≥90% line + branch coverage on every touched file.
- `/security-scan` clean (no tokens, no real account emails, bearer still redacted in errors).
- `/docs-update` applied: changelog entry + PROGRESS.md tick for
  "Weekend 3 → `get_recent_activity(hours, sources?, accounts?)`".
- Plan file updated with a **Notes** section if any decision drifted
  during implementation.
