# Plan — Structured sender & date filters on the `search` MCP tool

## 1. Task

Extend the `search` MCP tool with optional structured filters `sender_email`, `sender_name`, `after`, `before`, so an assistant can answer "what has Gunter Peeters sent me in the last 30 days?" without being forced through FTS5 body text. `query` becomes optional when any structured sender filter is present. Steering and `include_muted` semantics are preserved.

## 2. Scope boundary

**IN**
- New optional params on the `search` tool: `sender_email`, `sender_name`, `after`, `before`.
- `query` becomes optional — but at least one of `query | sender_email | sender_name` is required.
- Store-layer `searchMessages` accepts the new filters in `SearchMessagesOptions`.
- Structured filters compose with existing FTS MATCH via AND, and with the existing steering `NOT predicate` clause via AND.
- When `query` is absent, results are ordered by `sent_at DESC` (no FTS join).
- `muted_count` reflects only rows matching the structured scope.
- Parallel support in `InMemoryMessageStore` so the unit test surface is consistent.
- Updated tool input JSON schema.

**OUT (deferred)**
- `sender_domain` wildcard filter.
- Raising `get_recent_activity`'s 200-row cap.
- Adding `sender_email` to the FTS5 virtual table (not needed; equality/LIKE on the structured column is sufficient).
- Full-mailbox listing via `search({})` with no filters.
- Any write path / Graph change.

## 3. Files to create / touch

- [src/mcp/tools/search.ts](../../src/mcp/tools/search.ts) — extend `SearchParams`, `inputSchema`, `handleSearch` validation + store call.
- [src/store/message-store.ts](../../src/store/message-store.ts) — extend `SearchMessagesOptions` interface.
- [src/store/sqlite-message-store.ts](../../src/store/sqlite-message-store.ts) — extend `searchMessages` SQL build to support optional FTS and sender/date WHERE clauses.
- [src/testing/in-memory-message-store.ts](../../src/testing/in-memory-message-store.ts) — mirror new filter handling; update `InMemoryMessageStoreCall` shape.
- [src/mcp/tools/search.test.ts](../../src/mcp/tools/search.test.ts) — new RED tests + update the two existing `toEqual`-based call assertions that expect the old call shape.
- [src/testing/in-memory-message-store.test.ts](../../src/testing/in-memory-message-store.test.ts) — filter semantics at the store layer.
- [docs/changelog.md](../changelog.md) + [docs/user-guide.md](../user-guide.md) — user-visible tool surface change (via `/docs-update`).

## 4. Seams involved

- `store` (SearchMessagesOptions extended, two implementations)
- `clock` (not touched directly — `after`/`before` are absolute timestamps)
- No graph / msal / fs / http change.

## 5. RED test list

Each item is one test, with target file and seam-touching notes. `search.test.ts` unless otherwise stated.

- **AC1** `rejects input missing query and all sender filters`
  - covers the new "at least one of query|sender_email|sender_name" rule
  - seams: none; pure validation
- **AC2** `accepts sender_email alone and returns only messages with matching sender_email (case-insensitive)`
  - seed three messages, two with matching email (mixed case), one without
  - seams: store (`InMemoryMessageStore`)
- **AC3** `sender_email filter ignores messages where the address appears only in body text`
  - seed one message with `senderEmail="gunter@example.test"` and another with body containing that string but different sender
  - asserts only the first is returned
- **AC4** `sender_name filter is a case-insensitive substring match`
  - seed "Gunter Peeters" and "Peeters, Gunter" and "Gunther Muller"; query `sender_name: "peeters"` matches both first two
- **AC5** `sender_email AND query compose with AND semantics, not OR`
  - seed two messages from same sender, bodies contain different words; query="lunch" + sender_email=X returns only the lunch one
- **AC6a** `after and before bound the result on sent_at`
  - seed 3 messages at different dates; assert the window returns only the middle one
- **AC6b** `rejects invalid ISO date string in after`
  - `after: "not-a-date"` → `InvalidParamsError`
- **AC6c** `rejects after > before`
  - edge case: `after: "2026-05-01", before: "2026-04-01"` → `InvalidParamsError`
- **AC7** `steering rule muting a sender_email still hides matching results when sender_email filter is set`
  - seed a steering rule `sender_email=gunter@example.test`; `search({ sender_email: "gunter@example.test" })` returns zero hits and a non-zero `muted_count`
  - with `include_muted: true` the message is visible
- **AC8** `muted_count is scoped to the structured filter`
  - seed 5 total muted messages, only 2 matching the sender filter → `muted_count === 2`
- **AC9** `when query is omitted, results are ordered by sent_at DESC`
  - seed three messages at different dates with the same sender
- **AC10** `tool descriptor advertises new optional params and keeps query in properties (not required)`
  - asserts `required` no longer forces `query`; `sender_email`, `sender_name`, `after`, `before` exist in `properties`
- **AC11** SQLite parity — in [sqlite-message-store.test.ts] or a new contract-style test: the same seed/filter combination returns identical results to the in-memory store
  - seams: real `better-sqlite3` `:memory:`

## 6. Open questions / assumptions

- **Assumption (flagged):** `sender_name` matches as case-insensitive substring (`LIKE %needle%`) — confirmed in plan chat. Alternative: token-prefix via FTS5; rejected as overkill.
- **Assumption:** `after` and `before` are ISO 8601 at the tool boundary; internal storage is Unix ms, matching `get_recent_activity.hours`. An invalid string yields `InvalidParamsError` with a descriptive message.
- **Assumption:** If both `query` and `sender_email` are provided, the result intersection is taken (AND). Confirmed in plan chat.
- **Assumption:** When `query` is absent, ordering is `sent_at DESC`. When `query` is present, ordering stays BM25 `rank` ASC (existing behavior).
- **Assumption:** `after` is **inclusive** (`sent_at >= after`), `before` is **exclusive** (`sent_at < before`). Documented on the schema description and asserted in AC6a.
- **Open:** should `search` also accept an `accounts` filter (like `get_recent_activity`) for symmetry? **Decision:** OUT of scope; different task.

## 7. Risks

- Existing tests in `search.test.ts` assert exact call shape on `InMemoryMessageStore` (`toEqual({method,query,limit})`). Changing the call shape will turn those tests red as plumbing failures — must be addressed in the same cycle so the RED list stays clean.
- Adding WHERE clauses to `searchMessages` risks double-counting in the muted-count query if I forget to apply the same filters to the count SELECT. Test AC8 guards.
- If the FTS5 MATCH clause is removed when `query` is absent, the `messages_fts` JOIN must also go (otherwise `snippet()` / `bm25()` break). Covered by AC9.
- Rolling back: no schema change, no data migration — reverting is a pure code revert.

## 8. Out-of-scope follow-ups

- Add `sender_domain` filter (e.g. `sender_domain: "example.test"`).
- Raise or paginate `get_recent_activity` beyond 200 rows.
- `/docs-update` will surface the new params in the user guide — the skill runs at step 9 of the TDD cycle.
