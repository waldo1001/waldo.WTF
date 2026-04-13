# Weekend 3 — Slice 4: End-to-end HTTP integration test

## Goal

Drive the whole MCP HTTP stack with a **real** SQLite store (`:memory:`,
full schema + FTS5) and **real** `fetch`, exercising the exact JSON-RPC
path Claude Desktop will use. This is the "summarize my mail from the
last 24 hours" end-to-end check from the project brief §7 Weekend 3.

Existing `http-server.test.ts` uses `InMemoryMessageStore` — good for
dispatch/auth, but it doesn't prove the sqlite schema, FTS5 triggers, or
the wiring between the real store and the HTTP tool handlers.

## Scope

**In**
- New `src/mcp/e2e-http.test.ts` that:
  - Opens a `:memory:` `SqliteMessageStore`.
  - Seeds messages spanning inside / outside a 24h window + some FTS5
    body content.
  - Boots `createMcpHttpServer` on an ephemeral port.
  - Uses real `fetch` with Bearer to call `tools/list`, then:
    - `get_recent_activity` (hours: 24) → asserts count, projected fields
    - `search` (query matching seeded body) → asserts snippet + rank
    - `get_sync_status` → asserts generatedAt/rows shape
  - Closes server + db.

**Out**
- No live Graph or MSAL. No real file system. No pushing anything.
- No schema changes.
- Not a benchmark.

## Risks

- `better-sqlite3` native bindings in CI (already exercised by slice 7/9
  tests, so low risk).
- FTS5 not compiled in — existing `SqliteMessageStore` tests already
  cover this, so we rely on those.

## RED test list

1. `tools/list` returns all three tools
2. `get_recent_activity` via HTTP returns correctly projected rows from
   SQLite, filters by 24h window
3. `search` via HTTP returns FTS5 hits with snippet+rank for seeded body
4. `get_sync_status` via HTTP returns `accountsTracked`/`staleCount`
   consistent with seeded `sync_log`
5. Unauthorized request is rejected (defense-in-depth at the e2e layer)
