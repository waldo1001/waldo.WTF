# Weekend 2 — Slice 9: FTS5 virtual table, triggers, and `searchMessages`

## Task

Add full-text search over `messages.body` (and `thread_name` +
`sender_name` as secondary columns) using SQLite FTS5. Wire it to the
`messages` table with contentless-shadow triggers so inserts, updates,
and deletes to `messages` stay reflected in the FTS index automatically,
and expose a single new query op on the `MessageStore` seam:
`searchMessages(query, limit)`.

This is the last schema-side piece blocking the "Real schema" checkbox
in [PROGRESS.md](../../PROGRESS.md). After this slice, the SQLite layer
is feature-complete for what Weekend 3's `search` MCP tool needs.

## Why this slice next

- Slice 8 explicitly deferred FTS5 with its own trigger surface. No
  consumer has landed that needs it yet, but the next Weekend-2 slice
  (5-minute sync loop) writes to `messages` and we want its writes to
  populate the FTS index from day one — retrofitting triggers against
  a populated `lake.db` is the expensive path.
- `searchMessages` is the single query op that Weekend 3's `search`
  MCP tool will call directly. Landing the store method now means the
  MCP slice is pure transport.
- Keeping this slice narrow (one virtual table, three triggers, one
  query op) keeps the SQL surface reviewable and the RED list small.

## Scope boundary

**IN this slice:**

- `src/store/schema.ts`:
  - Add `CURRENT_SCHEMA_VERSION = 2` (bump from 1).
  - Add `MIGRATION_2` containing:
    - `CREATE VIRTUAL TABLE messages_fts USING fts5(body, thread_name,
      sender_name, content='messages', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2');`
    - Three sync triggers against `messages`:
      `messages_ai` (AFTER INSERT) → `INSERT INTO messages_fts(rowid,
      body, thread_name, sender_name) VALUES (new.rowid, new.body,
      new.thread_name, new.sender_name);`
      `messages_ad` (AFTER DELETE) → `INSERT INTO messages_fts(
      messages_fts, rowid, body, thread_name, sender_name) VALUES
      ('delete', old.rowid, old.body, old.thread_name, old.sender_name);`
      `messages_au` (AFTER UPDATE) → delete-then-insert pair, same
      pattern.
    - Backfill step: `INSERT INTO messages_fts(rowid, body, thread_name,
      sender_name) SELECT rowid, body, thread_name, sender_name FROM
      messages;` so a db that already has slice-7/8 rows lights up
      immediately on migrate.
  - `applyMigrations` loop extends: `if (current < 2) db.exec(
    MIGRATION_2);`. Still wrapped in the existing transaction; still
    idempotent.
- `src/store/types.ts`:
  - `SearchHit` type: `{ message: Message, snippet: string, rank:
    number }`. `snippet` comes from FTS5 `snippet()` on the body
    column; `rank` is the raw `bm25(messages_fts)` score (lower =
    better per FTS5 convention — document this in a one-line comment
    on the type, the only comment in this slice).
- `src/store/message-store.ts`:
  - Extend `MessageStore` interface with:
    - `searchMessages(query: string, limit: number): Promise<readonly
      SearchHit[]>`.
  - No other method changes.
- `src/store/in-memory-message-store.ts`:
  - Naive implementation: lowercase substring match against `body ||
    ''`, `threadName || ''`, `senderName || ''`. `rank` = `0` for all
    hits (the fake is not a ranking oracle). `snippet` = first 80
    chars of `body` with match ellipsised, or empty string. Sort by
    `sentAt DESC` for stability, then apply `limit`.
  - The fake exists to keep downstream tests drop-in; it is NOT a
    FTS5 correctness oracle. The contract test that covers ranking
    runs against the sqlite impl only (see below).
- `src/store/sqlite-message-store.ts`:
  - Prepared statement:
    `SELECT m.*, snippet(messages_fts, 0, '[', ']', '…', 16) AS
    snippet, bm25(messages_fts) AS rank FROM messages_fts JOIN
    messages m ON m.rowid = messages_fts.rowid WHERE messages_fts
    MATCH ? ORDER BY rank LIMIT ?`.
  - `searchMessages` method parses the row into `SearchHit`, reusing
    the existing row→`Message` mapper from slice 7.
  - **Query sanitisation**: wrap the raw user query in double quotes
    and escape any embedded `"` by doubling it, so inputs like `foo
    bar` become phrase queries instead of `foo OR bar`, and inputs
    like `DROP TABLE` can't be interpreted as FTS5 column filters.
    Empty / whitespace-only query returns `[]` without touching the
    db. Keep it simple: one helper `toFts5Phrase(raw): string` in
    the same file (not exported).
- `src/store/message-store-contract.ts`:
  - Add contract cases (run against both impls):
    1. Empty store: `searchMessages('anything', 10)` returns `[]`.
    2. Literal substring hit in `body`: insert one message, search
       for a word that appears in body, expect one hit whose
       `message.id` matches.
    3. Hit in `thread_name` or `sender_name` only (no body match)
       still returns the row.
    4. `limit` is respected: insert 5 messages all containing the
       same word, `searchMessages(word, 2)` returns 2 hits.
    5. Empty query (`''` / whitespace) returns `[]` without error.
  - Ranking-sensitive cases are SQLite-only; they live in
    `sqlite-message-store.test.ts`, not the shared contract.
- Tests:
  - `src/store/schema.test.ts`: extend existing file with:
    - Fresh `:memory:` db migrates to `user_version=2`, has
      `messages_fts` virtual table and the three triggers in
      `sqlite_master`.
    - `applyMigrations` called twice still lands at `user_version=2`,
      row counts in `messages_fts` unchanged between calls.
    - **Upgrade path**: open a fresh db, manually `PRAGMA user_version
      = 1` and create slice-8 tables, insert one `messages` row, then
      call `applyMigrations`. Assert `messages_fts` now contains one
      row (backfill worked) AND `user_version = 2`.
    - Trigger coverage: after migration, inserting a `messages` row
      via raw SQL makes it findable via `messages_fts MATCH ?`;
      deleting the row makes it unfindable; updating the body changes
      which search terms match.
  - `src/store/sqlite-message-store.test.ts`: add cases for
    - BM25 ranking: insert two messages, one with the search term
      once, one with it three times; the second ranks first (lower
      `rank` value).
    - `snippet` contains the match wrapped in `[`/`]` delimiters.
    - Injection-resistance: a query containing `"` and `*` does not
      throw and does not match everything.
  - `src/store/in-memory-message-store.test.ts`: picks up the
    contract additions for free; no new inline cases.
- `PROGRESS.md`:
  - Under "Port spike logic", add sub-bullet noting FTS5 landed.
  - **Now** tick the parent "Real schema" checkbox — this slice
    closes it.

**OUT of this slice (explicitly deferred):**

- `search` MCP tool (→ Weekend 3).
- Query ops `findRecent`, `getThread`, `recentSyncLog` — each still
  lands with its caller.
- 5-minute sync loop (next Weekend-2 slice).
- Real MSAL adapter (still pending from slice 5).
- `src/index.ts` wiring.
- FTS5 tokenizer tuning beyond `unicode61 remove_diacritics 2`.
  Language-specific stemming (Dutch / English) is a real future
  question, but not this slice.
- Highlighting in `thread_name` / `sender_name` (we only `snippet` on
  body). Callers who want title highlights can format client-side.
- Migration 3+ / down-migrations.

## Files to touch

- **Edit**:
  - `src/store/schema.ts` — bump `CURRENT_SCHEMA_VERSION` to 2, add
    `MIGRATION_2`, extend migration loop.
  - `src/store/schema.test.ts` — add FTS5 migration + trigger cases.
  - `src/store/types.ts` — add `SearchHit`.
  - `src/store/message-store.ts` — extend interface with
    `searchMessages`.
  - `src/store/message-store-contract.ts` — add 5 contract cases.
  - `src/store/in-memory-message-store.ts` — naive `searchMessages`.
  - `src/store/sqlite-message-store.ts` — prepared FTS statement,
    `toFts5Phrase` helper, `searchMessages` method.
  - `src/store/sqlite-message-store.test.ts` — ranking, snippet,
    injection cases.
  - `PROGRESS.md` — sub-bullet under "Port spike logic", tick "Real
    schema".

- **Create**: none. (Slice 9 is purely additive edits.)

## Seams

- `applyMigrations` seam is unchanged — raw `Database` in, void out.
  Migration 2 is pure SQL against the injected handle.
- `SqliteMessageStore` still takes an already-opened `Database`.
  Adding `searchMessages` uses the same prepared-statement pattern
  as every other query op.
- `searchMessages` takes a `query` string and `limit` number, returns
  a promise. No clock, no fs, no env.
- The in-memory fake's naive matcher is a deliberate seam for
  downstream tests — Weekend-3 MCP tool tests can run against the
  fake without pulling better-sqlite3 into the test binary.

## RED test list

### `src/store/schema.test.ts`

1. `applyMigrations` on a fresh `:memory:` db advances `user_version`
   from 0 to `CURRENT_SCHEMA_VERSION` (2).
2. After migration, `sqlite_master` contains the virtual table
   `messages_fts` and the three triggers `messages_ai`, `messages_ad`,
   `messages_au`.
3. `applyMigrations` called twice is a no-op: second call leaves
   `user_version=2`, `messages_fts` row count unchanged.
4. **Upgrade path**: db at `user_version=1` with a populated
   `messages` row → `applyMigrations` → `messages_fts` contains one
   row (backfill) and `user_version=2`.
5. Trigger: after migration, raw-SQL insert into `messages` makes the
   row findable via `SELECT rowid FROM messages_fts WHERE
   messages_fts MATCH ?`.
6. Trigger: raw-SQL delete from `messages` removes the row from the
   FTS index.
7. Trigger: raw-SQL update of `messages.body` changes which terms
   match.

### `src/store/message-store-contract.ts` (run against both impls)

8. Empty store → `searchMessages('foo', 10)` returns `[]`.
9. Single message with `body = 'lorem ipsum dolor'` → search for
   `'ipsum'` returns one hit whose `message.id` matches.
10. Match in `threadName` only (body empty) still returns the row.
11. Match in `senderName` only still returns the row.
12. Five messages all matching → `searchMessages(word, 2)` returns
    exactly 2 hits.
13. Empty / whitespace query returns `[]`.

### `src/store/sqlite-message-store.test.ts` (impl-specific)

14. BM25 ranking: two messages, one contains the term once, one
    contains it three times; the latter comes first (lower `rank`).
15. `snippet` field contains the matched term wrapped in `[`/`]`
    delimiters.
16. Injection-resistance: query `'foo" OR 1=1'` does not throw and
    does not return unrelated rows. Query containing `*` is treated
    as a literal, not a wildcard.
17. `searchMessages` survives store re-construction over the same
    handle — proves migration 2 is not dropping/re-creating the FTS
    index on second run (mirrors slice-8 case 12).

## Risks

- **better-sqlite3 build with FTS5.** FTS5 is compiled in by default
  in better-sqlite3's bundled SQLite, but we have never exercised it
  on this project. First test run may surface a "no such module:
  fts5" error; if so, fall back to rebuilding `better-sqlite3` with
  `--build-from-source` and document in PROGRESS.md Learning log.
- **Contentless-shadow vs. external-content table.** Using
  `content='messages'` means FTS5 fetches snippet/highlight data from
  the real `messages` table — this requires the three triggers to
  keep `rowid` in sync. Alternative (duplicating body into FTS as
  owned content) doubles disk. Go with external-content; the
  triggers are the well-known cost.
- **`rowid` stability on `messages`.** `messages.id` is a TEXT
  primary key, so `rowid` is implicit. Deleting and re-inserting the
  same `id` gets a new `rowid`. Triggers handle this (delete trigger
  fires with old `rowid`, insert trigger fires with new), but it
  means `searchMessages` cannot cache rowids. Not a bug — call out
  so future-me doesn't try to optimise it.
- **`unicode61 remove_diacritics 2` vs. Dutch/English stemming.** No
  stemming means searching for "meetings" won't find "meeting". This
  is a real limitation; deferring stemming to a future slice where
  we have real usage data to pick a tokenizer.
- **Query parser surface.** FTS5's MATCH syntax is rich (phrases,
  NEAR, column filters). We flatten user input to a quoted phrase,
  so power users can't do `body:foo NEAR bar`. That is the correct
  default — landing a "search DSL" belongs to a slice where a user
  actually asks for it.
- **Injection.** The `toFts5Phrase` helper is the only sanitisation
  layer. Test 16 is the proof. Do not skip it — an injection hole
  in a read-only lake is still a shape-of-data leak.
- **Contract test ordering fragility.** Tests 9–12 compare by
  `message.id`, not by array index, because the in-memory fake's
  "rank = 0" means ordering between hits is insertion-order, while
  sqlite ranks by BM25. Write assertions as "set contains" not
  "array equals".
- **`snippet()` on `''` body.** If a hit comes via `threadName` with
  empty body, `snippet(messages_fts, 0, ...)` still runs but returns
  empty. The `SearchHit.snippet` field is `string`, not `string |
  undefined` — empty string is the correct sentinel.
- **Idempotency of migration 2 backfill.** If somehow called twice
  (bug), the backfill `INSERT` would duplicate rows in
  `messages_fts`. The `current >= CURRENT_SCHEMA_VERSION` early-out
  in `applyMigrations` is the guard. Test 3 locks this in.

## Out-of-scope (reminder)

Search MCP tool, sync loop, query ops beyond `searchMessages`,
tokenizer tuning, highlight in non-body columns, down-migrations,
migration 3+, real MSAL adapter, `src/index.ts` wiring.
