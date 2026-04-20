# Plan: Improve waldo-wtf MCP tool descriptions

## Task
Enrich 4 MCP tool descriptions with multilingual search guidance and multi-source caveats, and add server-level `instructions` to the MCP server.

## Scope boundary
**IN:** description string changes on `search`, `get_sync_status`, `get_recent_activity`, `get_thread`; server-level `instructions` on `createMcpServer`; tests asserting new text is present.
**OUT:** schema changes, behavioral changes, new tools, `list_accounts` description.

## Files to create / touch
- `src/mcp/tools/search.ts` — expand `SEARCH_TOOL.description`
- `src/mcp/tools/get-sync-status.ts` — expand `GET_SYNC_STATUS_TOOL.description`
- `src/mcp/tools/get-recent-activity.ts` — expand `GET_RECENT_ACTIVITY_TOOL.description`
- `src/mcp/tools/get-thread.ts` — expand `GET_THREAD_TOOL.description`
- `src/mcp/mcp-server.ts` — add `instructions` to `ServerOptions`
- `src/mcp/tools/search.test.ts` — add description assertion
- `src/mcp/tools/get-sync-status.test.ts` — add description assertion
- `src/mcp/tools/get-recent-activity.test.ts` — add description assertion
- `src/mcp/tools/get-thread.test.ts` — add description assertion
- `src/mcp/mcp-server.test.ts` — add server instructions assertion

## Seams involved
none — pure string/config changes

## RED test list
- AC1: search description mentions multilingual guidance
  - test file: src/mcp/tools/search.test.ts
  - test name: "description includes multilingual search guidance"
  - seams: none
  - edge cases: none
- AC2: get_sync_status description warns it is not an inventory
  - test file: src/mcp/tools/get-sync-status.test.ts
  - test name: "description warns it is not an authoritative source inventory"
  - seams: none
  - edge cases: none
- AC3: get_recent_activity description identifies it as source-of-truth probe
  - test file: src/mcp/tools/get-recent-activity.test.ts
  - test name: "description identifies it as source-of-truth probe"
  - seams: none
  - edge cases: none
- AC4: get_thread description recommends it over search for known persons
  - test file: src/mcp/tools/get-thread.test.ts
  - test name: "description recommends get_thread over search for known persons"
  - seams: none
  - edge cases: none
- AC5: server exposes instructions in ListTools or initialize
  - test file: src/mcp/mcp-server.test.ts
  - test name: "server provides multilingual search instructions"
  - seams: none
  - edge cases: none

## Open questions / assumptions
- Assumption: template literals with `\n` for multiline descriptions work fine with the MCP SDK — the SDK just passes the string through.
- Assumption: server `instructions` field is surfaced to clients via the `initialize` response (confirmed from SDK types).

## Risks
- Very long descriptions might be truncated by some MCP clients — mitigated by keeping each addition to 2-3 short paragraphs.

## Out-of-scope follow-ups
- `list_accounts` description enhancement
- Adding query-language parameter to search tool schema
- Client-side retry logic for multilingual search
