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

- [x] `@modelcontextprotocol/sdk` installed — 2026-04-13. Hand-rolled JSON-RPC dispatcher replaced by SDK `Server` + `StreamableHTTPServerTransport` (stateless). New [src/mcp/mcp-server.ts](src/mcp/mcp-server.ts) wraps the three existing tool handlers into MCP content blocks and maps `InvalidParamsError` → `McpError(InvalidParams)`. [src/mcp/http-server.ts](src/mcp/http-server.ts) is now a thin shell: `/health` + bearer middleware + per-request SDK transport mount. Plan: [docs/plans/adopt-mcp-sdk.md](docs/plans/adopt-mcp-sdk.md).
- [x] `get_recent_activity(hours, sources?, accounts?)` — 2026-04-13. Handler in [src/mcp/tools/get-recent-activity.ts](src/mcp/tools/get-recent-activity.ts); backed by new `MessageStore.getRecentMessages`; JSON-RPC dispatch wired into [src/mcp/http-server.ts](src/mcp/http-server.ts). 30 new tests, 201 total.
- [x] `get_sync_status()` — 2026-04-13. Handler in [src/mcp/tools/get-sync-status.ts](src/mcp/tools/get-sync-status.ts); backed by new `MessageStore.getSyncStatus(now)` (union of `sync_state` ∪ `sync_log` per pair, with `lastOkAt` / `lastStatus` / `messagesAddedLast24h`). 15-min `stale` threshold, top-level `staleCount`. http-server dispatch refactored to a `{name → handler}` map. 28 new tests, 229 total.
- [x] Bearer token middleware — Weekend 2 slice 10 (pre-existing; still in effect for `POST /`).
- [x] Wired into Claude Desktop (`http://localhost:PORT`) — 2026-04-13. Operator recipe at [docs/claude-desktop-wiring.md](docs/claude-desktop-wiring.md): prereqs, `curl /health` + JSON-RPC `tools/list` verification, config snippet, troubleshooting table, security notes. Linked from [getting-started.md §6](docs/getting-started.md).
- [x] End-to-end test: *"summarize my mail from the last 24 hours"* — 2026-04-13. [src/mcp/e2e-http.test.ts](src/mcp/e2e-http.test.ts) drives the full stack (real `SqliteMessageStore` `:memory:` + FTS5 + real `fetch`) through `tools/list`, `get_recent_activity` (24h window), `search`, `get_sync_status`, and unauth rejection. 5 tests, green on first run.
- [x] `search` tool (FTS5) — 2026-04-13. [src/mcp/tools/search.ts](src/mcp/tools/search.ts) wraps the slice-9 `MessageStore.searchMessages`; validates non-empty query + `limit ∈ (0,100]` (default 20); projects hits to drop body/rawJson while preserving BM25 `rank` + `snippet`. 11 handler tests, 245 total.

---

## Weekend 4 — Multi-account + Teams

### Slice 1 — Interactive login CLI ✅ (2026-04-13)
- [x] `runCli(argv)` + `addAccount(opts)` in [src/cli.ts](src/cli.ts); `--add-account` drives `MsalAuthClient.loginWithDeviceCode` against the real `TokenCacheStore`. Live smoke still required per-account. Plan: [docs/plans/weekend-4-slice-1-interactive-login-cli.md](docs/plans/weekend-4-slice-1-interactive-login-cli.md).

### Slice 2 — Teams message shape + schema v3 ✅ (2026-04-13)
- [x] `Message.chatType` / `replyToId` / `mentions` (optional); schema v3 migration adds `chat_type`, `reply_to_id`, `mentions_json` columns; both store impls roundtrip the fields. FTS5 untouched. Plan: [docs/plans/weekend-4-slice-2-teams-schema-v3.md](docs/plans/weekend-4-slice-2-teams-schema-v3.md).

### Slice 3 — `TeamsClient` seam + `FakeTeamsClient` ✅ (2026-04-13)
- [x] Interface + DTOs in [src/sources/teams.ts](src/sources/teams.ts); scripted fake in [src/testing/fake-teams-client.ts](src/testing/fake-teams-client.ts). Plan: [docs/plans/weekend-4-slice-3-teams-client-seam.md](docs/plans/weekend-4-slice-3-teams-client-seam.md).

### Slice 4 — `HttpTeamsClient` ✅ (2026-04-13)
- [x] Fetch-backed adapter [src/sources/http-teams-client.ts](src/sources/http-teams-client.ts); 401/410/429 mapping + token-redacted errors. Plan: [docs/plans/weekend-4-slice-4-http-teams-client.md](docs/plans/weekend-4-slice-4-http-teams-client.md).

### Slice 5 — `syncTeams` + scheduler wiring ✅ (2026-04-13)
- [x] [src/sync/sync-teams.ts](src/sync/sync-teams.ts) walks Teams delta, maps → `Message`, routes `@removed`, persists `setSyncState({source:"teams"})`. `SyncScheduler` now takes optional `teams: TeamsClient` and emits a second `sync_log` row per account per tick. `src/index.ts` wires real `HttpTeamsClient`. Plan: [docs/plans/weekend-4-slice-5-sync-teams.md](docs/plans/weekend-4-slice-5-sync-teams.md).

### Slice 6 — MCP tool coverage for Teams source ✅ (2026-04-13)
- [x] `get_recent_activity` + `search` projections carry `chatType` / `replyToId` / `mentions`; snippet falls back to `bodyHtml` when `body` absent. `get_sync_status` verified against a mixed outlook+teams log. Weekend 4 closed. Plan: [docs/plans/weekend-4-slice-6-mcp-teams-coverage.md](docs/plans/weekend-4-slice-6-mcp-teams-coverage.md).

### Retrofit — `rawJson` population ✅ (2026-04-13)
- [x] `syncInbox` + `syncTeams` mappers now stringify the raw DTO into `Message.rawJson` on upsert, closing the brief §4.10 insurance-policy gap. Column existed since Weekend 2 but sync writers never set it; pre-retrofit rows remain `rawJson=NULL` until delta resync naturally overwrites them (no migration). Plan: [docs/plans/fix-raw-json-population.md](docs/plans/fix-raw-json-population.md).

- [ ] Remaining Microsoft accounts logged in (iFacto, customer tenants, personal) — uses `tsx src/cli.ts --add-account` (Slice 1)
- [ ] Open Q: do all 4 support delegated `Mail.Read` without admin consent?
- [ ] Teams source: `/me/chats/getAllMessages` with delta
- [ ] Teams quirks: chat vs channel, reply threading, mentions
- [ ] Claude Desktop system prompt: "always check all accounts + both sources"
- [ ] Live with it for a week, collect frustrations below

### Teams endpoint rework — slice 1 ✅ (2026-04-13)
- [x] Schema v4 `chat_cursors` table + `MessageStore.getChatCursor` / `setChatCursor` / `listChatCursors` on both impls. Storage-only slice; seam reshape + `HttpTeamsClient` rewrite + `syncTeams` rewrite are slice 2. Plan: [docs/plans/teams-endpoint-rework.md](docs/plans/teams-endpoint-rework.md).

### Teams endpoint rework — slice 2 ✅ (2026-04-13)
- [x] `TeamsClient` seam reshaped to `listChats` + `getChatMessages`; `HttpTeamsClient` rewritten to poll `/me/chats` + `/me/chats/{id}/messages` under delegated auth; `syncTeams` rewritten to enumerate chats and maintain per-chat cursors with per-chat error isolation; schema v5 renames `chat_cursors.last_modified_iso → cursor`. Live smoke on dev db: one account synced Teams successfully (96 messages, 13 chat cursors), the other returned `403 Forbidden — Missing scope permissions` (tenant-level policy, correctly logged). Outlook unaffected. Plan: [docs/plans/teams-endpoint-rework.md](docs/plans/teams-endpoint-rework.md).

**Frustrations log:**
- 2026-04-13 — First live smoke of Teams sync (two real accounts across two tenants) surfaced `HTTP 412 PreconditionFailed — Requested API is not supported in delegated context` on `/me/chats/getAllMessages/delta`. Pre-existing Graph constraint (the endpoint requires application permissions + RSC, not delegated device-code). Slices 4–6 used `FakeTeamsClient` end-to-end so it only showed up on the first real tick. Outlook unaffected and shipping. Fix plan: [docs/plans/teams-endpoint-rework.md](docs/plans/teams-endpoint-rework.md) — recommends polling `/me/chats` + `/me/chats/{id}/messages` under the existing delegated flow.

---

## Weekend 4.5 — Finish v1 MCP surface

Brief §6 lists four tools in the v1 MCP surface. Weekend 3 shipped
`get_recent_activity`, `get_sync_status`, and (bonus) `search`.
`get_thread` and `list_accounts` were silently missing from the
schedule — added here so the v1 surface is complete before Weekend 5
moves the server to the Synology. Each is a self-contained TDD slice
with its own plan file.

- [ ] `get_thread(thread_id, limit?)` — pull a full conversation for
  context. Backed by a new `MessageStore.getThread(...)` query (shape
  TBD in the plan — Outlook threads key off `thread_name` + account,
  Teams threads key off `chat_id`). Projects messages the same way
  `get_recent_activity` does (no `body`/`rawJson` leak). Plan:
  [docs/plans/weekend-4.5-slice-1-get-thread.md](docs/plans/weekend-4.5-slice-1-get-thread.md).
- [ ] `list_accounts()` — return the known accounts so Claude can
  enumerate what's available. Backed by the existing
  `MessageStore.listAccounts()` (schema v1). Read-only, trivial. Plan:
  [docs/plans/weekend-4.5-slice-2-list-accounts.md](docs/plans/weekend-4.5-slice-2-list-accounts.md).
- [ ] User guide ([docs/user-guide.md](docs/user-guide.md)) and Claude
  Desktop wiring ([docs/claude-desktop-wiring.md](docs/claude-desktop-wiring.md))
  updated to advertise the two new tools.
- [ ] Live smoke through Claude Desktop: *"show me the full thread
  about X"* and *"which accounts do you have access to?"*.

---

## Weekend 5 — Dockerize + Synology

- [ ] `Dockerfile` (node:22-alpine)
- [ ] Volume mounts: `/data/db`, `/data/auth`
- [ ] Local container test on Mac
- [ ] Synology: Container Manager + Tailscale installed
- [ ] Deploy container (internal SSD bind mounts — **not** SMB)
- [ ] Reachable via tailnet hostname
- [ ] Claude Desktop repointed from `localhost` → `waldo-nas.tailnet.ts.net`

---

## Weekend 6 — WhatsApp + Android

- [ ] WhatsApp `.txt` importer (`source='whatsapp'`)
- [ ] Chokidar watches `~/Downloads/` for `WhatsApp Chat*.txt`
- [ ] Mac locale date parser
- [ ] Multi-line message handling
- [ ] Dedup via `sha256(chat + sender + ts + body)` + `INSERT OR IGNORE`
- [ ] Archive imported files → `~/WhatsAppArchive/YYYY-MM/`
- [ ] Tailscale on Android
- [ ] Claude mobile connector → remote MCP endpoint
- [ ] First *"wtf is going on?"* from the train 🚄

---

## Weekend 7+ — Use, iterate, blog

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
