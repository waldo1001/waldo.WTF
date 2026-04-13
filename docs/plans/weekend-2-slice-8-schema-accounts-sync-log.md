# Weekend 2 — Slice 8: Full schema (`accounts` + `sync_log`) with `user_version` migration

## Task

Extend the real SQLite schema with the two remaining non-FTS tables
from brief §5 — `accounts` and `sync_log` — and introduce a proper
`PRAGMA user_version`-based migration step that replaces the current
ad-hoc `CREATE TABLE IF NOT EXISTS` block in `SqliteMessageStore`.

The `messages` table already carries `raw_json` (landed in slice 7),
so the schema work here is purely additive: two new tables, matching
indices, and a migration runner that advances `user_version` from 0
→ 1 exactly once per database.

Two new store methods expose the new tables through the existing
`MessageStore` seam:

- `appendSyncLog(entry)` — forensic trail for the sync worker.
- `upsertAccount(account)` + `listAccounts()` — back the future
  `list_accounts` MCP tool.

FTS5 is **deferred to slice 9** — it has its own trigger surface and
deserves its own RED list.

## Why this slice next

- PROGRESS.md "Real schema" stays unchecked until `accounts` and
  `sync_log` exist alongside `messages` / `sync_state`. Slice 7
  explicitly deferred both with a promise to land them "with the
  test that demands them" — that moment is now, because the next
  two slices (sync loop, MCP `list_accounts`) both want to call
  through to them.
- Introducing `user_version` migrations before the sync loop lands
  means the first real deployment never sees a schema upgrade against
  a populated db. Doing it retroactively after `lake.db` has rows in
  it is the expensive path.
- Splitting FTS5 into its own slice (per the two-cycle recommendation
  accepted in chat) keeps this RED list small and the SQL surface
  reviewable.

## Scope boundary

**IN this slice:**

- `src/store/schema.ts` (new):
  - `CURRENT_SCHEMA_VERSION = 1` constant.
  - `applyMigrations(db: Database): void` — reads
    `PRAGMA user_version`, runs any pending migration scripts inside
    a transaction, advances the pragma. Idempotent: calling twice on
    a fully-migrated db is a no-op.
  - Migration 1 contains the **full** table set:
    `messages` (same columns + indices as slice 7, moved verbatim),
    `sync_state` (same),
    `sync_log` (`ts INTEGER NOT NULL`, `account TEXT NOT NULL`,
    `source TEXT NOT NULL`, `status TEXT NOT NULL CHECK(status IN
    ('ok','error'))`, `messages_added INTEGER`, `error_message TEXT`)
    with `idx_sync_log_ts ON sync_log(ts DESC)`,
    `accounts` (`username TEXT PRIMARY KEY`, `display_name TEXT`,
    `tenant_id TEXT`, `added_at INTEGER NOT NULL`).
  - No down-migrations. Brief §8 forbids preemptive generality; we
    only add a down path when something actually needs to roll back.
- `src/store/types.ts`:
  - `SyncLogEntry` type: `{ ts: Date, account: string, source:
    MessageSource, status: 'ok' | 'error', messagesAdded?: number,
    errorMessage?: string }`.
  - `AccountRecord` type: `{ username: string, displayName?: string,
    tenantId?: string, addedAt: Date }`.
- `src/store/message-store.ts`:
  - Extend the `MessageStore` interface with:
    - `appendSyncLog(entry: SyncLogEntry): Promise<void>`
    - `upsertAccount(account: AccountRecord): Promise<void>`
    - `listAccounts(): Promise<readonly AccountRecord[]>` (ordered by
      `addedAt ASC`, stable).
  - No query ops on `messages` or `sync_log` yet — the sync loop
    slice will ask for `recentSyncLog(limit)` and the MCP slice will
    ask for `findRecent`; each lands with its caller.
- `src/store/in-memory-message-store.ts`:
  - Implement the three new methods against in-memory arrays so the
    fake stays drop-in for downstream tests. `listAccounts` returns
    a frozen copy sorted by `addedAt`.
- `src/store/sqlite-message-store.ts`:
  - **Remove** the inline `SCHEMA` constant. Constructor calls
    `applyMigrations(db)` instead, then prepares statements. The
    migration step is the single source of truth for DDL.
  - Prepare statements for `INSERT INTO sync_log ...`,
    `INSERT INTO accounts ... ON CONFLICT(username) DO UPDATE SET ...`,
    `SELECT ... FROM accounts ORDER BY added_at ASC`.
  - Date ↔ integer conversion follows the slice-7 rule: unix ms via
    `Date.getTime()` / `new Date(ms)`. Nullable columns round-trip
    `undefined` ↔ `NULL` (same `nullable()` helper).
- `src/store/message-store-contract.ts`:
  - Add contract cases (run against both fakes) for:
    - `appendSyncLog` accepts an `ok` entry with `messagesAdded` and
      no `errorMessage`, and an `error` entry with `errorMessage` and
      no `messagesAdded`.
    - `upsertAccount` inserts then updates (same `username`, new
      `displayName`) — `listAccounts` returns one row with the new
      display name.
    - `listAccounts` returns rows ordered by `addedAt ASC` regardless
      of insert order.
    - Empty `listAccounts` returns `[]`, not `undefined`.
- Tests:
  - `src/store/schema.test.ts` (new):
    - Fresh `:memory:` db starts at `user_version=0`, runs
      `applyMigrations`, ends at `user_version=1`, has all four
      tables.
    - Calling `applyMigrations` twice leaves `user_version=1` and
      does not error (idempotent).
    - `sync_log.status` CHECK constraint rejects `'pending'`.
  - `src/store/in-memory-message-store.test.ts`: invokes the
    expanded contract helper; no new cases inline.
  - `src/store/sqlite-message-store.test.ts`: invokes the expanded
    contract helper; plus sqlite-specific case that `sync_log` rows
    survive a store re-construction over the same handle (proves the
    migration is not dropping/re-creating tables on second run).

**OUT of this slice (explicitly deferred to slice 9):**

- FTS5 virtual table, triggers (`messages_ai` / `messages_ad` /
  `messages_au`), `search()` query op. These are the whole point of
  slice 9.
- Query ops: `findRecent`, `getThread`, `recentSyncLog`. Each lands
  with its consuming test (sync loop or MCP tool).
- Migration 2+. We only write migration 1 here; the framework is
  ready for a second one but we don't write speculative migrations.
- Any change to `openDatabase` — pragmas stay as slice 7 left them.
- Real MSAL adapter (still pending from slice 5).
- Wiring `main()` / `src/index.ts` to actually open the file db.

## Files to touch

- **Create**:
  - `src/store/schema.ts`
  - `src/store/schema.test.ts`
- **Edit**:
  - `src/store/types.ts` — add `SyncLogEntry`, `AccountRecord`.
  - `src/store/message-store.ts` — extend interface with three new
    methods.
  - `src/store/message-store-contract.ts` — add contract cases for
    `sync_log` + `accounts`.
  - `src/store/in-memory-message-store.ts` — implement three new
    methods. (Filename per slice-6 layout; if it's named differently,
    edit wherever `InMemoryMessageStore` actually lives.)
  - `src/store/sqlite-message-store.ts` — drop inline `SCHEMA`, call
    `applyMigrations`, add three new prepared statements + methods.
  - `src/store/sqlite-message-store.test.ts` — add one sqlite-only
    case for `sync_log` persistence across re-construction.
  - `src/store/message-store.test.ts` (or the in-memory test file) —
    no new inline cases; picks up the contract additions for free.
  - `PROGRESS.md` — under "Port spike logic", add sub-bullet noting
    `accounts` + `sync_log` + `user_version=1` migration landed.
    **Do not** tick the parent "Real schema" checkbox yet — FTS5 is
    still pending in slice 9. Note the remaining gap in prose.

## Seams

- `applyMigrations` takes a raw `Database` handle — no filesystem, no
  clock, no env. Pure SQL against an injected db, trivially testable
  with `:memory:`.
- `SqliteMessageStore` still takes an already-opened `Database`. The
  migration call moves from "inline DDL in constructor" to "delegate
  to `applyMigrations`"; the injection seam is unchanged.
- `SyncLogEntry.ts` is a `Date` — caller supplies the timestamp, the
  store does not reach for a clock. Same rule as `importedAt` in
  slice 6/7.
- `AccountRecord.addedAt` is likewise caller-supplied. The sync
  worker (future slice) will pass `clock.now()`.

## RED test list

### `src/store/schema.test.ts`

1. `applyMigrations` on a fresh `:memory:` db advances
   `user_version` from 0 to `CURRENT_SCHEMA_VERSION` (1).
2. After migration, `sqlite_master` contains tables `messages`,
   `sync_state`, `sync_log`, `accounts` and indices
   `idx_messages_sent_at`, `idx_messages_account_source`,
   `idx_sync_log_ts`.
3. Calling `applyMigrations` twice is a no-op: second call leaves
   `user_version=1`, no error, row counts in each table unchanged
   between calls.
4. `sync_log.status` CHECK constraint: inserting `'pending'` throws;
   inserting `'ok'` and `'error'` succeeds.
5. `accounts.username` is PRIMARY KEY: inserting the same username
   twice via raw SQL (without `ON CONFLICT`) throws.

### `src/store/message-store-contract.ts` (contract cases — run against both impls)

6. `appendSyncLog` + raw read-back: writing an `ok` entry with
   `messagesAdded: 5` round-trips; `errorMessage` is absent on the
   read side. *(Contract helper exposes a read-back via a new
   `recentSyncLog(limit)` test-only helper on the contract? No —
   instead the contract accepts a raw-query callback from the
   factory. See Risks.)*
7. `appendSyncLog` with `status: 'error'` + `errorMessage` round-
   trips; `messagesAdded` is absent.
8. `upsertAccount` inserts a new row; `listAccounts()` returns it.
9. `upsertAccount` with an existing `username` updates
   `displayName` / `tenantId`; `listAccounts()` still returns one
   row with the updated fields.
10. `listAccounts()` returns rows ordered by `addedAt ASC`
    regardless of insert order (insert B then A; read back [A, B]).
11. `listAccounts()` on an empty store returns `[]`.

### `src/store/sqlite-message-store.test.ts` (impl-specific)

12. `sync_log` persistence across re-construction: write an entry via
    one `SqliteMessageStore`, build a second store over the same
    handle, query via a raw `SELECT COUNT(*) FROM sync_log` — row
    count is 1. Proves migration is idempotent and doesn't wipe
    data.

## Risks

- **Contract helper needs a read-back for `sync_log`.** The
  interface intentionally has no `recentSyncLog` query op yet, so
  the contract test can't read what it wrote through the public
  surface. Solution: the contract helper `factory` signature grows
  from `() => MessageStore` to `() => { store: MessageStore,
  rawSyncLogCount(): number, rawAccountsCount(): number }` — a
  per-impl escape hatch for tests only. For `SqliteMessageStore` the
  impl uses a direct `db.prepare('SELECT ...').get()`; for
  `InMemoryMessageStore` it reads the private arrays via a
  test-only accessor. Keeps the production interface clean. If this
  feels too clever, fall back to exposing `recentSyncLog(limit)` on
  `MessageStore` now — but that violates "land query ops with their
  caller". Prefer the factory-hatch path; call it out in FRAME so
  it's a conscious choice.
- **Moving DDL breaks slice-7 tests.** Slice 7's
  `sqlite-message-store.test.ts` currently relies on constructor-time
  `CREATE TABLE IF NOT EXISTS`. The refactor must keep every slice-7
  test green — run the full suite after the edit to `sqlite-
  message-store.ts`, before adding new cases.
- **`user_version` on a db that already has slice-7 tables.** If a
  developer has a `lake.db` sitting around from manual testing, it
  will have the slice-7 tables but `user_version=0`. Running
  migration 1 against it must be safe: migration 1 uses
  `CREATE TABLE IF NOT EXISTS` for `messages` / `sync_state` and
  unconditional `CREATE TABLE` for the two new tables. If the
  developer manually created `sync_log` / `accounts` out-of-band,
  they get a clean error and can drop the db — acceptable, this is
  pre-production.
- **CHECK constraint on `status` vs. TypeScript type.** The union
  `'ok' | 'error'` and the SQL CHECK must agree. If we widen the
  union later (e.g. `'skipped'`), it's a migration 2. Note in the
  migration file comment.
- **`ORDER BY added_at ASC` is not stable for ties.** If two accounts
  share an `addedAt`, order is undefined. Add `, username ASC` as a
  tie-breaker so the contract test is deterministic.
- **Transaction scope of `applyMigrations`.** Wrap each migration in
  a `BEGIN / COMMIT` so a mid-migration failure doesn't leave a
  partially-created schema with `user_version` unchanged. Test case
  3 (idempotency) implicitly covers the happy path; a failure-rollback
  test is out of scope until we have a second migration.
- **Native rebuild.** Unchanged from slice 7 — no new native deps.
  Just flag if `npm test` bites.

## Out-of-scope (reminder)

FTS5 + triggers + `search()` (→ slice 9), query ops
(`findRecent` / `getThread` / `recentSyncLog`), sync loop, MCP
tools, real MSAL adapter, `src/index.ts` wiring, migration 2+, down-
migrations.
