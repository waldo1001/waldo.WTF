# Weekend 2 — Slice 6: Store seam + in-memory fake

## Task

Land `src/store/`'s **testable core**: the `Message` domain type, a
`MessageStore` interface covering the minimum ops the sync loop will
need, and an `InMemoryMessageStore` fake that tests (and later the
sync slice) can drive without touching SQLite. No `better-sqlite3`
wiring in this slice — the real adapter is a follow-up, landing the
same way `FakeGraphClient` / `FakeAuthClient` did.

## Why this slice next

- PROGRESS.md Weekend 2 next unchecked under "Port spike logic" is
  **real schema** (`messages`, `sync_state`, `sync_log`, `accounts`,
  FTS5). The full SQL belongs to the real adapter slice; the seam +
  fake land first so every downstream consumer (sync loop, MCP tools)
  can be TDD'd against a pure in-memory store.
- Every other Weekend 2/3 slice — sync loop, `get_recent_activity`,
  `get_sync_status` — reads/writes through this seam. Getting the
  shape right now avoids churning the interface later.
- The real MSAL adapter is still pending from slice 5, but it's an
  integration concern (only verifiable via live login) and unblocks
  nothing that TDD can exercise. Store seam unblocks the sync loop,
  which is the critical path to a working v1.
- Brief §5 gives a stable schema sketch. The domain `Message` type
  mirrors it 1:1 so the real SQLite adapter is a mechanical mapping.

## Scope boundary

**IN this slice:**

- `src/store/types.ts`:
  - `Message` type mirroring brief §5 `messages` columns:
    `{ id, source, account, nativeId, threadId?, threadName?,
      senderName?, senderEmail?, sentAt: Date, importedAt: Date,
      isRead?: boolean, body?, bodyHtml?, rawJson? }`.
    `source` is `"teams" | "outlook" | "whatsapp"`.
  - `SyncStateEntry` type: `{ account, source, deltaToken?,
    lastSyncAt?: Date }`.
  - `StoreError` class extending `Error` with
    `kind: "not-found" | "conflict" | "corrupt"` discriminant.
- `src/store/message-store.ts`:
  - `MessageStore` interface — minimum surface the sync loop needs:
    - `upsertMessages(messages: readonly Message[]): Promise<{ added: number; updated: number }>`
      — idempotent on `id`; inserts or replaces.
    - `deleteMessages(ids: readonly string[]): Promise<{ deleted: number }>`
      — handles Graph `@removed`.
    - `getSyncState(account: string, source: Message["source"]): Promise<SyncStateEntry | null>`
    - `setSyncState(entry: SyncStateEntry): Promise<void>`
  - No query/search ops yet — `get_recent_activity` lands with its own
    test-driven addition in the MCP slice.
- `src/testing/in-memory-message-store.ts`:
  - `InMemoryMessageStore implements MessageStore`:
    - Backs messages in a `Map<string, Message>` keyed by `id`.
    - Backs sync state in a `Map<\`${account}::${source}\`, SyncStateEntry>`.
    - Records `calls` for assertions, same style as `FakeGraphClient` /
      `FakeAuthClient`.
    - Constructor: `{ seed?: { messages?: Message[]; syncState?: SyncStateEntry[] } }`.
- Tests (RED list below):
  - `src/store/message-store.test.ts` — contract tests that run
    against `InMemoryMessageStore`, written so the future real
    adapter can be plugged into the same suite.
  - `src/testing/in-memory-message-store.test.ts` — fake-specific
    behavior (call log, seed, isolation).

**OUT of this slice (explicitly deferred):**

- `better-sqlite3`, any SQL, any migrations, WAL mode, FTS5. That's
  the real-adapter slice.
- Query ops (`findRecent`, `search`, `getThread`, `listAccounts`,
  `appendSyncLog`). They land when an MCP tool test demands them.
- `accounts` and `sync_log` tables — not touched by the sync loop's
  happy path yet, add when the sync slice or MCP slice needs them.
- Real MSAL adapter (still pending from slice 5) — tracked
  separately, not unblocked or blocked by this slice.
- Any CLI wiring or `loadConfig` changes.

## Files to touch

- **Create**:
  - `src/store/types.ts`
  - `src/store/message-store.ts`
  - `src/store/message-store.test.ts`
  - `src/testing/in-memory-message-store.ts`
  - `src/testing/in-memory-message-store.test.ts`
- **Edit**: `PROGRESS.md` during UPDATE DOCS — add a sub-bullet under
  "Port spike logic" noting store seam + in-memory fake landed. Do
  **not** tick the "Real schema" parent box; the real SQLite adapter
  is still pending.

## Seams

- `MessageStore` is the seam. All business logic (sync loop, MCP
  tools) takes a `MessageStore`, never a `Database` handle. Real
  SQLite adapter and `InMemoryMessageStore` are interchangeable.
- No `FileSystem` dep in this slice — in-memory fake is pure JS maps.
  Real adapter will take a `FileSystem` + path for `lake.db`.
- No `Clock` dep in the store itself — `importedAt` is supplied by
  the caller (the sync slice will inject its own clock when it
  builds `Message` rows). Tests pass plain `new Date(...)` literals.

## RED test list

### `src/store/message-store.test.ts` (contract tests via `InMemoryMessageStore`)

1. `upsertMessages` on an empty store returns `{ added: N, updated: 0 }`
   and makes all messages retrievable via a subsequent call.
2. `upsertMessages` with a message whose `id` already exists updates
   in place and returns `{ added: 0, updated: 1 }`.
3. `upsertMessages` with a mix of new + existing ids reports correct
   `added` / `updated` counts.
4. `upsertMessages` with an empty array is a no-op returning
   `{ added: 0, updated: 0 }`.
5. `deleteMessages` removes the listed ids and returns the count of
   rows actually deleted (missing ids are silently skipped).
6. `deleteMessages` with an empty array is a no-op.
7. `getSyncState` returns `null` when no entry exists for the
   `(account, source)` pair.
8. `setSyncState` then `getSyncState` round-trips the entry by
   `(account, source)`.
9. `setSyncState` overwrites an existing entry for the same
   `(account, source)` rather than duplicating it.
10. Sync state is keyed by the pair: setting `(a, outlook)` does not
    affect `(a, teams)` or `(b, outlook)`.

### `src/testing/in-memory-message-store.test.ts`

1. `seed.messages` are visible via `upsertMessages`-then-read without
   needing an initial write.
2. `seed.syncState` is visible via `getSyncState`.
3. `calls` records each method invocation with method name and args,
   in order, so sync-loop tests can assert what the loop did.
4. Two independent `InMemoryMessageStore` instances do not share
   state (no accidental module-level singletons).

## Risks

- **Interface creep.** Tempting to add `findRecent`, `search`,
  `listAccounts` now. Don't — each one lands with the test that
  demands it. Keep the surface to what the sync loop actually uses.
- **`Message` type drift from brief §5.** Field names are
  camel-cased in TS but must map 1:1 to the SQL columns so the real
  adapter is mechanical. Any divergence → update the brief or the
  type, never silently.
- **`upsertMessages` return shape.** `{ added, updated }` is what
  `sync_log.messages_added` will eventually want. Resist returning
  the upserted rows — callers don't need them yet.
- **`InMemoryMessageStore` iteration order.** Tests should not
  depend on insertion order of `upsertMessages` since the real
  SQLite adapter won't guarantee it without an `ORDER BY`. Assert
  set membership, not array order, for bulk ops.

## Out-of-scope (reminder)

Real SQLite, FTS5, WAL, migrations, `accounts` table, `sync_log`
table, query/search ops, sync loop, MCP tools, real MSAL adapter,
CLI wiring.
