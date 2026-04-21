---
name: fix-steering-predicate-null-columns
status: in-progress
---

# Fix steering predicate null-columns bug

## Task

When any `sender_email`/`sender_domain` steering rule is enabled, the
SQL steering predicate silently drops every message with a NULL
`sender_email` (all WhatsApp, some Teams) because `LOWER(NULL) = '…'`
evaluates to NULL and `NOT NULL` is NULL in SQL three-valued logic.

## Scope boundary

**IN**
- Make `buildSteeringPredicate` emit a `sqlFragment` that never
  evaluates to NULL at row level: wrap the OR-chain in
  `COALESCE((...), 0)` at the single point of construction.
- Cover the fix with a failing-first contract test that lives in the
  shared Sqlite/InMemory harness so regressions are caught in both
  stores.
- Verify `get_recent_activity` and `search` both return
  null-`sender_email` rows when a sender-email rule is active.
- Verify `mutedCount` is 0 for rows that don't match any rule (not
  NULL-swallowed).

**OUT** (explicit non-goals)
- No changes to steering rule semantics, UI, or MCP surface.
- No changes to ingestion — the pipeline is healthy.
- No migration; fix is code-only and idempotent.

## Files to create / touch

- `src/store/steering-filter.ts` — wrap `sqlFragment` in
  `COALESCE((...), 0)`.
- `src/store/steered-message-store.test.ts` — add RED tests covering
  null sender_email across both store factories
  (`getRecentMessages` and `searchMessages`).
- `docs/changelog.md` — bullet.

No other consumers change. The JS `matches()` path is already null-safe
via `(msg.senderEmail ?? "")` and stays untouched.

## Seams involved

- store (SQLite + in-memory via shared harness)
- steering predicate (pure function)

No other seams touched.

## RED test list

- **AC1**: `getRecentMessages` returns a whatsapp-like message
  (`senderEmail: undefined`) when an unrelated `sender_email`
  steering rule is active, across Sqlite + InMemory factories.
  - test file: `src/store/steered-message-store.test.ts`
  - test name: `"keeps messages with null sender_email when a sender_email rule is active"`
  - seam: store
  - edge cases: null sender_email + enabled sender_email rule →
    row must survive.
- **AC2**: `mutedCount` is 0 when no row actually matches the rule
  (i.e. the null rows are not miscounted as muted either).
  - test file: same
  - test name: `"reports mutedCount 0 when no messages match an active sender_email rule"`
- **AC3**: `searchMessages` returns a null-sender_email row that
  matches the FTS query when an unrelated sender_email rule is
  active.
  - test file: same
  - test name: `"searchMessages keeps null-sender_email hits when a sender_email rule is active"`

## Open questions / assumptions

- **Assumption**: `COALESCE((…), 0)` is supported on the installed
  SQLite build (standard function, always available in better-sqlite3).
- **Assumption**: No consumer reads `predicate.sqlFragment` and does
  its own transformation on the raw OR-chain. Verified:
  `sqlite-message-store.ts` is the only in-tree consumer; it uses the
  fragment verbatim in `AND <frag>` and `NOT <frag>`. Both stay
  correct with `COALESCE((...), 0)` wrapping.

## Risks

- Changing the shape of `sqlFragment` could affect any future
  consumer that tries to compose it. Mitigation: the value is still
  a valid boolean SQL expression — parenthesized, safe under `AND`
  and `NOT`.
- Slight perf: `COALESCE` over an OR-chain is negligible; SQLite
  short-circuits inside OR just as before.

## Out-of-scope follow-ups

- Investigate whether any existing Teams messages have been silently
  hidden since 2026-04-20 13:28 (when the sender_email rules were
  added). Defer until after this fix lands so we can query with a
  consistent predicate.
- Consider adding a steering-rule `source` scope default so rules
  that target email-only fields (`sender_email`, `sender_domain`)
  auto-scope to `outlook`. Out of scope here; would be a behavioral
  change, not a bug fix.
