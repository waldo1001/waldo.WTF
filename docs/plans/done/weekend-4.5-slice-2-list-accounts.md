# Plan — `list_accounts` MCP tool (Weekend 4.5 slice 2)

> **Status:** PLAN, awaiting user approval per CLAUDE.md TDD loop.

## Task

Add a `list_accounts()` MCP tool that returns the known accounts so
Claude can enumerate what's available before deciding which to query.

## Why now

Brief §6. The last missing tool from the v1 MCP surface after
Weekend 4.5 slice 1 (`get_thread`) lands. Without it, Claude has to
infer account names from `get_recent_activity` / `search` results,
which means it only sees accounts that *happen to have recent
messages* and can miss a freshly-added login until it syncs.
`list_accounts` makes the set explicit.

## Scope boundary

**IN**

- New handler `src/mcp/tools/list-accounts.ts` + descriptor
  `LIST_ACCOUNTS_TOOL`, wired into the SDK dispatcher in
  [src/mcp/mcp-server.ts](../../src/mcp/mcp-server.ts).
- Backed by the **existing** `MessageStore.listAccounts()` (schema v1).
  No new store methods, no new columns, no migration.
- Projection drops nothing — there are no secrets on an `Account`
  row (`username`, `displayName?`, `tenantId?`, `addedAt`). But
  `tenantId` and raw `username` are still PII-adjacent, so confirm
  with the user at FRAME time whether to include them or only return
  `username` + `displayName`.
- E2E scenario added to [src/mcp/e2e-http.test.ts](../../src/mcp/e2e-http.test.ts).
- User-guide + Claude Desktop wiring docs updated.

**OUT**

- Per-source breakdown (`outlook` / `teams` / `whatsapp` status per
  account). That's `get_sync_status`'s job — calling both composes
  to the same information, and duplicating it here would drift.
- Writable operations (`add_account`, `remove_account`). Read-only
  forever per CLAUDE.md project reminders.
- Token / cache / login state. Not data the tool returns.
- Empty state handling. If `listAccounts()` returns `[]`, the tool
  returns `{count: 0, accounts: []}` — no special error.

## Open question

**Do we return `tenantId`?** The brief stores it in the `accounts`
table (schema v1). Claude knowing which tenant an account belongs to
is useful for disambiguation ("the iFacto account" vs "the dynex
account"), but it's a Microsoft identifier that doesn't need to leave
the server unless a human asked for it.

**Assumption (pending confirmation):** return `username`,
`displayName`, `addedAt`. Omit `tenantId` by default. Flag to the user
at FRAME time.

## Files to create / touch

- **New** [src/mcp/tools/list-accounts.ts](../../src/mcp/tools/list-accounts.ts) —
  `LIST_ACCOUNTS_TOOL` descriptor (empty `inputSchema`, same shape as
  `get_sync_status`) + `handleListAccounts(store)`. No `clock`
  needed.
- **New** [src/mcp/tools/list-accounts.test.ts](../../src/mcp/tools/list-accounts.test.ts) —
  handler-level unit tests.
- [src/mcp/mcp-server.ts](../../src/mcp/mcp-server.ts) — register
  `LIST_ACCOUNTS_TOOL` + `handleListAccounts` in `TOOL_DESCRIPTORS` /
  `TOOL_HANDLERS`. Note: this handler doesn't need `clock`, so the
  `ToolHandler` signature may need a small rework or the handler
  ignores the extra arg.
- [src/mcp/mcp-server.test.ts](../../src/mcp/mcp-server.test.ts) —
  assert `tools/list` now has four (or five if slice 1 shipped first)
  tools and that `tools/call list_accounts` returns a content block.
- [src/mcp/e2e-http.test.ts](../../src/mcp/e2e-http.test.ts) — one new
  scenario: `upsertAccount(...)` two rows, then call `list_accounts`
  over HTTP and assert both come back.
- [docs/user-guide.md](../user-guide.md) — advertise the tool.
- [docs/claude-desktop-wiring.md](../claude-desktop-wiring.md) — add
  to the tool list.
- [docs/changelog.md](../changelog.md), [PROGRESS.md](../../PROGRESS.md).

## Seams involved

store, mcp.

## RED test list

1. **Handler — empty store returns `{count: 0, accounts: []}`.**
2. **Handler — returns all accounts from `MessageStore.listAccounts()`,
   projected to `{username, displayName?, addedAt}`.**
3. **Handler — `addedAt` is serialized as ISO string**, not a Date
   instance (matches the `sentAt` convention in
   `get_recent_activity`).
4. **Handler — `tenantId` is NOT in the projection** (per the
   assumption above — change the test if the user picks the other
   path).
5. **Handler — result is ordered by `addedAt` ascending.** Seeded
   three accounts with different `addedAt`; result is in insertion
   order.
6. **MCP server — `tools/list` includes `list_accounts`** with an
   empty-object `inputSchema`.
7. **MCP server — `tools/call list_accounts` wraps result in a text
   content block**, driven by SDK `InMemoryTransport` client.
8. **E2E HTTP — two accounts end-to-end.** `:memory:`
   `SqliteMessageStore` + real `fetch` +
   `StreamableHTTPClientTransport`.

## Risks

- **`ToolHandler` signature reshuffle.** The current signature is
  `(store, clock, args) => Promise<unknown>`. `list_accounts` doesn't
  need `clock` or `args`. Simplest fix: handler ignores them (no
  reshuffle). Alternative: split into `StoreToolHandler` vs
  `StoreClockToolHandler`. Prefer the "ignore" approach — this is
  one tool, not a shape change.
- **PII decision drift.** If the user flips to include `tenantId`
  later, the projection test (#4) is the only thing to change, but
  downstream clients may have cached the old shape. Document the
  projection in the user guide so it's explicit.
- **Ordering stability.** `listAccounts()` is not documented to
  return rows in any specific order today. Verify the SQLite impl
  orders by `added_at` before writing RED #5; if it doesn't, pick a
  stable order in the handler (don't rely on store-side ordering).

## Out-of-scope follow-ups

- Per-account health status aggregate (e.g. `stale: true`). Compose
  with `get_sync_status` instead.
- Per-account source filter ("which accounts have Teams enabled?").
  Defer until a real question asks for it.
- `get_account(username)` single-account detail view. YAGNI for v1.
