# Weekend 3 — Slice 2: `get_sync_status()` MCP tool

## Goal

Expose a read-only MCP tool that tells Claude (and the operator) whether
the sync loop is healthy: per `(account, source)`, when did it last run,
did it succeed, how many messages did it add, and — if it failed — what
was the error. This is the second MCP tool, pairing with
`get_recent_activity`, and it's the primary "is my lake up to date?"
signal before Weekend 3's Claude Desktop wiring.

## Where this stands in the project

- Weekend 2 is complete: sync loop writes `sync_log` rows per account
  per tick (ok / error + `messagesAdded` or `errorMessage`), `accounts`
  table is populated on login, HTTP MCP skeleton + bearer auth are
  live, `get_recent_activity` is shipped.
- Weekend 3 needs two tools before Claude Desktop wiring:
  `get_recent_activity` ✅ and `get_sync_status` (this slice).
- Only after both tools land do we wire Claude Desktop and do the
  end-to-end "summarize last 24h" test.

## Scope boundary

**In scope**
- New `get_sync_status` tool: no params, returns a per-account-source
  health snapshot plus a top-level summary.
- New `MessageStore.getSyncStatus()` read method (contract + sqlite +
  in-memory impls) that aggregates `accounts` × `sync_state` ×
  `sync_log` in one call.
- Wire into JSON-RPC dispatch in [src/mcp/http-server.ts](../../src/mcp/http-server.ts)
  next to `get_recent_activity`.
- Inject `Clock` so "stale" threshold is deterministic in tests.

**Out of scope**
- No new schema, no migration. All data already present.
- No writes. No mutation of `sync_log`/`sync_state`.
- No pagination, no filtering params — single snapshot, small payload.
- No MCP SDK migration (still hand-rolled JSON-RPC, per PROGRESS.md).
- No Claude Desktop wiring (next slice).
- Not touching `get_recent_activity`.

## Files to touch

- `src/store/message-store.ts` — add `getSyncStatus()` to interface + new
  `SyncStatusRow` / `SyncStatusSnapshot` types (or colocate types in
  `src/store/types.ts` — decide during FRAME).
- `src/store/message-store-contract.ts` — contract tests for new method
  (shared across in-memory + sqlite).
- `src/store/in-memory-message-store.ts` — implement `getSyncStatus()`.
- `src/store/sqlite-message-store.ts` — implement `getSyncStatus()` with
  prepared statements; single transaction, read-only.
- `src/mcp/tools/get-sync-status.ts` — new tool handler + `TOOL` descriptor
  (schema, name, description).
- `src/mcp/tools/get-sync-status.test.ts` — handler unit tests with the
  in-memory store + `FakeClock`.
- `src/mcp/http-server.ts` — register tool in `tools/list` and dispatch
  in `tools/call`.
- `src/mcp/http-server.test.ts` — JSON-RPC integration test: auth, happy
  path, empty store.

## Seams

- `MessageStore` (already injected into handlers) — new read method
  keeps the tool handler thin.
- `Clock` (already injected for `get_recent_activity`) — reused to
  compute "seconds since last sync" and the `stale` flag, so tests are
  time-independent.
- No new seams; no direct `Date.now()`, no direct `better-sqlite3`
  calls from the handler.

## Shape of the response (tentative — confirm in FRAME)

```ts
interface SyncStatusResult {
  readonly generatedAt: string;   // ISO, from Clock
  readonly accountsTracked: number;
  readonly staleCount: number;    // rows with no ok in > stale threshold
  readonly rows: readonly {
    readonly account: string;
    readonly source: MessageSource;
    readonly lastSyncAt?: string;        // ISO; from sync_state
    readonly lastOkAt?: string;          // ISO; most recent ok row in sync_log
    readonly lastStatus?: "ok" | "error";// most recent row in sync_log
    readonly lastError?: string;         // from most recent error row
    readonly messagesAddedLastOk?: number;
    readonly messagesAddedLast24h: number;
    readonly stale: boolean;             // lastOkAt older than threshold (or never)
  }[];
}
```

- `rows` is the cartesian of `accounts` × the set of sources that have
  ever appeared in `sync_state` or `sync_log` for that account. v1:
  outlook only (Teams lands Weekend 4), so this is just one row per
  account in practice — but the shape must not hard-code that.
- Stale threshold: **default 15 minutes** (3× the 5-minute sync loop).
  Constant at top of handler file; no config knob yet.
- No params on the tool. Everything is computed from the store + clock.

## RED test list

Store contract (runs against both in-memory + sqlite):

1. `getSyncStatus on an empty store returns zero rows`
2. `getSyncStatus returns one row per (account, source) seen in sync_state`
3. `getSyncStatus includes a row for an account with no sync_log entries yet (lastStatus undefined)`
4. `getSyncStatus.lastStatus reflects the most recent sync_log row (ok after error)`
5. `getSyncStatus.lastStatus reflects the most recent sync_log row (error after ok)`
6. `getSyncStatus.lastOkAt is the most recent ok row, even when latest row is an error`
7. `getSyncStatus.lastError is set only when the most recent row is an error`
8. `getSyncStatus.messagesAddedLastOk mirrors the messagesAdded of the most recent ok row`
9. `getSyncStatus.messagesAddedLast24h sums messagesAdded for ok rows in the last 24h (uses injected clock for "now")`
10. `getSyncStatus rows are deterministically ordered (account ASC, source ASC)`

Handler (in-memory store + FakeClock):

11. `handleGetSyncStatus returns generatedAt from the clock in ISO`
12. `handleGetSyncStatus sets stale=true when lastOkAt is older than 15 minutes`
13. `handleGetSyncStatus sets stale=false when lastOkAt is within 15 minutes`
14. `handleGetSyncStatus sets stale=true when there is no ok row at all`
15. `handleGetSyncStatus.staleCount equals the number of stale rows`
16. `handleGetSyncStatus.accountsTracked equals distinct accounts in rows`
17. `handleGetSyncStatus rejects any params (strict: additionalProperties=false)` — schema-level, asserted via tool descriptor
18. `handleGetSyncStatus on an empty store returns {accountsTracked:0, staleCount:0, rows:[]}`

HTTP / JSON-RPC integration:

19. `POST tools/list advertises both get_recent_activity and get_sync_status`
20. `POST tools/call name=get_sync_status returns the snapshot as JSON result`
21. `POST tools/call name=get_sync_status with no bearer → 401`
22. `POST tools/call name=get_sync_status with unknown params → JSON-RPC invalid params error` (only if we keep strict schema validation consistent with the other tool)

That's ~22 tests, in line with slice-1's ~30. I'll trim overlap during RED.

## Risks / open questions

- **SQL aggregation shape.** `sync_log` is `(ts, account, source, status,
  messages_added, error_message)` with `idx_sync_log_ts`. Per-row "last
  ok" + "last status" needs a window-ish query. Options: (a) one
  prepared statement per row using correlated subqueries; (b) pull
  recent rows for each `(account, source)` and fold in JS. For v1 the
  dataset is tiny (≤10 accounts × 5-min ticks × N days) — I'll go with
  (a) via `SELECT ... ORDER BY ts DESC LIMIT 1` subqueries, which is
  obvious and indexable. Decide final shape in SCAFFOLD.
- **What counts as a "known" (account, source) pair?** Accounts exist
  in `accounts`, but `source` only shows up in `sync_state`/`sync_log`.
  v1 will populate from the union of those two tables joined against
  `accounts`. If an account has never been synced, it still gets a row
  with `source="outlook"` defaulted? → **No.** v1 returns rows only for
  pairs actually present in `sync_state` ∪ `sync_log`. An account with
  no sync history yet simply contributes zero rows; `accountsTracked`
  counts the distinct accounts *in rows*, not in the `accounts` table.
  That's simpler and still answers "is my lake up to date?".
- **`messagesAddedLast24h` cost.** Sum over last 24h of ok rows per
  pair. Cheap with the ts index. Safe.
- **Stale threshold constant vs. config.** Keeping it a module
  constant. If it ever needs to move, it becomes a handler parameter,
  not a schema knob.
- **Tool name collisions / JSON-RPC dispatch refactor.** The current
  http-server likely has an `if (name === 'get_recent_activity')`
  branch. I'll turn that into a small map `{name → handler}` as part of
  this slice so adding a third tool later is trivial. Still minimal —
  no plugin system.

## Definition of done

- All RED tests written first, observed failing, then green.
- ≥90% line + branch coverage on every touched file.
- `/security-scan` clean (no fixtures with real accounts/tokens/errors).
- `/docs-update` run: changelog entry, PROGRESS.md checkbox ticked.
- Self-review checklist from `docs/tdd/methodology.md §2.8` done.
- PROGRESS.md [Weekend 3] `get_sync_status()` box checked with the
  test count and file path, following the slice-1 precedent.

---

**Awaiting approval before FRAME / RED.**
