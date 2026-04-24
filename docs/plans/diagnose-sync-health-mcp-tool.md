# Plan: Agent-Consumable Sync Health Diagnosis

## Context

**Problem.** waldo.WTF runs a background scheduler that syncs Outlook inbox/sent, Teams, and Viva Engage (including external tenants) into the local lake. When something goes sideways — a token expires, a delta cursor is invalidated, a Viva external-tenant subscription stops pulling — the user has no fast way to notice and no structured way to hand the issue to an agent to fix. Today the signal is buried: [sync_log](src/db/schema.ts) has every attempt with `status` + `error_message`, [get_sync_status](src/mcp/tools/get-sync-status.ts) exposes only a *latest-state* projection, and Viva subscription drift isn't exposed to MCP at all.

**Goal.** Give Claude Cowork (or any MCP-speaking agent) a single tool call that returns *categorized, ranked, remediation-ready findings* about current sync health, so the path is:

> agent calls `diagnose_sync_health` → gets structured findings → user/agent pastes the embedded remediation prompt → fix runs via existing CLI.

**Scope boundary (from user answers).**
- Autonomy: **diagnose + prompt** only. No new write surface. Preserves the "read-only forever, steering-only exception" rule in [CLAUDE.md](CLAUDE.md).
- Trigger: **on-demand via MCP** only. No scheduler, no CLI, no notifications in v1.
- Sources: **all** — Outlook inbox, Outlook sent, Teams, Viva (incl. external tenants), plus auth/account drift.

Implementation itself will go through the mandatory [`/tdd-cycle`](.claude/skills/tdd-cycle/SKILL.md) and will write its own detailed plan under `docs/plans/` at that time. This file captures the design so the TDD cycle starts from a solid target.

## The one new MCP tool

`diagnose_sync_health` — read-only, zero input, structured output.

**File:** `src/mcp/tools/diagnose-sync-health.ts` (+ `.test.ts`) — sibling of existing [get-sync-status.ts](src/mcp/tools/get-sync-status.ts), same shape conventions.

**Output shape:**

```ts
interface DiagnoseSyncHealthResult {
  generatedAt: string;                      // ISO
  overallStatus: "healthy" | "degraded" | "critical";
  summary: {
    totalFindings: number;
    byCategory: Record<FindingCategory, number>;
    bySeverity: Record<FindingSeverity, number>;
  };
  findings: readonly Finding[];             // sorted by severity desc, then account
}

type FindingCategory =
  | "auth"              // TokenExpiredError pattern in lastError
  | "rate-limit"        // GraphRateLimitedError pattern
  | "delta-invalid"     // DeltaTokenInvalidError / "delta" / "resync" pattern
  | "stale"             // lastOkAt > STALE_THRESHOLD_MS old
  | "repeated-failure"  // ≥3 consecutive error rows in sync_log
  | "viva-sub-drift"    // enabled viva_subscription with no successful Viva sync in 24h
  | "never-synced"      // account row exists, no sync_log ever
  | "unknown-error";    // error present but doesn't match any known pattern

type FindingSeverity = "info" | "warn" | "error";

interface Finding {
  id: string;                          // stable e.g. `auth:waldo@dynex.be:teams`
  category: FindingCategory;
  severity: FindingSeverity;
  account: string;
  source?: MessageSource;              // omitted for account-wide findings
  summary: string;                     // one-line human phrasing
  evidence: Record<string, unknown>;   // structured facts (lastOkAt, consecutiveFailures, retryAfterSeconds, tenantId, ...)
  remediationPrompt: string;           // paste-ready agent prompt, self-contained
  remediationCli?: string;             // optional exact CLI the user could run
}
```

**Severity mapping:**
- `error` → `auth`, `delta-invalid`, `repeated-failure (≥5)`, `stale (>6h)`
- `warn` → `rate-limit`, `repeated-failure (3–4)`, `stale (15m–6h)`, `viva-sub-drift`, `never-synced`, `unknown-error`
- `info` → reserved for informational health notes (none in v1)

`overallStatus` = `critical` if any `error` severity, else `degraded` if any `warn`, else `healthy`.

## Detection pipeline (pure, testable)

All classification is **pure** over already-in-memory rows — no new IO paths except two reader methods. Each detector is its own exported function with its own test.

1. **Read inputs** (all read-only):
   - `store.getSyncStatus(now)` — already exists.
   - `store.getSyncLogRecent(limit = 50 per (account, source))` — **new** method on [MessageStore](src/store/message-store.ts); needs a SQLite impl that reads from `sync_log` ordered by `ts DESC`. Testable against `InMemoryMessageStore`.
   - `vivaSubscriptionStore.listAll()` — confirm whether a listAll-style accessor exists in [src/auth/viva-subscription-store.ts](src/auth/viva-subscription-store.ts); if not, add a read-only `listAll()` returning every row regardless of account. In-memory fake already tracks these.
2. **Classify each error string** via a `classifyError(message: string): FindingCategory` pure function, keyed off the error class names emitted by [src/sources/graph.ts](src/sources/graph.ts) (`TokenExpiredError`, `GraphRateLimitedError`, `DeltaTokenInvalidError`). Unknown → `unknown-error`. Verified against real patterns in [http-teams-client.ts](src/sources/http-teams-client.ts) and [http-yammer-client.ts](src/sources/http-yammer-client.ts).
3. **Per (account, source) rollup:**
   - Scan last N `sync_log` rows. Count consecutive trailing errors.
   - Combine with `getSyncStatus` row → emit `auth` / `rate-limit` / `delta-invalid` / `repeated-failure` / `stale` findings. Dedup: prefer most specific category (auth > delta-invalid > repeated-failure > stale > unknown-error).
4. **Viva subscription drift:**
   - For each enabled `viva_subscription` row, find the most recent successful `sync_log` row with `source='viva-engage'` for that account within 24h. If none → `viva-sub-drift` finding keyed on `(account, community_id, tenantId)`. External-tenant subscriptions (non-null `tenant_id`) get higher weight in the summary string.
5. **Never-synced accounts:**
   - `accounts` rows with no `sync_log` history at all → `never-synced`.
6. **Remediation prompt templates** live in `src/mcp/tools/remediation-prompts.ts` (new). Each category has a template that interpolates `{account, source, tenantId, lastError, retryAfterSeconds, ...}`. Tests freeze template output as fixtures so accidental prompt drift is caught.

## Wiring

- Register `DIAGNOSE_SYNC_HEALTH_TOOL` in [src/mcp/http-server.ts](src/mcp/http-server.ts) alongside `GET_SYNC_STATUS_TOOL`: add to tool list, add dispatch case that calls `handleDiagnoseSyncHealth(store, vivaSubStore, clock)`.
- Update the project brief / [PROGRESS.md](PROGRESS.md) to list the new tool (handled by `/docs-update` during the TDD cycle).
- Update [src/mcp/README](src/mcp) or user guide entry if one exists — again, `/docs-update` handles.

## Critical files

**Will be modified:**
- `src/mcp/tools/diagnose-sync-health.ts` (new)
- `src/mcp/tools/diagnose-sync-health.test.ts` (new)
- `src/mcp/tools/remediation-prompts.ts` (new)
- `src/mcp/tools/remediation-prompts.test.ts` (new)
- [src/mcp/http-server.ts](src/mcp/http-server.ts) — tool registration + dispatch
- [src/store/message-store.ts](src/store/message-store.ts) — add `getSyncLogRecent` method to interface
- [src/store/sqlite-message-store.ts](src/store/sqlite-message-store.ts) — SQLite impl of `getSyncLogRecent`
- [src/testing/in-memory-message-store.ts](src/testing/in-memory-message-store.ts) — in-memory impl
- [src/auth/viva-subscription-store.ts](src/auth/viva-subscription-store.ts) — `listAll()` accessor if missing

**Reused as-is** (do not modify):
- [src/mcp/tools/get-sync-status.ts](src/mcp/tools/get-sync-status.ts) — style reference & `STALE_THRESHOLD_MS`
- [src/sources/graph.ts](src/sources/graph.ts) — error-class source of truth
- [src/testing/fake-auth-client.ts](src/testing/fake-auth-client.ts), [fake-graph-client.ts](src/testing/fake-graph-client.ts), [fake-viva-client.ts](src/testing/fake-viva-client.ts) — existing fakes cover all test needs

## RED test list (to be expanded in /tdd-cycle)

1. Empty store → `overallStatus: "healthy"`, `findings: []`.
2. All-ok recent rows → healthy.
3. `lastError` matching TokenExpired pattern → `auth` + severity `error` + remediation prompt mentions `--add-account --tenant`.
4. `lastError` matching rate-limit + `retryAfterSeconds` → `rate-limit` + severity `warn` + evidence contains `retryAfterSeconds`.
5. 3 consecutive error rows in sync_log → `repeated-failure` severity `warn`; 5+ → severity `error`.
6. `lastOkAt` 30min ago → `stale` severity `warn`. 8h ago → severity `error`.
7. Enabled viva_subscription with no successful viva-engage sync in 24h → `viva-sub-drift`; external-tenant drift includes tenant id in summary.
8. Account with zero sync_log history → `never-synced`.
9. Classification precedence: auth wins over stale when both would fire.
10. `overallStatus` aggregation: any `error` → critical; any `warn` → degraded; else healthy.
11. Findings are sorted by severity desc, then account asc, deterministically.
12. Clock injection respected (fake clock drives all "recent" logic).
13. Remediation prompt templates are stable (snapshot-tested).

## Verification (end-to-end)

1. Unit tests: `npm run test -- diagnose-sync-health` — all new suites green.
2. Coverage: ≥90% line + branch on new files per [coverage policy](docs/tdd/coverage-policy.md).
3. Local smoke: run [`/local-smoke`](.claude/skills/local-smoke/SKILL.md) — verify `tools/list` includes `diagnose_sync_health` and a live call returns a result shape matching the contract.
4. Manual agent loop: from Claude Cowork or Claude Code, invoke `diagnose_sync_health` against the running NAS instance at `http://waldonas3.tailb07704.ts.net:8765`. Confirm the returned `remediationPrompt` strings are self-contained enough to hand to a fresh agent session.
5. Inject failure: temporarily corrupt a delta token row in a throwaway DB (via local-smoke's scratch DB) and confirm a `delta-invalid` finding appears with a correct SQL remediation suggestion.
6. Run [`/security-scan`](.claude/skills/security-scan/SKILL.md) — confirm remediation prompts do not leak tokens or bearer secrets from `lastError` strings (sanitize error text before inclusion; add a redaction helper + test).

## Out of scope for v1

- CLI `waldo sync-doctor` command (user chose MCP-only).
- Scheduled/background diagnosis + notifications.
- Auto-remediation (clearing delta tokens, re-running auth). Would require carving a new write-scope exception; revisit after v1 ships and the prompt-paste loop proves its worth.
- Per-chat Teams cursor drift (the `chat_cursors` table). Starting with source-level granularity; chat-level can be a later finding category if real incidents show it matters.
