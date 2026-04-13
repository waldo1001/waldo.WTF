# Weekend 3 — Slice 3: `search` MCP tool (FTS5)

## Goal

Expose a read-only MCP tool that lets Claude full-text-search the lake
via the existing FTS5 index. Third and final MCP tool for Weekend 3,
alongside `get_recent_activity` and `get_sync_status`.

## Where this stands

- Weekend 2 slice 9 already built `messages_fts` + `searchMessages(query, limit)`
  on `MessageStore` (BM25-ranked, `snippet()` in sqlite, substring in
  the in-memory fake). FTS5 input is escaped to a quoted phrase via
  `toFts5Phrase`.
- Two MCP tools are already wired through hand-rolled JSON-RPC. Tool
  dispatch is a `{name → handler}` map in
  [src/mcp/http-server.ts](../../src/mcp/http-server.ts).
- This slice is a thin wrapper: validate params, call the store, project
  the hits. No new store method.

## Scope

**In**
- `handleSearch(store, clock, {query, limit?})` returning
  `{count, hits: [{message: ProjectedMessage, snippet, rank}]}`.
- Tool descriptor `SEARCH_TOOL` with JSON-schema.
- Register in `TOOL_HANDLERS` / `TOOL_DESCRIPTORS`.
- Clock is injected but unused (keeps signature consistent with other tools).

**Out**
- No new store method, no schema change, no pagination cursors.
- No filtering by source/account (can be added later if needed).
- No highlighting customization — snippet comes from FTS5.

## Files to touch

- **new** `src/mcp/tools/search.ts`
- **new** `src/mcp/tools/search.test.ts`
- **edit** `src/mcp/http-server.ts` (register)

## Seams

`MessageStore.searchMessages` (already mockable via `InMemoryMessageStore`),
`Clock` (unused but injected).

## RED test list

1. rejects empty/whitespace query with `InvalidParamsError`
2. rejects non-string query
3. rejects `limit` ≤ 0, non-finite, or > 100
4. defaults limit to 20 when omitted
5. passes query + limit through to `store.searchMessages`
6. projects message fields (no `rawJson`/`bodyHtml`/`body`) and preserves
   `snippet` + `rank`
7. returns `count === hits.length`
8. exposes a valid tool descriptor

## Risks

Tiny. Only risk is schema drift from `get_recent_activity`'s
`ProjectedMessage` — import rather than duplicate.

## Out of scope

End-to-end HTTP test and Claude Desktop wiring are separate slices (4, 5).
