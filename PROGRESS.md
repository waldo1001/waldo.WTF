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

## Weekend 3 — First MCP tools + Claude Desktop wiring

- [ ] `@modelcontextprotocol/sdk` installed
- [ ] `get_recent_activity(hours, sources?, accounts?)`
- [ ] `get_sync_status()`
- [ ] Bearer token middleware
- [ ] Wired into Claude Desktop (`http://localhost:PORT`)
- [ ] End-to-end test: *"summarize my mail from the last 24 hours"*
- [ ] `search` tool (FTS5)

---

## Weekend 4 — Multi-account + Teams

- [ ] Remaining Microsoft accounts logged in (iFacto, customer tenants, personal)
- [ ] Open Q: do all 4 support delegated `Mail.Read` without admin consent?
- [ ] Teams source: `/me/chats/getAllMessages` with delta
- [ ] Teams quirks: chat vs channel, reply threading, mentions
- [ ] Claude Desktop system prompt: "always check all accounts + both sources"
- [ ] Live with it for a week, collect frustrations below

**Frustrations log:**
- _add as you use it_

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
