# waldo.WTF — Progress

Tracks the build plan from `waldo.WTF-project-brief.md` §7. Tick boxes as you go.
Keep notes terse — one line per surprise, gotcha, or decision worth remembering.

---

## Weekend 0 — Spike ✅ (2026-04-12)

- [x] MSAL device code flow, multitenant app registration
- [x] Graph `Mail.Read` delegated consent (dynex.be, no admin consent needed)
- [x] better-sqlite3 + WAL mode
- [x] Token cache persistence (`token-cache.json`)
- [x] Single account end-to-end: `eric.wauters@dynex.be`

---

## Weekend 1 — Delta + second account (in progress)

### Delta queries ✅ (2026-04-13)
- [x] Switch `/messages` → `/messages/delta`
- [x] Persist `@odata.deltaLink` per account (`delta-state.json`)
- [x] Handle `@odata.nextLink` paging
- [x] Handle `@removed` (delete from lake)
- [x] Verified: run 1 = full sync (724 pages, 36154 msgs); run 2 = +0/-0

**Notes:**
- Delta initial sync ignores `$top` — pulls entire inbox. Expected, wanted for a lake.
- `Prefer: odata.maxpagesize=50` keeps pages reasonable.
- Delta endpoint ignores `$orderby`; only `$select` + `receivedDateTime ge ...` filter honored on first call.

### Second account ✅ (2026-04-13)
- [x] Trigger a second `acquireTokenByDeviceCode` (force interactive even when cache has one account)
- [x] Verify MSAL routes silent refresh per-account correctly
- [x] Loop `syncInbox` over all cached accounts
- [x] Confirm `delta-state.json` has one entry per account after run

**Notes:**
- Authority must be `common` (not a specific tenant GUID) for cross-tenant accounts to log in.
- `--add-account` flag on spike.js forces interactive login even when cache is non-empty.
- Verified with eric.wauters@dynex.be + waldo@turnhoutbasketbal.onmicrosoft.com: run 1 = +162 for new account, +0/-0 for existing.

### Learning log (edge cases to note as they appear)
- _add findings here during the weekend_

---

## Weekend 2 — Graduate to TypeScript project

TDD toolkit is ready — see [CLAUDE.md](CLAUDE.md), [docs/tdd/](docs/tdd/), [testing/](testing/). Every code change from Weekend 2 onward runs through `/tdd-cycle` (`.claude/skills/tdd-cycle/SKILL.md`).

Scaffold **in-place** in this repo (`/Users/waldo/SourceCode/Community/waldo.WTF/`). The spike stays untouched at `/Users/waldo/Temp/waldo-wtf-spike` and is **reference only** — never copy-paste.

- [x] `npm init`, `tsconfig.json`, `tsx` for dev (at repo root) — 2026-04-13
- [x] Copy [testing/vitest.config.ts](testing/vitest.config.ts) + merge [testing/package.deps.json](testing/package.deps.json) into `package.json` — 2026-04-13
- [x] Port example fakes from [testing/examples/](testing/examples/) into `src/testing/` (clock + fs + graph) — fs: 2026-04-13, graph: 2026-04-13
- [x] First RED test before any production code (run `/tdd-cycle`) — 2026-04-13 (`FakeClock` contract tests)
- [x] Folder structure (`src/auth`, `src/sources`, `src/store`, `src/sync`, `src/mcp`, `src/config.ts`, `src/index.ts`) — 2026-04-13 (pure `loadConfig` + stub `main()`; 11 tests, 100% coverage)
- [ ] Port spike logic from `/Users/waldo/Temp/waldo-wtf-spike` — **reference, don't copy-paste**
  - [x] Auth seam: `AuthClient` interface, `FakeAuthClient`, `TokenCacheStore` (fs-backed, atomic write, mode 0o600) — 2026-04-13. Real MSAL adapter landed 2026-04-13 ([src/auth/msal-auth-client.ts](src/auth/msal-auth-client.ts)) — `@azure/msal-node` wrapped behind injectable PCA seam; live login remains a manual smoke step.
  - [x] Store seam: `Message`/`SyncStateEntry` types (mirror brief §5), `MessageStore` interface (`upsertMessages`, `deleteMessages`, `get`/`setSyncState`), `InMemoryMessageStore` fake — 2026-04-13.
  - [x] Real `SqliteMessageStore` (`better-sqlite3`, `messages` + `sync_state` tables, WAL via `openDatabase`, transactional upserts) — 2026-04-13. `accounts` / `sync_log` / FTS5 / query ops still pending.
  - [x] `accounts` + `sync_log` tables behind `PRAGMA user_version=1` migration ([src/store/schema.ts](src/store/schema.ts)); `MessageStore` extended with `appendSyncLog` / `upsertAccount` / `listAccounts` on both impls — 2026-04-13. FTS5 still pending (slice 9).
  - [x] FTS5 `messages_fts` virtual table + ai/ad/au triggers + v1→v2 migration with backfill ([src/store/schema.ts](src/store/schema.ts)); `searchMessages(query, limit)` on `MessageStore` (BM25-ranked + `snippet()` in sqlite, naive substring in fake); FTS5 input escaped to a quoted phrase via `toFts5Phrase` — 2026-04-13.
- [x] Real schema (full `messages` table incl. `raw_json`, `sync_state`, `sync_log`, `accounts`, FTS5)
- [x] 5-minute sync loop writing to `sync_log` — 2026-04-13. `syncInbox` + `SyncScheduler` ([src/sync/](src/sync/)) with injected `setTimer`, per-account ok/error rows, overlap-tick skip. Real HTTP `GraphClient` landed 2026-04-13 ([src/sources/http-graph-client.ts](src/sources/http-graph-client.ts)) — `fetch`-backed, 401/410/429 mapping, token-redacted errors. Live smoke still pending.
- [x] Skeleton HTTP MCP server (transport only, no tools yet) — 2026-04-13. `node:http`, `/health` bypass, `crypto.timingSafeEqual` bearer check, 404 fall-through ([src/mcp/http-server.ts](src/mcp/http-server.ts)).
- [x] `.env`: `MS_CLIENT_ID`, `BEARER_TOKEN` (plus `WALDO_PORT`, `WALDO_SYNC_INTERVAL_MS`) — 2026-04-13. `dotenv`-loaded in `main()`; template in [.env.example](.env.example).

---

## Weekend 3 — First MCP tools + Claude Desktop wiring ✅ (2026-04-13)

- [x] `@modelcontextprotocol/sdk` installed — 2026-04-13. Hand-rolled JSON-RPC dispatcher replaced by SDK `Server` + `StreamableHTTPServerTransport` (stateless). New [src/mcp/mcp-server.ts](src/mcp/mcp-server.ts) wraps the three existing tool handlers into MCP content blocks and maps `InvalidParamsError` → `McpError(InvalidParams)`. [src/mcp/http-server.ts](src/mcp/http-server.ts) is now a thin shell: `/health` + bearer middleware + per-request SDK transport mount. Plan: [docs/plans/done/adopt-mcp-sdk.md](docs/plans/done/adopt-mcp-sdk.md).
- [x] `get_recent_activity(hours, sources?, accounts?)` — 2026-04-13. Handler in [src/mcp/tools/get-recent-activity.ts](src/mcp/tools/get-recent-activity.ts); backed by new `MessageStore.getRecentMessages`; JSON-RPC dispatch wired into [src/mcp/http-server.ts](src/mcp/http-server.ts). 30 new tests, 201 total.
- [x] `get_sync_status()` — 2026-04-13. Handler in [src/mcp/tools/get-sync-status.ts](src/mcp/tools/get-sync-status.ts); backed by new `MessageStore.getSyncStatus(now)` (union of `sync_state` ∪ `sync_log` per pair, with `lastOkAt` / `lastStatus` / `messagesAddedLast24h`). 15-min `stale` threshold, top-level `staleCount`. http-server dispatch refactored to a `{name → handler}` map. 28 new tests, 229 total.
- [x] Bearer token middleware — Weekend 2 slice 10 (pre-existing; still in effect for `POST /`).
- [x] Wired into Claude Desktop (`http://localhost:PORT`) — 2026-04-13. Operator recipe at [docs/claude-desktop-wiring.md](docs/claude-desktop-wiring.md): prereqs, `curl /health` + JSON-RPC `tools/list` verification, config snippet, troubleshooting table, security notes. Linked from [getting-started.md §6](docs/getting-started.md).
- [x] End-to-end test: *"summarize my mail from the last 24 hours"* — 2026-04-13. [src/mcp/e2e-http.test.ts](src/mcp/e2e-http.test.ts) drives the full stack (real `SqliteMessageStore` `:memory:` + FTS5 + real `fetch`) through `tools/list`, `get_recent_activity` (24h window), `search`, `get_sync_status`, and unauth rejection. 5 tests, green on first run.
- [x] `search` tool (FTS5) — 2026-04-13. [src/mcp/tools/search.ts](src/mcp/tools/search.ts) wraps the slice-9 `MessageStore.searchMessages`; validates non-empty query + `limit ∈ (0,100]` (default 20); projects hits to drop body/rawJson while preserving BM25 `rank` + `snippet`. 11 handler tests, 245 total.

---

## Weekend 4 — Multi-account + Teams

### Slice 1 — Interactive login CLI ✅ (2026-04-13)
- [x] `runCli(argv)` + `addAccount(opts)` in [src/cli.ts](src/cli.ts); `--add-account` drives `MsalAuthClient.loginWithDeviceCode` against the real `TokenCacheStore`. Live smoke still required per-account. Plan: [docs/plans/done/weekend-4-slice-1-interactive-login-cli.md](docs/plans/done/weekend-4-slice-1-interactive-login-cli.md).

### Slice 2 — Teams message shape + schema v3 ✅ (2026-04-13)
- [x] `Message.chatType` / `replyToId` / `mentions` (optional); schema v3 migration adds `chat_type`, `reply_to_id`, `mentions_json` columns; both store impls roundtrip the fields. FTS5 untouched. Plan: [docs/plans/done/weekend-4-slice-2-teams-schema-v3.md](docs/plans/done/weekend-4-slice-2-teams-schema-v3.md).

### Slice 3 — `TeamsClient` seam + `FakeTeamsClient` ✅ (2026-04-13)
- [x] Interface + DTOs in [src/sources/teams.ts](src/sources/teams.ts); scripted fake in [src/testing/fake-teams-client.ts](src/testing/fake-teams-client.ts). Plan: [docs/plans/done/weekend-4-slice-3-teams-client-seam.md](docs/plans/done/weekend-4-slice-3-teams-client-seam.md).

### Slice 4 — `HttpTeamsClient` ✅ (2026-04-13)
- [x] Fetch-backed adapter [src/sources/http-teams-client.ts](src/sources/http-teams-client.ts); 401/410/429 mapping + token-redacted errors. Plan: [docs/plans/done/weekend-4-slice-4-http-teams-client.md](docs/plans/done/weekend-4-slice-4-http-teams-client.md).

### Slice 5 — `syncTeams` + scheduler wiring ✅ (2026-04-13)
- [x] [src/sync/sync-teams.ts](src/sync/sync-teams.ts) walks Teams delta, maps → `Message`, routes `@removed`, persists `setSyncState({source:"teams"})`. `SyncScheduler` now takes optional `teams: TeamsClient` and emits a second `sync_log` row per account per tick. `src/index.ts` wires real `HttpTeamsClient`. Plan: [docs/plans/done/weekend-4-slice-5-sync-teams.md](docs/plans/done/weekend-4-slice-5-sync-teams.md).

### Slice 6 — MCP tool coverage for Teams source ✅ (2026-04-13)
- [x] `get_recent_activity` + `search` projections carry `chatType` / `replyToId` / `mentions`; snippet falls back to `bodyHtml` when `body` absent. `get_sync_status` verified against a mixed outlook+teams log. Weekend 4 closed. Plan: [docs/plans/done/weekend-4-slice-6-mcp-teams-coverage.md](docs/plans/done/weekend-4-slice-6-mcp-teams-coverage.md).

### Retrofit — `rawJson` population ✅ (2026-04-13)
- [x] `syncInbox` + `syncTeams` mappers now stringify the raw DTO into `Message.rawJson` on upsert, closing the brief §4.10 insurance-policy gap. Column existed since Weekend 2 but sync writers never set it; pre-retrofit rows remain `rawJson=NULL` until delta resync naturally overwrites them (no migration). Plan: [docs/plans/done/fix-raw-json-population.md](docs/plans/done/fix-raw-json-population.md).

- [x] Remaining Microsoft accounts logged in (iFacto, customer tenants, personal) — uses `tsx src/cli.ts --add-account` (Slice 1) ✅ (2026-04-19)
- [x] Open Q: do all 4 support delegated `Mail.Read` without admin consent? ✅ (2026-04-19) — resolved in practice by completing the logins above
- [x] Teams source: `/me/chats/getAllMessages` with delta — superseded by the endpoint rework below; delegated `getAllMessages/delta` returns 412, so `/me/chats` + per-chat messages shipped instead
- [x] Teams quirks: chat vs channel, reply threading, mentions — shipped as `chatType` / `replyToId` / `mentions` in schema v3 and all three MCP tool projections (Weekend 4 slice 2 + slice 6)
- [x] Claude Desktop system prompt: "always check all accounts + both sources" — [docs/user-guide.md §3](docs/user-guide.md)
- [x] Live with it for a week, collect frustrations below ✅ (2026-04-19) — smoke-tested across real accounts + Teams + Outlook, no new frustrations surfaced beyond the Teams 412 (already fixed)

### Teams endpoint rework — slice 1 ✅ (2026-04-13)
- [x] Schema v4 `chat_cursors` table + `MessageStore.getChatCursor` / `setChatCursor` / `listChatCursors` on both impls. Storage-only slice; seam reshape + `HttpTeamsClient` rewrite + `syncTeams` rewrite are slice 2. Plan: [docs/plans/done/teams-endpoint-rework.md](docs/plans/done/teams-endpoint-rework.md).

### Teams endpoint rework — slice 2 ✅ (2026-04-13)
- [x] `TeamsClient` seam reshaped to `listChats` + `getChatMessages`; `HttpTeamsClient` rewritten to poll `/me/chats` + `/me/chats/{id}/messages` under delegated auth; `syncTeams` rewritten to enumerate chats and maintain per-chat cursors with per-chat error isolation; schema v5 renames `chat_cursors.last_modified_iso → cursor`. Live smoke on dev db: one account synced Teams successfully (96 messages, 13 chat cursors), the other returned `403 Forbidden — Missing scope permissions` (tenant-level policy, correctly logged). Outlook unaffected. Plan: [docs/plans/done/teams-endpoint-rework.md](docs/plans/done/teams-endpoint-rework.md).

**Frustrations log:**
- 2026-04-13 — First live smoke of Teams sync (two real accounts across two tenants) surfaced `HTTP 412 PreconditionFailed — Requested API is not supported in delegated context` on `/me/chats/getAllMessages/delta`. Pre-existing Graph constraint (the endpoint requires application permissions + RSC, not delegated device-code). Slices 4–6 used `FakeTeamsClient` end-to-end so it only showed up on the first real tick. Outlook unaffected and shipping. Fix plan: [docs/plans/done/teams-endpoint-rework.md](docs/plans/done/teams-endpoint-rework.md) — recommends polling `/me/chats` + `/me/chats/{id}/messages` under the existing delegated flow.

---

## Weekend 4.5 — Finish v1 MCP surface

Brief §6 lists four tools in the v1 MCP surface. Weekend 3 shipped
`get_recent_activity`, `get_sync_status`, and (bonus) `search`.
`get_thread` and `list_accounts` were silently missing from the
schedule — added here so the v1 surface is complete before Weekend 5
moves the server to the Synology. Each is a self-contained TDD slice
with its own plan file.

- [x] `get_thread(thread_id, limit?)` ✅ (2026-04-13) — Teams-only
  scope. `MessageStore.getThread({threadId, limit?})` added to
  contract + SqliteMessageStore + InMemoryMessageStore. SQL:
  `WHERE thread_id = ? ORDER BY sent_at ASC, id ASC LIMIT ?`. Handler
  at [src/mcp/tools/get-thread.ts](src/mcp/tools/get-thread.ts)
  projects the same shape as `get_recent_activity` (no `body`,
  no `rawJson`; `SNIPPET_MAX=280` fallback to `bodyHtml`). Default
  limit 200, max 500. Covers Teams chats and (as of slice 3) Outlook
  conversations. Plan:
  [docs/plans/done/weekend-4.5-slice-1-get-thread.md](docs/plans/done/weekend-4.5-slice-1-get-thread.md).
- [x] `list_accounts()` ✅ (2026-04-13) — handler at
  [src/mcp/tools/list-accounts.ts](src/mcp/tools/list-accounts.ts),
  backed by the existing `MessageStore.listAccounts()`. Projection is
  `{username, displayName?, addedAt}`; `tenantId` omitted from the
  wire shape. Plan:
  [docs/plans/done/weekend-4.5-slice-2-list-accounts.md](docs/plans/done/weekend-4.5-slice-2-list-accounts.md).
- [x] [docs/user-guide.md](docs/user-guide.md) and
  [docs/claude-desktop-wiring.md](docs/claude-desktop-wiring.md)
  updated to advertise the two new tools and the 5-tool v1 surface.
- [x] Outlook thread follow-up ✅ (2026-04-13) — `GraphMessage` gains
  optional `conversationId`; `sync-inbox.toMessage` maps it to
  `threadId` and `subject` to `threadName` (both defensively omitted
  when absent). `get_thread` now resolves Outlook conversations. Plan:
  [docs/plans/done/weekend-4.5-slice-3-outlook-thread-fields.md](docs/plans/done/weekend-4.5-slice-3-outlook-thread-fields.md).
- [x] Live smoke through Claude Desktop: *"show me the full thread
  about X"* (Teams) and *"which accounts do you have access to?"* ✅ (2026-04-15).

---

## Weekend 5 — Dockerize + Synology

- [x] `WALDO_BIND_HOST` config knob ✅ (2026-04-14) — default
  `127.0.0.1`; containers override to `0.0.0.0`. Plumbed through
  `loadConfig` → `main()` → `httpServer.listen`. 4 new tests, 384
  total.
- [x] `Dockerfile` ✅ (2026-04-14) — `node:22-bookworm-slim` (not
  alpine; `better-sqlite3` + musl not worth the fight). Multi-stage,
  non-root `node` user, `apt-get python3 make g++` in deps stage for
  the from-source fallback.
- [x] `.dockerignore`, `docker-compose.yml`, `.env.example`
  update ✅ (2026-04-14) — compose targets `linux/arm64` for the
  DS223, publishes `8765:8765`, healthcheck hits the existing
  unauthenticated `/health` endpoint.
- [x] Volume mounts: `/data/db`, `/data/auth` ✅ (2026-04-14) —
  declared as VOLUME in the Dockerfile; compose bind-mounts
  `./data/*` locally, `/volume1/docker/waldo-wtf/*` on the NAS.
- [x] Operator manual [docs/deploy-synology.md](docs/deploy-synology.md)
  ✅ (2026-04-14) — end-to-end recipe for DS223 + Tailscale +
  Container Manager, including first-run `--add-account` device code
  flow and Claude Desktop repoint. Plan:
  [docs/plans/done/weekend-5-dockerize-and-synology.md](docs/plans/done/weekend-5-dockerize-and-synology.md).
- [x] **Local container smoke test on Mac** ✅ (2026-04-14) — Part A
  of [docs/deploy-synology.md](docs/deploy-synology.md) executed end
  to end with OrbStack as the Docker engine. `docker buildx build
  --platform linux/arm64 --load` completes in 34s (prebuilt
  `better-sqlite3` available for arm64, from-source fallback not
  needed). Container comes up `(healthy)`, `/health` returns
  `{"ok":true}`, `WALDO_BIND_HOST=0.0.0.0` override reaches the
  server, `./data/db/lake.db` + WAL/SHM files land on the host via
  the bind mount, `docker compose down` shuts down cleanly.
  Dockerfile + compose file are validated against a live engine;
  manual is trustworthy for Parts B–G. Two findings flagged for
  follow-up (not blocking): (1) Dockerfile lint warning
  `SecretsUsedInArgOrEnv` on `ENV WALDO_AUTH_DIR` — false positive,
  noisy; (2) suspicious startup log line `◇ injected env (0) from
  .env // tip: ⌁ auth for agents [www.vestauth.com]` — NOT from
  waldo.WTF code, likely an ad/promo injection from a transitive
  `node_modules` dep; deferred as a separate security investigation.
- [x] Synology: Container Manager + Tailscale installed (manual Part B) ✅ (2026-04-15)
- [x] Deploy container (internal SSD bind mounts — **not** SMB) (manual Part D) ✅ (2026-04-15)
- [x] First-run MSAL login against NAS volume (manual Part E) ✅ (2026-04-15)
- [x] Reachable via tailnet hostname (manual Part F) ✅ (2026-04-15)
- [x] Claude Desktop repointed from `localhost` → `waldo-nas.tailnet.ts.net` (manual Part G) ✅ (2026-04-15)

---

## Weekend 5.5 — Body backfill ✅ (2026-04-15)

First live smoke of the NAS container surfaced that Claude couldn't read
mail bodies: FTS5 indexes `body`, but Outlook mails land in `body_html`,
so `search` returned null snippets and `get_recent_activity` surfaced raw
`<html><head><meta>…` boilerplate. Data was already on disk — this slice
derives plain `body` from `body_html` in place on the 882 MB production
lake, with no Graph refetch.

- [x] `htmlToText` helper ([src/text/html-to-text.ts](src/text/html-to-text.ts))
  — `node-html-parser`-backed, drops `<script>`/`<style>`/`<head>`,
  converts block/void tags to newlines, decodes entities, collapses
  whitespace. 7 unit tests incl. a realistic Outlook-shaped fixture.
- [x] [src/sync/sync-inbox.ts](src/sync/sync-inbox.ts) mapper populates
  both `bodyHtml` (raw) and `body` (`htmlToText(bodyHtml)`) on ingest so
  every new Outlook mail is FTS-indexed going forward.
- [x] Schema v5 → v6 marker migration ([src/store/schema.ts](src/store/schema.ts))
  — no DDL, gates the data backfill and lets future code assume v6+ rows
  have populated `body` when `body_html` is present.
- [x] [src/store/backfill-body-from-html.ts](src/store/backfill-body-from-html.ts)
  — chunked 5 000-row transactions, `WHERE body IS NULL AND body_html IS
  NOT NULL` (self-healing on re-run), then FTS5
  `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')` to
  recompute the shadow index from the content table. `raw_json` and
  `body_html` left untouched.
- [x] CLI subcommand `tsx src/cli.ts --backfill-bodies`
  ([src/cli.ts](src/cli.ts)) — opens the real DB, runs migrations,
  backfills with progress output, WAL checkpoint truncate.
- [x] 396 tests pass, coverage 99.73% lines / 98.33% branches. Security
  scan clean.
- [x] Deployment recipe: [docs/deploy-backfill-bodies.md](docs/deploy-backfill-bodies.md).
- [x] Live run against the NAS container ✅ (2026-04-15).

**Deferred to Slice B**: exposing full bodies through the MCP surface
(`include_body` flag on `get_thread` / new `get_message` tool). Slice A
only fixes snippet quality + FTS indexing — enough for Claude to *find*
and *preview* mail, not yet to read the full body.

Plan: [docs/plans/done/fix-message-bodies-slice-a-backfill.md](docs/plans/done/fix-message-bodies-slice-a-backfill.md).

### Slice B — `include_body` on `get_thread` + `search` ✅ (2026-04-19)

- [x] Shared `projectBody` helper
  ([src/mcp/tools/body-projection.ts](src/mcp/tools/body-projection.ts))
  — 50k chars/message head-truncation with `bodyTruncated: true` flag,
  400k chars per-call budget. 5 unit tests.
- [x] `get_thread` gained `include_body?: boolean`. When true, projects
  each message's plain-text body; surfaces `bodyBudgetExhausted: true`
  when the per-call budget runs out mid-list. 6 new tests.
- [x] `search` gained the same flag with identical semantics. 4 new
  tests (incl. a budget-exhaustion test against a seeded 10-hit batch).
- [x] e2e HTTP test confirms bodies round-trip through the MCP SDK
  transport.
- [x] 480 tests green, coverage ≥90% lines/branches on touched files,
  `/security-scan` clean.
- [x] Live run against the NAS container ✅ (2026-04-19) — deployed
  from commit `80012e5`, container healthy, initial sync tick started.

Plan: [docs/plans/done/fix-message-bodies-slice-b-include-body.md](docs/plans/done/fix-message-bodies-slice-b-include-body.md).

---

## Weekend 6 — WhatsApp + Android

Code slices 1–8 complete 2026-04-15. Plan:
[docs/plans/done/weekend-6-whatsapp-importer.md](docs/plans/done/weekend-6-whatsapp-importer.md).

- [x] WhatsApp `.txt` importer (`source='whatsapp'`) ✅ (2026-04-15) —
  pure parser + hash-id mapper + file orchestrator. 442 tests green,
  99.77% lines / 97.53% branches.
- [x] Chokidar-backed watcher on `~/Downloads/` for `WhatsApp Chat*.txt`
  ✅ (2026-04-15) — reuses existing `FileSystem.watch` seam; off by
  default on the NAS, enable via `WALDO_WHATSAPP_WATCH=true` on the Mac.
- [x] Mac en-BE 24h date parser (DST-aware via `Intl.DateTimeFormat`)
  ✅ (2026-04-15) — [src/sources/whatsapp.ts](src/sources/whatsapp.ts).
- [x] Multi-line message handling (continuation lines prepend to previous)
  ✅ (2026-04-15).
- [x] Dedup via `whatsapp:sha256(chat\nsender\nsentAtIso\nbody)` +
  `upsertMessages` primary-key idempotency ✅ (2026-04-15) —
  [src/sync/whatsapp-map.ts](src/sync/whatsapp-map.ts).
- [x] Archive imported files → `~/WhatsAppArchive/YYYY-MM/` with
  `-1`/`-2` collision suffixes ✅ (2026-04-15) —
  [src/sync/import-whatsapp.ts](src/sync/import-whatsapp.ts).
- [x] Live smoke on the Mac: drop a real export, watcher imports it,
  Claude Desktop's `search` finds it. ✅ (2026-04-20)
- [x] Tailscale on Android (manual) ✅ (2026-04-20)
- [x] Claude mobile connector → remote MCP endpoint (manual) ✅ (2026-04-20)
- [x] First *"wtf is going on?"* from the train 🚄 ✅ (2026-04-20)

---

## Weekend 7 — OAuth 2.1 surface for MCP ✅ (2026-04-20)

Plan: [docs/plans/done/oauth-mcp-auth.md](docs/plans/done/oauth-mcp-auth.md). Goal: enable claude.ai custom-connector / Claude mobile to register against the publicly reachable Tailscale-Funnel endpoint without the static bearer token.

### Slice 1 — Discovery + DCR + AuthStore seam ✅ (2026-04-20)
- [x] `.well-known/oauth-authorization-server` (RFC 8414) and `.well-known/oauth-protected-resource` (RFC 9728) discovery routes
- [x] `POST /oauth/register` Dynamic Client Registration (RFC 7591) — public-client (PKCE-only), `token_endpoint_auth_method: "none"`
- [x] `AuthStore` seam (interface + `SqliteAuthStore` + `InMemoryAuthStore`) with shared contract test
- [x] Schema migration v6 → v7 adding `oauth_clients` table
- [x] Routes mount only when `WALDO_PUBLIC_URL` is set; static-bearer auth untouched

Plan: [docs/plans/done/oauth-mcp-auth-slice-1-discovery-and-dcr.md](docs/plans/done/oauth-mcp-auth-slice-1-discovery-and-dcr.md).

### Slice 2 — Consent UI (`GET/POST /oauth/authorize`) ✅ (2026-04-20)
- [x] `GET /oauth/authorize` validates client_id, redirect_uri, response_type=code, PKCE S256, and renders an HTML consent form
- [x] `POST /oauth/authorize` verifies admin password (scrypt), issues a 10-minute auth code, 302-redirects to `redirect_uri?code=…&state=…`
- [x] 401 HTML on wrong password; 503 JSON when `WALDO_ADMIN_PASSWORD` is not configured
- [x] `scryptPasswordHasher` (N=16384, r=8, p=1, keyLen=64) + `PlaintextPasswordHasher` test fake
- [x] `verifyPkceS256` helper (timing-safe S256 check)
- [x] Schema migration v7 → v8 adding `oauth_auth_codes` table

Plan: [docs/plans/done/oauth-mcp-auth-slice-2-authorize.md](docs/plans/done/oauth-mcp-auth-slice-2-authorize.md).

### Slice 3 — Token endpoint (`POST /oauth/token`) ✅ (2026-04-20)
- [x] `authorization_code` grant: consumes auth code, verifies PKCE verifier, issues access + refresh token pair
- [x] `refresh_token` grant: rotates pair (old refresh token invalidated on use)
- [x] Access token TTL 1 h; refresh token TTL 30 days
- [x] Schema migration v8 → v9 adding `oauth_access_tokens` table (+ refresh index)

Plan: [docs/plans/done/oauth-mcp-auth-slice-3-token.md](docs/plans/done/oauth-mcp-auth-slice-3-token.md).

### Slice 4 — MCP endpoint access-token guard ✅ (2026-04-20)
- [x] Dual-path auth: valid OAuth access token **or** static bearer (unless `WALDO_DISABLE_STATIC_BEARER=true`)
- [x] `WWW-Authenticate: Bearer resource_metadata=<publicUrl>/.well-known/oauth-protected-resource` on every 401 when OAuth is configured
- [x] `WALDO_DISABLE_STATIC_BEARER` config flag wired end-to-end (`oauth-config.ts` → `index.ts` → `http-server.ts`)

Plan: [docs/plans/done/oauth-mcp-auth-slice-4-resource-guard.md](docs/plans/done/oauth-mcp-auth-slice-4-resource-guard.md).

### Slice 5 — Operator guide ✅ (2026-04-20)
- [x] `docs/oauth.md` — setup, curl walkthrough, claude.ai registration, admin password rotation, manual client revocation via SQLite, troubleshooting table
- [x] `.env.example` verified complete (all four OAuth vars documented)

Plan: [docs/plans/done/oauth-mcp-auth-slice-5-live-smoke.md](docs/plans/done/oauth-mcp-auth-slice-5-live-smoke.md).

**Live smoke ✅ (2026-04-20)** — claude.ai custom connector registered end-to-end against `https://waldonas3.tailb07704.ts.net` (Tailscale Funnel → NAS container). Full OAuth flow exercised (DCR → consent → PKCE token exchange → `/mcp` tool calls). Static bearer kept on alongside OAuth; `WALDO_DISABLE_STATIC_BEARER` left false so Claude Desktop's bearer path keeps working.

---

## Weekend 8+ — Use, iterate, blog

- [x] **Steering rules** ✅ (2026-04-20) — hard-exclude-by-default on `get_recent_activity` + `search`, with `include_muted` escape hatch. New `steering_rules` table (schema v9→v10), `SteeringStore` contract (sqlite + in-memory), `buildSteeringPredicate` shared SQL-and-JS filter. Four new MCP tools (`get_steering`, `add_steering_rule`, `remove_steering_rule`, `set_steering_enabled`) so Claude can mute in-chat; eight new CLI flags (`--steer-*`) for scriptable management. Five rule types: `sender_email`, `sender_domain`, `thread_id`, `thread_name_contains`, `body_contains` (FTS5). `get_thread` + `list_accounts` unaffected. Plan: [docs/plans/done/steering-rules.md](docs/plans/done/steering-rules.md). Five /tdd-cycle runs, all green; coverage 99.81% / 97.16%.
- [ ] One real week of daily use
- [ ] Blog post on waldo.be
- [ ] Days of Knowledge 2026 lightning talk?
- [ ] Only add features driven by real frustration

---

## Open questions (from brief §10)

- [ ] Will all 4 Microsoft accounts give `Mail.Read` without admin consent? (dynex.be ✅)
- [ ] Customer-tenant guest accounts — enough Graph access to be useful?
- [ ] Teams channels in scope, or 1:1 + group chats only for v1?
- [ ] Flag `@mentions` of waldo in schema?
- [ ] Retention policy — keep forever or prune after N months?
- [ ] Claude mobile remote-MCP connector solid on Android, or PWA fallback?
- [ ] Daily/weekly digest pushed somewhere, or pull-via-Claude only?
