# Fix: WhatsApp thread bifurcation from filename-derived threadId

> **Correction (2026-04-21)** — Slice 2's normalization rule as drafted
> below ("strip a trailing ` (…)` suffix") was **wrong**. WhatsApp uses
> `General chat` as a placeholder *prefix* when exporting a named
> group, so the paren content is the real identity — not a
> disambiguator to discard. The actual rule shipped is in
> [fix-whatsapp-normalize-rule.md](fix-whatsapp-normalize-rule.md):
> (a) strip trailing numeric counter `(N)` from re-export filenames,
> and (b) unwrap `General chat (<name>)` to `<name>` when the paren
> content is non-empty and non-numeric. Read Slice 2 below knowing the
> rule semantics were replaced before any of this shipped.

## Context

A user reported `get_thread` and `get_recent_activity` returning contradictory data for the WhatsApp "General chat" thread: recent activity showed April 20–21 messages; the thread dump's newest message was April 9. Investigation confirms both tools read the **same** `MessageStore` — there is no second write path.

**Root cause** — WhatsApp thread identity is filename-derived and not normalized:

- [src/sync/whatsapp-map.ts:39-40](../../src/sync/whatsapp-map.ts#L39-L40) sets `threadId = threadName = parsed.chat`.
- `parsed.chat` is the chat name derived in [src/sync/import-whatsapp.ts:71-75](../../src/sync/import-whatsapp.ts#L71-L75) via `CHAT_FILENAME_RE = /^WhatsApp Chat - (.+)\.(?:txt|zip)$/`. Filename format in the wild: `WhatsApp Chat - <chat name>.zip` (zip contains `_chat.txt`).
- Two re-exports of the **same logical conversation** under different filenames produce **two different `threadId` values**. Messages imported on each run land under their own threadId; neither thread sees the other's messages.
- [src/store/sqlite-message-store.ts:287-303](../../src/store/sqlite-message-store.ts#L287-L303) `getThread` filters by exact `thread_id = ?`, so once the thread bifurcates, `get_thread` can only ever show one half.

**Contributing factor** — `get_thread`'s [description](../../src/mcp/tools/get-thread.ts#L42-L50) tells callers to pass the opaque `threadId` from a prior tool result, and `get_recent_activity` does project it ([get-recent-activity.ts:149](../../src/mcp/tools/get-recent-activity.ts#L149)). If the caller invented `"General chat"` literally instead of round-tripping, they'd exact-match the *older* bifurcated thread.

**Intended outcome** — re-exports of the same logical WhatsApp conversation converge into one thread, existing bifurcated data is healed by a migration, and operators can list distinct WhatsApp threads without dropping to raw SQL.

## User decisions (locked)

1. **Filename format** — `WhatsApp Chat - <chat name>.zip` (or `.txt`), zip contains `_chat.txt`. No other variants.
2. **Canonical `threadName`** — on re-export, the stored `threadName` follows the **latest** import.
3. **Scope** — all three slices landed in one go, each its own `/tdd-cycle`.

## Slice 1 — Diagnostic: `list_threads` MCP tool

Smallest, lowest-risk. Gives operators visibility into bifurcations in the live lake before and after the migration.

- Add `MessageStore.listThreadSummaries({ source })` returning `{ threadId, threadName, messageCount, newestSentAt, oldestSentAt }[]`, sorted by `newestSentAt` desc. Skip rows with `thread_id IS NULL`.
- New MCP tool `list_threads` with params `{ source: "whatsapp" | "teams" | "outlook" }`. Read-only, no Graph impact. Steering rules do NOT filter this tool (consistent with `get_thread` / `list_accounts`).
- Files: [src/store/message-store.ts](../../src/store/message-store.ts), [src/store/sqlite-message-store.ts](../../src/store/sqlite-message-store.ts), new [src/mcp/tools/list-threads.ts](../../src/mcp/tools/list-threads.ts), register in [src/mcp/mcp-server.ts](../../src/mcp/mcp-server.ts).
- RED tests: one entry per distinct `(source, threadId)`; ordered newest-first; counts+name populated; unknown source rejected with `InvalidParamsError`; e2e `tools/list` includes `list_threads`.

## Slice 2 — Normalize WhatsApp threadId at import

Converge re-exports so future imports don't bifurcate.

- Add `normalizeWhatsAppChatName(raw: string): string` in [src/sync/whatsapp-map.ts](../../src/sync/whatsapp-map.ts):
  1. Trim leading/trailing whitespace.
  2. Collapse runs of whitespace to a single space.
  3. Strip a trailing ` (…)` suffix (space + parenthesized free-form label at end of string). Example: `"General chat (BC Dev Talk)"` → `"General chat"`. This is the shape we expect from WhatsApp group-rename exports.
  4. Case-preserving. No lowercasing (WhatsApp names are case-meaningful, e.g. "Dad" vs "dad" would be different people).
- `threadId` = normalized name. `threadName` = **raw** parsed chat name (latest wins on re-import because `upsertMessages` overwrites by id).
- `hashWhatsAppId` uses the **normalized** chat so the message `id` is stable across re-exports with different parenthetical suffixes.
- RED tests: two messages with identical `(sender, sentAt, body)` under `"General chat"` and `"General chat (BC Dev Talk)"` produce identical `id` and identical `threadId`, different `threadName`; trim+collapse idempotent on already-clean names; empty-string input returns empty string (no crash); leading whitespace + parenthetical handled; single parenthetical name like `"(Family)"` is **not** stripped (rule only fires if there's non-paren content before the suffix).

## Slice 3 — Migration: `whatsapp-rethread`

Heal bifurcated WhatsApp threads in the live lake.

- New migration under [docs/migrations/](../migrations/) named `whatsapp-rethread.md` + registered entry.
- Algorithm (single transaction):
  1. `SELECT DISTINCT thread_id FROM messages WHERE source = 'whatsapp' AND thread_id IS NOT NULL`.
  2. Group by `normalizeWhatsAppChatName(thread_id)`.
  3. For each group with > 1 raw id: pick canonical name = raw `thread_name` from the row with the highest `imported_at` among that group; for every message in the group rewrite `thread_id` ← normalized, `thread_name` ← canonical, and recompute `id` via `hashWhatsAppId`. On id collision (duplicate content across exports) keep the row with the higher `imported_at`.
  4. Count collisions, merged rows, duplicates dropped; print summary.
- `--dry-run` prints per-collision diff (raw ids → normalized, row counts) and writes nothing. Wired via `/deploy-nas --migrate whatsapp-rethread --dry-run`.
- RED tests: seeded SQLite with `"General chat"` + `"General chat (BC Dev Talk)"` merges into one `"General chat"` thread with union of messages; duplicate `(sender, sentAt, body)` across both exports yields a single row (higher `imported_at` wins); distinct unrelated threadIds untouched; re-running the migration is a no-op; dry-run writes nothing.

## Out of scope

- Fuzzy matching in `get_thread` (LIKE / threadName fallback). Would mask the root cause.
- Adding `whatsapp-local` to `get_sync_status` output — adjacent observability hole, its own plan.
- Teams/Outlook threadId — platform-issued and stable; no normalization needed.

## Critical files

- [src/sync/whatsapp-map.ts](../../src/sync/whatsapp-map.ts) — mapping + id hashing (Slice 2)
- [src/store/sqlite-message-store.ts](../../src/store/sqlite-message-store.ts) — `getThread`, new `listThreadSummaries`
- [src/store/message-store.ts](../../src/store/message-store.ts) — interface addition
- [src/mcp/mcp-server.ts](../../src/mcp/mcp-server.ts) — tool registration
- [src/mcp/tools/list-threads.ts](../../src/mcp/tools/list-threads.ts) — new tool
- [docs/migrations/whatsapp-rethread.md](../migrations/whatsapp-rethread.md) — migration runbook
- Migration registry (discover during Slice 3, look at [docs/deploy-backfill-bodies.md](../deploy-backfill-bodies.md) and existing `--migrate` wiring in `/deploy-nas`)

## Verification

- `npm test` covers unit + integration per slice.
- After Slice 1: `list_threads({source:"whatsapp"})` against live lake via `/local-smoke` + Claude Desktop shows the two bifurcated "General chat" variants with different date ranges.
- After Slice 2 deploy but before Slice 3: next fresh WhatsApp export with a parenthetical suffix lands under the normalized `threadId` (still bifurcated from legacy data until migration runs).
- After Slice 3 migration: `list_threads` returns one row for the merged thread; `get_thread` with the normalized id returns messages spanning April 9 through April 21.
- Coverage: ≥90% line+branch on all touched files per [docs/tdd/coverage-policy.md](../tdd/coverage-policy.md).
