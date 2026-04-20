# Weekend 2 — Slice 7: SQLite `MessageStore` adapter

## Task

Implement `SqliteMessageStore`: a real `better-sqlite3`-backed adapter
behind the `MessageStore` interface from slice 6. Same surface
(`upsertMessages`, `deleteMessages`, `getSyncState`, `setSyncState`),
same contract tests, real disk-backed store with WAL mode. This is
the slice that turns the in-memory fake into a persistent lake for
the Weekend 2 sync loop.

## Why this slice next

- `InMemoryMessageStore` lets us TDD the sync loop in isolation, but
  PROGRESS.md "Real schema" stays unchecked until a real adapter
  exists. The sync loop slice is next after this one and wants to
  prove end-to-end persistence across runs — only the real adapter
  can do that.
- Slice 6 explicitly deferred the real adapter with a promise to land
  it "the same way `FakeGraphClient` / `FakeAuthClient` did" — i.e.
  reuse the slice-6 contract tests, prove the two implementations
  behave identically. Doing it now keeps the seam honest before any
  downstream caller hardcodes in-memory assumptions.
- `better-sqlite3` + WAL is a Weekend 0 spike result that already
  works. Porting it here is mostly mechanical SQL, low risk, high
  unblock value.

## Scope boundary

**IN this slice:**

- `src/store/sqlite-message-store.ts`:
  - `SqliteMessageStore implements MessageStore`.
  - Constructor takes `{ db: Database }` (a `better-sqlite3` handle)
    — **not** a file path. Opening the file and applying pragmas
    lives in a tiny `openDatabase(fs, path)` helper so tests can hand
    in an in-memory db directly. Mirrors how `FakeClock` / `FakeFs`
    inject state.
  - Runs idempotent `CREATE TABLE IF NOT EXISTS` migrations on
    construction for **`messages` and `sync_state` only** (slice 6
    surface). No `accounts`, no `sync_log`, no FTS5 yet — each lands
    with the test that demands it.
  - `upsertMessages` uses `INSERT ... ON CONFLICT(id) DO UPDATE SET
    ...` wrapped in a single transaction. Returns `{ added, updated }`
    by comparing `changes()` / pre-existing row count; prefer two
    prepared statements (existence check + upsert) inside the tx so
    the count is exact without parsing rowids.
  - `deleteMessages` uses `DELETE ... WHERE id IN (...)` with a
    prepared statement per id inside a transaction; `{ deleted }`
    returned from accumulated `changes()`.
  - `getSyncState` / `setSyncState` use `INSERT OR REPLACE` against
    `sync_state` keyed by `(account, source)`.
  - Date ↔ integer conversion: store `sent_at` / `imported_at` /
    `last_sync_at` as unix ms (`Date.getTime()`), hydrate back with
    `new Date(row.sent_at)`. Nullable columns round-trip `undefined`
    ↔ `NULL`.
- `src/store/open-database.ts`:
  - `openDatabase(path: string): Database` — thin wrapper that opens
    a `better-sqlite3` handle and applies `PRAGMA journal_mode=WAL`,
    `PRAGMA foreign_keys=ON`, `PRAGMA synchronous=NORMAL`. Exported
    so the future `main()` can wire the real file; tests skip it and
    pass `new Database(':memory:')` directly.
- Tests:
  - `src/store/sqlite-message-store.test.ts`: re-runs the slice-6
    contract cases against `SqliteMessageStore` backed by
    `:memory:`. Extracts the contract into a shared
    `runMessageStoreContract(factory)` helper in
    `src/store/message-store-contract.ts` so slice 6's
    `message-store.test.ts` and this slice's test call the same
    cases. (Refactor slice-6 test to use the helper as part of
    REFACTOR step, tests stay green.)
  - Sqlite-specific cases:
    - Persistence across instances: write via one
      `SqliteMessageStore`, close nothing (same db handle), build a
      second store over the same handle, verify reads.
    - `upsertMessages` is transactional: an invalid row in the batch
      (e.g. null `id` violating NOT NULL) rolls back the whole batch
      — assert nothing from the batch is visible.
    - Nullable fields round-trip: message with `threadId`,
      `senderEmail`, `body`, `bodyHtml`, `rawJson`, `isRead` all
      undefined survives a write/read cycle as `undefined`, not
      `null` leaking through.
    - `sent_at` / `imported_at` round-trip as `Date` instances with
      millisecond precision.
- Dependency: add `better-sqlite3` + `@types/better-sqlite3` to
  `package.json`. Run `npm install`. Make sure vitest still runs.

**OUT of this slice (explicitly deferred):**

- `accounts` table, `sync_log` table, FTS5 virtual table — land with
  their first consuming test (MCP `list_accounts`, sync loop
  `sync_log` writer, `search` tool respectively).
- Query ops (`findRecent`, `search`, `getThread`, `listAccounts`) —
  still not on `MessageStore` until a caller needs them.
- Migration framework. `CREATE TABLE IF NOT EXISTS` is sufficient
  until a schema change forces something smarter; premature
  versioning is exactly the over-engineering CLAUDE.md warns
  against.
- `main()` / CLI wiring of the real file path. `openDatabase` is
  exported but not yet called from `src/index.ts`.
- Real MSAL adapter (still pending from slice 5).

## Files to touch

- **Create**:
  - `src/store/sqlite-message-store.ts`
  - `src/store/open-database.ts`
  - `src/store/message-store-contract.ts` (shared contract helper)
  - `src/store/sqlite-message-store.test.ts`
- **Edit**:
  - `src/store/message-store.test.ts` — refactor to call
    `runMessageStoreContract(() => new InMemoryMessageStore())`.
    Tests must stay green through the refactor.
  - `package.json` — add `better-sqlite3`, `@types/better-sqlite3`.
  - `PROGRESS.md` — under "Port spike logic", add sub-bullet noting
    `SqliteMessageStore` landed. **Tick** the "Real schema" parent
    box only partially in prose: note that `messages` + `sync_state`
    are real, `accounts` / `sync_log` / FTS5 still pending. Don't
    mark the checkbox fully ticked — the parent box covers the full
    schema, which isn't done.

## Seams

- `Database` handle is injected into `SqliteMessageStore`. Tests
  pass `:memory:`; production will pass a file path via
  `openDatabase`.
- No `Clock` inside the store — caller supplies `importedAt` (same
  rule as slice 6).
- `FileSystem` is **not** a dep here. `better-sqlite3` opens files
  directly via its own native code; abstracting that through our
  `FileSystem` seam would be ceremony with zero testability win.
  The seam we care about is `MessageStore`, and that is already
  faked.

## RED test list

### `src/store/sqlite-message-store.test.ts`

1. Contract suite via `runMessageStoreContract` passes when factory
   returns a fresh `SqliteMessageStore` over `:memory:` (covers all
   10 slice-6 cases).
2. Two `SqliteMessageStore` instances over the **same** `Database`
   handle see each other's writes (persistence within a process).
3. `upsertMessages` rolls back on mid-batch failure: given a batch
   of 3 messages where message 2 violates a NOT NULL constraint,
   none of the 3 are present afterwards and the thrown error
   surfaces to the caller.
4. Nullable fields: a message with every optional field `undefined`
   writes, reads back with the same fields `undefined` (not `null`).
5. `sent_at` / `imported_at`: a `Date` with ms precision round-trips
   bit-for-bit through write → read.
6. `getSyncState` / `setSyncState` persist across separate store
   instances sharing one handle, and `deltaToken: undefined` is
   distinguishable from a missing row.

### `src/store/message-store.test.ts` (refactor, must stay green)

- Existing 10 cases move into `runMessageStoreContract(factory)` and
  are invoked with `() => new InMemoryMessageStore()`. No new cases.

## Risks

- **`better-sqlite3` native build.** First `npm install` on a fresh
  machine recompiles the native module against the current Node.
  Flag in PROGRESS notes if the build tool stack bites. Vitest must
  still pass after install.
- **Interface creep via SQL convenience.** Tempting to add
  `findRecent` "while we're in there" because the SQL is one line.
  Don't. Each query op lands with the test that demands it.
- **Return shape drift.** `{ added, updated }` must be exact, not
  approximate — the existence-check-then-upsert pattern is the
  simplest way; avoid hacks like counting `changes()` after
  `INSERT OR REPLACE` (that returns `1` for both paths).
- **Date precision.** `better-sqlite3` binds `number` as INTEGER;
  stick to `Date.getTime()`. Do **not** use ISO strings — the real
  adapter needs to match the brief §5 `sent_at INTEGER` column.
- **Contract helper coupling.** If the shared helper grows
  per-implementation escape hatches ("skip this test for sqlite"),
  the seam is wrong. Keep the helper pure; put impl-specific tests
  in the impl-specific file.
- **`:memory:` behavior divergence.** Shared-cache `:memory:`
  databases need `file::memory:?cache=shared` to be visible across
  connections. We sidestep this by only sharing **handles** within
  a test, not opening two separate connections to `:memory:`.

## Out-of-scope (reminder)

`accounts`, `sync_log`, FTS5, query/search ops, sync loop, MCP
tools, real MSAL adapter, CLI wiring, migration versioning.
