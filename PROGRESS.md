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

### Second account
- [ ] Trigger a second `acquireTokenByDeviceCode` (force interactive even when cache has one account)
- [ ] Verify MSAL routes silent refresh per-account correctly
- [ ] Loop `syncInbox` over all cached accounts
- [ ] Confirm `delta-state.json` has one entry per account after run

### Learning log (edge cases to note as they appear)
- _add findings here during the weekend_

---

## Weekend 2 — Graduate to TypeScript project

TDD toolkit is ready — see [CLAUDE.md](CLAUDE.md), [docs/tdd/](docs/tdd/), [testing/](testing/). Every code change from Weekend 2 onward runs through `/tdd-cycle` (`.claude/skills/tdd-cycle/SKILL.md`).

- [ ] Create `~/code/waldo.WTF/` (keep spike folder intact for reference)
- [ ] `npm init`, `tsconfig.json`, `tsx` for dev
- [ ] Copy [testing/vitest.config.ts](testing/vitest.config.ts) + merge [testing/package.deps.json](testing/package.deps.json) into `package.json`
- [ ] Port example fakes from [testing/examples/](testing/examples/) into `src/testing/`
- [ ] First RED test before any production code (run `/tdd-cycle`)
- [ ] Folder structure (`src/auth`, `src/sources`, `src/store`, `src/sync`, `src/mcp`, `src/config.ts`, `src/index.ts`)
- [ ] Port spike logic — **reference, don't copy-paste**
- [ ] Real schema (full `messages` table incl. `raw_json`, `sync_state`, `sync_log`, `accounts`, FTS5)
- [ ] 5-minute sync loop writing to `sync_log`
- [ ] Skeleton HTTP MCP server (transport only, no tools yet)
- [ ] `.env`: `MS_CLIENT_ID`, `BEARER_TOKEN`

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
