# Plan: Weekend 8 slice — `diagnose_sync_health` MCP tool

Parent design doc: [docs/plans/done/diagnose-sync-health-mcp-tool.md](diagnose-sync-health-mcp-tool.md).

## Task

Add a read-only `diagnose_sync_health` MCP tool that scans `sync_log`,
`sync_state`, `accounts`, and `viva_subscriptions`, classifies errors
into five failure categories + staleness + never-synced + sub-drift,
and returns a ranked list of findings with a paste-ready remediation
prompt per finding.

## Scope boundary

**IN this slice:**
- Pure classifier `classifyError(message: string): FindingCategory` keyed
  off `TokenExpiredError`, `GraphRateLimitedError`,
  `DeltaTokenInvalidError` class-name patterns, plus literal
  `"Yammer 401"` / `"403 Forbidden"` / `"graph"` fallbacks.
- `MessageStore.getSyncLogRecent(limit)` — returns the most recent N
  rows across every (account, source), ordered `ts DESC`. The detector
  slices per-pair in memory. Added to the shared contract and both
  impls (sqlite + in-memory).
- `VivaSubscriptionStore.listAll()` — returns every row regardless of
  account. Added to the interface + both impls.
- `remediation-prompts.ts` — one pure template function per category,
  stable output (snapshot-tested). Redacts Bearer tokens and long
  opaque strings from `lastError` before interpolation.
- `diagnose-sync-health.ts` — pure handler that takes `store`,
  `vivaSubs`, `clock`, reads inputs, runs the detectors, returns
  `DiagnoseSyncHealthResult` with sorted findings, per-category /
  per-severity summary, and `overallStatus` rollup.
- Wire into `TOOL_DESCRIPTORS` + `TOOL_HANDLERS` in
  [src/mcp/mcp-server.ts](src/mcp/mcp-server.ts) and extend
  `McpServerDeps` with an optional `vivaSubs?: VivaSubscriptionStore`.
  Thread through `createMcpHttpServer` / `main()` so the live server
  receives the real sqlite-backed `vivaSubs`.
- Tool is gated on `vivaSubs` being present: if the deps object does
  not carry it, the handler runs *without* Viva drift detection
  (emitting only the other categories) — no hard crash, no tool
  removal. This keeps unit tests that only pass `store` + `clock`
  green, while the live server always gets the real viva store.

**OUT of this slice (deferred — captured in parent design doc):**
- CLI `waldo sync-doctor` command.
- Per-chat Teams cursor drift (`chat_cursors`).
- Automated remediation / write scope.
- Push notifications or scheduled diagnosis.

## Files to create / touch

**Create:**
- `src/mcp/tools/diagnose-sync-health.ts`
- `src/mcp/tools/diagnose-sync-health.test.ts`
- `src/mcp/tools/remediation-prompts.ts`
- `src/mcp/tools/remediation-prompts.test.ts`
- `src/mcp/tools/classify-error.ts`
- `src/mcp/tools/classify-error.test.ts`

**Modify:**
- [src/store/message-store.ts](src/store/message-store.ts) — add
  `getSyncLogRecent(limit: number)` to the interface.
- [src/store/sqlite-message-store.ts](src/store/sqlite-message-store.ts)
  — implement it: `SELECT … FROM sync_log ORDER BY ts DESC LIMIT ?`.
- [src/testing/in-memory-message-store.ts](src/testing/in-memory-message-store.ts)
  — in-memory impl (slice + sort of `syncLog`).
- [src/store/message-store-contract.ts](src/store/message-store-contract.ts)
  — contract tests for `getSyncLogRecent`.
- [src/store/viva-subscription-store.ts](src/store/viva-subscription-store.ts)
  — add `listAll(): Promise<readonly VivaSubscription[]>` to the
  interface + sqlite impl.
- [src/testing/in-memory-viva-subscription-store.ts](src/testing/in-memory-viva-subscription-store.ts)
  — in-memory impl of `listAll`.
- [src/store/viva-subscription-store-contract.ts](src/store/viva-subscription-store-contract.ts)
  — contract test for `listAll`.
- [src/mcp/mcp-server.ts](src/mcp/mcp-server.ts) — register the tool,
  add `vivaSubs?` to deps.
- [src/mcp/http-server.ts](src/mcp/http-server.ts) — accept and
  forward `vivaSubs?: VivaSubscriptionStore`.
- [src/index.ts](src/index.ts) — pass the already-constructed
  `vivaSubs` into `createMcpHttpServer`.
- [docs/user-guide.md](docs/user-guide.md) +
  [docs/claude-desktop-wiring.md](docs/claude-desktop-wiring.md) —
  advertise the 6-tool v1 surface (→ handled by `/docs-update`).
- [docs/changelog.md](docs/changelog.md) — entry (→ `/docs-update`).

## Seams involved

store (adds one read method) · viva subscription store (adds one read
method) · clock · mcp-server wiring · http-server wiring.

No new IO seams, no Graph/MSAL/fs contact.

## Output contract (stable, test-fixed)

```ts
interface DiagnoseSyncHealthResult {
  readonly generatedAt: string;                     // ISO
  readonly overallStatus: "healthy" | "degraded" | "critical";
  readonly summary: {
    readonly totalFindings: number;
    readonly byCategory: Record<FindingCategory, number>;
    readonly bySeverity: Record<FindingSeverity, number>;
  };
  readonly findings: readonly Finding[];            // sorted
}

type FindingCategory =
  | "auth"
  | "rate-limit"
  | "delta-invalid"
  | "stale"
  | "repeated-failure"
  | "viva-sub-drift"
  | "never-synced"
  | "unknown-error";

type FindingSeverity = "info" | "warn" | "error";

interface Finding {
  readonly id: string;                              // stable dedup key
  readonly category: FindingCategory;
  readonly severity: FindingSeverity;
  readonly account: string;
  readonly source?: MessageSource;
  readonly summary: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly remediationPrompt: string;
  readonly remediationCli?: string;
}
```

**Severity mapping** (derived in the tool, not returned as a constant):
- `error`: `auth`, `delta-invalid`, `repeated-failure` with
  `consecutiveFailures ≥ 5`, `stale` with `staleMs > 6h`.
- `warn`: `rate-limit`, `repeated-failure` with 3–4, `stale` with
  15m–6h, `viva-sub-drift`, `never-synced`, `unknown-error`.
- `info`: reserved; nothing in v1 emits it.

**Aggregation**: any `error` → `critical`; else any `warn` →
`degraded`; else `healthy`.

**Sort order**: `severity` (error > warn > info) descending, then
`account` ascending, then `source` ascending (undefined sorts last),
then `category` ascending — fully deterministic.

**Dedup precedence** (per `(account, source)` pair):
`auth` > `delta-invalid` > `rate-limit` > `repeated-failure` > `stale`
> `unknown-error`. `viva-sub-drift` and `never-synced` emit in
parallel, not deduped with per-pair findings.

## Detection details

1. Collect `rows = store.getSyncStatus(now)` and
   `logs = store.getSyncLogRecent(500)`, group `logs` by
   `account::source`, sort each group by `ts DESC`.
2. For each `rows[i]`:
   - If `lastStatus === "error"`:
     - Classify `lastError` → `cat`.
     - If `cat === "unknown-error"` and the trailing consecutive-error
       count from the grouped logs ≥ 3 → emit `repeated-failure`
       instead (more actionable than "unknown-error").
     - Else emit a finding of category `cat`. For `rate-limit`, parse
       `retryAfterSeconds` off `GraphRateLimitedError`'s message
       (`"graph rate limited, retry after <N>s"`). For `auth` /
       `delta-invalid` no extra fields beyond the lastError.
   - Else if `lastOkAt === undefined` → (handled by `never-synced`
     downstream, not here).
   - Else if `stale` (same 15-min threshold as `get_sync_status`): pick
     severity by `now - lastOkAt` (`> 6h` → error, else warn). Emit
     `stale`.
3. `never-synced`: for each `store.listAccounts()` row whose
   `(username, *)` has zero rows in `logs` AND zero rows in the
   `getSyncStatus` output → emit one `never-synced` per account
   (not per source; sources aren't known until a tick runs).
4. `viva-sub-drift`: for each enabled `viva_subs.listAll()` row, if
   there is no `logs` entry with `source === "viva-engage"` and
   `status === "ok"` within the last 24 h for that account → emit
   one `viva-sub-drift` keyed on `(account, communityId)`. When
   `tenantId` is present, the summary string notes "external
   tenant".
5. Wire summary/aggregation/sort.

## RED test list

Tests are grouped by file. Every AC below maps 1:1 to a named test.

### `src/mcp/tools/classify-error.test.ts`

- AC-C1: `classifyError(msg)` returns `"auth"` for
  `"TokenExpiredError: Yammer 401"`.
  - edge: bare `"Yammer 401"` → `"auth"`.
- AC-C2: returns `"auth"` for `"Graph 401"` / `"401 unauthorized"`.
- AC-C3: returns `"rate-limit"` for
  `"graph rate limited, retry after 42s"`.
- AC-C4: returns `"rate-limit"` when `Retry-After`-style text is
  present.
- AC-C5: returns `"delta-invalid"` for
  `"DeltaTokenInvalidError: …"` and for messages containing
  `"resync required"` / `"410 Gone"`.
- AC-C6: returns `"unknown-error"` for empty string and for
  unmatched text like `"ENETDOWN"`.
- AC-C7: `extractRetryAfterSeconds(msg)` parses the `N` from
  `"retry after Ns"` and returns `undefined` otherwise.

### `src/mcp/tools/remediation-prompts.test.ts`

- AC-R1: `buildRemediationPrompt("auth", { account, source, tenantId?
  })` mentions `--add-account` and interpolates account + tenant.
- AC-R2: `delta-invalid` prompt mentions that a full resync is needed
  and names the exact `sync_state` row the user could clear.
- AC-R3: `rate-limit` prompt cites the parsed `retryAfterSeconds` when
  present and offers a "wait and retry" default when absent.
- AC-R4: `stale` prompt surfaces last-ok timestamp + "check the
  scheduler" hint.
- AC-R5: `repeated-failure` prompt surfaces consecutive-failures count.
- AC-R6: `viva-sub-drift` prompt surfaces community + tenant (external
  tenant labelled) + "check Yammer consent" hint.
- AC-R7: `never-synced` prompt surfaces "scheduler has not yet run
  for this account" + "check logs".
- AC-R8: Every prompt redacts `Bearer <token>` substrings and long
  base64-ish blobs from any interpolated `lastError`.

### `src/store/message-store-contract.ts` — extended

- AC-S1: `getSyncLogRecent(limit)` returns [] on an empty store.
- AC-S2: returns the N most recent entries globally, `ts DESC`
  ordered.
- AC-S3: ties on `ts` break by insertion order (in-memory: array
  index; sqlite: `rowid DESC`).
- AC-S4: respects `limit: 0` → returns [].

### `src/store/viva-subscription-store-contract.ts` — extended

- AC-V1: `listAll()` returns [] on an empty store.
- AC-V2: `listAll()` returns every row across accounts, sorted
  `(account ASC, communityId ASC)` for determinism.

### `src/mcp/tools/diagnose-sync-health.test.ts`

- AC-D1: empty store + no accounts + no subs → `overallStatus:
  "healthy"`, `findings: []`, `summary.totalFindings: 0`.
- AC-D2: one ok row in the last minute → `healthy`, zero findings.
- AC-D3: `TokenExpiredError` as `lastError` → one `auth` finding,
  severity `error`, `overallStatus: "critical"`, prompt mentions
  `--add-account`.
- AC-D4: `GraphRateLimitedError(retryAfter=42)` → one `rate-limit`
  finding, severity `warn`, evidence carries `retryAfterSeconds: 42`,
  `overallStatus: "degraded"`.
- AC-D5: `DeltaTokenInvalidError` → one `delta-invalid` finding,
  severity `error`, `overallStatus: "critical"`.
- AC-D6: three consecutive error rows with unclassifiable messages →
  one `repeated-failure` finding, severity `warn`.
- AC-D7: five consecutive error rows → `repeated-failure` severity
  `error`.
- AC-D8: last ok was 30 min ago → `stale` severity `warn`.
- AC-D9: last ok was 8 h ago → `stale` severity `error`.
- AC-D10: enabled viva subscription, no viva-engage ok in the last
  24 h → one `viva-sub-drift` finding keyed on
  `(account, communityId)`; external-tenant variant includes
  `tenantId` in evidence + summary string.
- AC-D11: account row with no sync_log history and no sync_state →
  one `never-synced` finding per account.
- AC-D12: precedence — `auth` error wins over `stale` when both would
  fire for the same pair; findings list contains the `auth` finding
  only.
- AC-D13: aggregation — overallStatus = `critical` if any `error`,
  `degraded` if only `warn`, `healthy` otherwise; verified with a
  mixed fixture.
- AC-D14: findings are sorted by (severity desc, account asc, source
  asc, category asc); fixture with deliberately shuffled emit order.
- AC-D15: `generatedAt` honours the injected clock.
- AC-D16: `DIAGNOSE_SYNC_HEALTH_TOOL` descriptor is a zero-input tool
  named `diagnose_sync_health`; description warns it is read-only
  and that `remediationPrompt` is paste-ready.
- AC-D17: handler run without `vivaSubs` (undefined) does not throw,
  emits no `viva-sub-drift` findings, other categories still emit.
- AC-D18: evidence on every finding includes `account`,
  `generatedAt`, and the primary category-specific fact (e.g.
  `lastError` redacted, `staleMs`, `consecutiveFailures`,
  `communityId`, `retryAfterSeconds`).
- AC-D19: Bearer tokens embedded in `lastError` are redacted before
  surfacing in both `evidence.lastError` and `remediationPrompt`.

### `src/mcp/mcp-server.test.ts`

- AC-W1: `tools/list` includes `diagnose_sync_health`.
- AC-W2: `tools/call` dispatches to the handler and wraps
  result in the standard `content: [{ type: "text", text: JSON }]`
  envelope.

## Open questions / assumptions

- **Assumption — classify lives in `src/mcp/tools/`**, not
  `src/store/`, because it consumes only string text (no storage
  coupling). Matches `body-projection.ts` precedent.
- **Assumption — redaction uses the existing token-redaction pattern
  in `http-yammer-client.ts`** (regex replace the Bearer value with
  `[REDACTED]`). A dedicated helper `redactSecretsFromError(s)` lives
  in `remediation-prompts.ts` and is pure, snapshot-tested.
- **Assumption — sync_log row fetch capped at 500 globally**. With 4
  accounts × 4 sources × 5-min ticks, 500 rows ≈ 25 h of history per
  pair on average, comfortably past the 24 h window.
- **Assumption — `getSyncStatus` already exposes `lastError`**, so the
  tool does not need to re-fetch the latest error string from
  `sync_log`. Confirmed in [types.ts:51](src/store/types.ts).
- **Open — Should `never-synced` honour accounts that only appear in
  the MSAL cache but haven't yet been `upsertAccount`'d?** Decision:
  **no**. We drive off `store.listAccounts()` since that is the
  authoritative post-tick registration; pre-tick accounts are by
  definition still warming up and would be noisy.
- **Open — Should the tool's description tell Claude to call
  `get_thread` / `list_accounts` after a finding?** Decision: **no**
  for v1. The `remediationPrompt` already names the exact CLI step,
  which is the whole point of this tool.

## Risks

- Over-triggering `unknown-error` on transient network blips that
  resolve on the next tick. Mitigation: the `repeated-failure`
  promotion (AC-D6) absorbs the real drift, leaving single-tick
  glitches at `warn` but still emitted — acceptable for a read-only
  tool.
- False `viva-sub-drift` during the initial 24 h after subscribing
  before the first successful tick. Mitigation: `subscribedAt` check
  — if `subscribedAt > now - 24h`, suppress (tested via AC-D10 fixture
  variant; add a specific AC-D10a "suppressed during grace period").
- Schema drift if a future migration adds new `sync_log` columns.
  Mitigation: `getSyncLogRecent` selects only the columns defined on
  `SyncLogEntry`; new columns are ignored by design.

## Out-of-scope follow-ups

- CLI `waldo sync-doctor` parity (invoke the handler from the CLI,
  pretty-print a table) — follow-up after live use validates the
  output shape.
- Push `diagnose_sync_health` into a cron/scheduler with severity-based
  notifications — blocked on a separate push/notification slice.
- Per-chat Teams cursor drift (`chat_cursors`) — starting at
  source-level granularity per parent design doc.
- Auto-remediation (clearing delta tokens, forcing re-auth) — would
  require carving a new write-scope exception per
  [CLAUDE.md](CLAUDE.md); revisit after v1 ships.
