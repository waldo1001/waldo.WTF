# Plan: Steering / "not interested" rules

## Context

Today waldo.WTF ingests everything from every account and every source into one lake. When Claude answers *"wtf is going on?"*, the reply can include low-signal stuff — newsletters, automated Jira noise, out-of-office replies, one specific sender who pings constantly but rarely matters. The user wants a way to mark these as uninteresting so they stop surfacing in conversational answers — **driven from chat, not from a shell** ("when Claude says 'you have a shitload from DevOps', I want to reply 'not interested in DevOps mails' and have it stick").

The project brief §10 flags this as an open question and lands on: **steering must apply at query time, not sync time — nothing is deleted, steering is a lens, not a filter.** The user has sharpened that to: **hard-exclude by default**, with an opt-in escape hatch to see muted items ("if I EVER want to search uninteresting mails"). Sync stays exactly as it is today.

Outcome: a new `steering_rules` table, a shared predicate that the message-store applies to `get_recent_activity` and `search`, MCP tools for Claude to **read and write** steering rules conversationally, and a CLI as a scriptable second path.

## Interpretation of brief §9 "read-only MCP surface"

§9 forbids MCP write tools **so that a compromise cannot send, reply, delete, or archive from four Microsoft accounts.** That rule stays intact: no tool ever mutates mail, Graph, or stored messages. Local-preference writes (steering rules in the same SQLite lake) are a scoped exception: an attacker who compromises the bearer token can add rules that hide messages from the user — annoying but **fully reversible** by calling `remove_steering_rule`, with zero external blast radius. This carve-out is documented in CLAUDE.md and the user guide so the constraint stays unambiguous.

## Design decisions

- **Hard-exclude by default** on `get_recent_activity` and `search`. Both gain an `include_muted: boolean` parameter (default `false`) and both return a `muted_count` number plus a `steering_hint` string when non-zero.
- **`get_thread` and `list_accounts` are unaffected** — when the user pulls a specific thread they want all of it; account listing is metadata.
- **Sync is untouched.** Rules apply only at read time. All rows remain in `messages`.
- **Rule types for v1** — five, all cheap once the table exists:
  - `sender_email` — exact match on `sender_email` (case-insensitive via lowercase normalization)
  - `sender_domain` — matches when `sender_email` ends with `@<pattern>` (catches whole-domain newsletters without listing every From)
  - `thread_id` — exact match on `thread_id` (mute one specific conversation / Teams chat)
  - `thread_name_contains` — case-insensitive substring on `thread_name` (mute things like `[Jira]`, `out of office`)
  - `body_contains` — keyword match on the message body, implemented via FTS5 exclusion (`messages.rowid NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)`). Handles *"anything mentioning sync fail"*. FTS5 is already populated today, so there's no new index cost.
- **Optional per-rule scope**: `source` and `account` columns narrow a rule to one source and/or one mailbox. NULL = applies everywhere.
- **Filtering pushed into SQL** via a `WHERE NOT (…)` predicate generated from enabled rules; the in-memory fake mirrors the exact same predicate in JS. A shared pure function `buildSteeringPredicate(rules)` used by both impls keeps them provably in parity and is unit-testable on its own.
- **Chat-driven management via MCP write tools** — Claude adds, removes, and toggles rules in-conversation. Four MCP tools:
  - `get_steering()` — list rules (enabled + disabled) so Claude can self-explain ("hiding github.com newsletters because you muted that domain on 2026-04-20").
  - `add_steering_rule(rule_type, pattern, source?, account?, reason?)` — returns `{id, rule}`. Claude is expected to confirm in chat before calling ("I'll mute sender azuredevops@microsoft.com, OK?") but the tool itself trusts the call — rules are trivially reversible so no `confirm: true` gate in v1.
  - `remove_steering_rule(id)` — returns `{removed: boolean}`.
  - `set_steering_enabled(id, enabled)` — toggle without deleting (for "temporarily show me Barbara's again").
- **CLI as scriptable second path** — `src/cli.ts` still gains `--steer-add-*`, `--steer-list`, `--steer-enable`, `--steer-disable`, `--steer-remove` for scripting, bulk import, and recovery outside a chat session. Both paths hit the same `SteeringStore`.
- **Outlook category ingestion is out of scope.** The user mentioned "categories"; Outlook-side category labels are not captured today and would require a sync change. Flagged in docs as future work — once `category_equals` is useful, add it then.

## TDD slices

Each slice is one /tdd-cycle run, green before moving on. Coverage ≥90% per touched file. Security scan before commit. Docs updated at slice E or inline as needed.

### Slice A — schema + rule CRUD

**Goal.** Migration 10 adds `steering_rules`; new `SteeringStore` provides CRUD.

**RED tests** (`src/store/steering-store.test.ts` + contract):
- migration 10 creates `steering_rules` and bumps `user_version` to 10
- migrations are idempotent from v9 and from v10
- `addRule` normalizes `pattern` to lowercase
- `addRule` rejects unknown `rule_type`
- `addRule` dedupes on `(rule_type, pattern, source, account)` via unique index
- `listRules` returns enabled + disabled rules ordered by `created_at`
- `setEnabled(id, bool)` toggles the flag
- `removeRule(id)` deletes and returns changed count
- in-memory fake matches contract (dedupe, ordering, normalization)

**Schema (migration 10)**:
```sql
CREATE TABLE steering_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_type TEXT NOT NULL CHECK(rule_type IN
    ('sender_email','sender_domain','thread_id','thread_name_contains','body_contains')),
  pattern TEXT NOT NULL,
  source TEXT,
  account TEXT,
  reason TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_steering_enabled_type ON steering_rules(enabled, rule_type);
CREATE UNIQUE INDEX idx_steering_dedupe
  ON steering_rules(rule_type, pattern, IFNULL(source,''), IFNULL(account,''));
```

**Files.**
- modify [src/store/schema.ts](../../src/store/schema.ts) — add `MIGRATION_10`, bump `CURRENT_SCHEMA_VERSION`
- modify [src/store/types.ts](../../src/store/types.ts) — export `SteeringRule`, `SteeringRuleType`, `RuleScope`
- create [src/store/steering-store.ts](../../src/store/steering-store.ts) — interface + `SqliteSteeringStore` + `InMemorySteeringStore`
- create [src/store/steering-store-contract.ts](../../src/store/steering-store-contract.ts) — shared contract
- create [src/store/steering-store.test.ts](../../src/store/steering-store.test.ts)

### Slice B — filtered reads in MessageStore

**Goal.** `getRecentMessages` and `searchMessages` accept `{ includeMuted?: boolean }` and return `{ messages|hits, mutedCount }`. `getThread` stays as-is.

**RED tests** (extend `src/store/message-store-contract.ts`):
- `getRecentMessages` excludes messages matching `sender_email` rule when `includeMuted` omitted
- `getRecentMessages` excludes matching `sender_domain` rule (both `foo@bar.com` and `foo@sub.bar.com` cases if domain rule is `bar.com` — pick a defined behavior: exact-domain match; document it)
- `getRecentMessages` excludes matching `thread_id` rule
- `getRecentMessages` excludes matching `thread_name_contains` rule (case-insensitive)
- `getRecentMessages` excludes matching `body_contains` rule via FTS5 (single-word and two-word phrase)
- `getRecentMessages` respects per-rule `source` / `account` scope
- `getRecentMessages` returns `mutedCount` reflecting excluded rows within the base window
- `getRecentMessages` with `includeMuted=true` returns all, `mutedCount=0`
- `getRecentMessages` ignores disabled rules
- `searchMessages` excludes muted hits and reports `mutedCount`
- `searchMessages` with `includeMuted=true` returns all
- `getThread` is unaffected by steering rules (explicit non-regression test)

**Files.**
- create [src/store/steering-filter.ts](../../src/store/steering-filter.ts) + colocated test — pure `buildSteeringPredicate(rules)` returning `{ sqlFragment, params, matches(msg) }`
- modify [src/store/message-store.ts](../../src/store/message-store.ts) — broaden method shapes (breaking, updated in same slice)
- modify [src/store/sqlite-message-store.ts](../../src/store/sqlite-message-store.ts) — inject `SteeringStore`, use filter helper at lines 145–157 (`searchMessages`) and 316–343 (`getRecentMessages`); `searchStmt` becomes dynamic
- modify [src/store/in-memory-message-store.ts](../../src/store/in-memory-message-store.ts) — mirror via `matches(msg)`
- modify [src/store/message-store-contract.ts](../../src/store/message-store-contract.ts)

### Slice C — MCP tools (read + write)

**Goal.** Four steering tools on the MCP surface plus `include_muted` + `muted_count` on existing tools. Chat-driven add/remove/toggle from Claude.

**RED tests** (colocated in `src/mcp/tools/`):
- `get_steering` returns array of rules (enabled + disabled), empty input schema
- `add_steering_rule` validates `rule_type` against the 5 allowed values
- `add_steering_rule` rejects empty `pattern`
- `add_steering_rule` rejects `sender_domain` pattern containing `@`
- `add_steering_rule` normalizes pattern to lowercase for sender/domain types
- `add_steering_rule` returns `{id, rule}` with the stored shape
- `add_steering_rule` surfaces the unique-index dedupe error as a typed validation error
- `remove_steering_rule` returns `{removed: true}` for a known id, `{removed: false}` for unknown
- `set_steering_enabled` toggles enabled and returns the updated rule
- `get_recent_activity` default excludes muted and reports `muted_count`
- `get_recent_activity` with `include_muted=true` returns all, no hint
- `get_recent_activity` emits `steering_hint` only when `muted_count > 0`
- `search` default excludes muted, reports `muted_count`
- `search` with `include_muted=true` returns all
- `mcp-server` registers all four steering tools in `TOOL_DESCRIPTORS` and `TOOL_HANDLERS`
- `mcp-server` threads a `SteeringStore` into the tool context
- **read-only contract test**: no steering MCP tool mutates `messages`, `accounts`, `sync_state`, `sync_log`, or any Graph resource (only `steering_rules` writes are allowed)

**Files.**
- create [src/mcp/tools/get-steering.ts](../../src/mcp/tools/get-steering.ts) + test
- create [src/mcp/tools/add-steering-rule.ts](../../src/mcp/tools/add-steering-rule.ts) + test
- create [src/mcp/tools/remove-steering-rule.ts](../../src/mcp/tools/remove-steering-rule.ts) + test
- create [src/mcp/tools/set-steering-enabled.ts](../../src/mcp/tools/set-steering-enabled.ts) + test
- modify [src/mcp/tools/get-recent-activity.ts](../../src/mcp/tools/get-recent-activity.ts) + test
- modify [src/mcp/tools/search.ts](../../src/mcp/tools/search.ts) + test
- modify [src/mcp/mcp-server.ts](../../src/mcp/mcp-server.ts) — register tools, widen context around lines 46–64
- modify [src/mcp/mcp-server.test.ts](../../src/mcp/mcp-server.test.ts)
- modify [src/index.ts](../../src/index.ts) — construct `SqliteSteeringStore` and pass into MCP bootstrap

### Slice D — CLI management

**Goal.** Add/list/toggle/remove rules from the shell.

**RED tests** (extend `src/cli.test.ts`):
- `--steer-add-sender foo@Bar.com` lowercases and calls `steerImpl`
- `--steer-add-domain` rejects a value containing `@`
- `--steer-add-thread-name ""` rejects empty substring
- `--steer-add-thread <id>` stores the id verbatim
- `--steer-list` prints `id  type  pattern  scope  enabled` rows
- `--steer-disable <id>` flips enabled=0
- `--steer-enable <id>` flips enabled=1
- `--steer-remove <id>` deletes
- each flag accepts optional `--reason "<text>"` and `--source <src>` / `--account <acct>` scope args
- integration test: round-trip add → list → disable → list → remove against temp sqlite

**Files.**
- modify [src/cli.ts](../../src/cli.ts) — add flags, `steerImpl` injection seam, `realSteer()` adapter (c8-ignored)
- modify [src/cli.test.ts](../../src/cli.test.ts)
- modify [package.json](../../package.json) — optional `"steer": "node dist/cli.js --steer-list"` convenience script

### Slice E — docs

**Files.**
- [docs/user-guide.md](../user-guide.md) — "Muting noisy senders" section with examples
- [docs/getting-started.md](../getting-started.md) — mention `--steer-list` in day-2 operations
- [docs/changelog.md](../changelog.md) — changelog entry
- [CLAUDE.md](../../CLAUDE.md) — note steering exists; clarifies §10 lens → hard-exclude-by-default resolution
- [PROGRESS.md](../../PROGRESS.md) — mark Weekend 8 steering slice complete

## Existing code to reuse

- `applyMigrations` + `CURRENT_SCHEMA_VERSION` mechanism in [src/store/schema.ts](../../src/store/schema.ts) (pattern for migration 10)
- `MessageStore` contract test harness in [src/store/message-store-contract.ts](../../src/store/message-store-contract.ts) (mirror for `SteeringStore`)
- `TOOL_DESCRIPTORS` + `TOOL_HANDLERS` arrays in [src/mcp/mcp-server.ts](../../src/mcp/mcp-server.ts) around lines 46–64 (pattern for new tool)
- CLI `KNOWN_FLAGS` + `*Impl` dependency-injection pattern in [src/cli.ts](../../src/cli.ts) (mirror for `steerImpl`)
- `Clock` seam for `created_at` timestamps
- `include_body` boolean convention already in `get_thread` / `search` (mirror for `include_muted`)

## Verification

After each slice:
1. `npm test` — contract + unit tests green, coverage ≥90% per touched file
2. `/security-scan` — no findings (no secrets, no real sender addresses in fixtures)

End-to-end after Slice D:
1. From Claude Desktop, call `add_steering_rule(rule_type="sender_domain", pattern="marketing.example.com", reason="newsletters")` → returns `{id: 1, rule: {…}}`
2. Call `get_steering` → returns the rule
3. Call `get_recent_activity` over a window containing a marketing.example.com message → excluded, `muted_count >= 1`, `steering_hint` present
4. Call `get_recent_activity` with `include_muted=true` → message present, `muted_count=0`
5. Call `set_steering_enabled(id=1, enabled=false)` → rule disabled, message reappears on next `get_recent_activity`
6. Call `remove_steering_rule(id=1)` → `{removed: true}`; `get_steering` returns empty
7. CLI parity: `node dist/cli.js --steer-add-domain marketing.example.com && --steer-list && --steer-remove <id>` round-trips against the same DB
8. Try the three user examples end-to-end: *"not interested in mails from DevOps"*, *"don't want to see anything about this sync fail"*, *"not interested in Barbara's emails"* — confirm Claude picks a sensible `rule_type` and confirms before writing

Deploy to NAS via `/deploy-nas` once all slices green and docs updated.

## Out of scope (tracked, not built)

- Outlook category ingestion + `category_equals` rule type (requires Graph sync change)
- Regex rule type (substring + FTS5 covers expected v1 use)
- True embedding-based semantic-similarity rule (needs an embedding model at sync time and a vector store — separate multi-slice effort; revisit after daily use)
- Per-rule hit counters / last-matched telemetry
- An admin HTTP endpoint for rule management (add later if tailnet-curl convenience is actually needed)
- `confirm: true` safety gate on `add_steering_rule` (reconsider only if accidental rule creation becomes a real problem)
