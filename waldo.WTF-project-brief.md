# waldo.WTF

> **W**hat **T**o **F**ocus — *a personal context server that lets Claude answer "what the f\*\*\* is going on in my life?"*

---

## 1. Intent

A single, private, always-on service that pulls messages from all the places waldo actually gets pinged — Microsoft Teams and Outlook across multiple tenants/accounts, plus WhatsApp (via manual exports), plus whatever else later — into one unified local SQLite "lake", and exposes it to Claude via an HTTP MCP server so that asking *"wtf is going on in my life?"* returns a genuinely useful triage across everything at once.

**The actual problem being solved**: waldo lives in ~4 different Microsoft accounts (iFacto, Dynex, customer tenants, personal), plus a phone full of WhatsApp chats that matter. Right now, "did I miss something important?" requires logging in and out of multiple places all day, and the context cost is real. Off-the-shelf tools don't fit because:

1. They're usually single-account.
2. They're stateless — live API calls every query, no history.
3. They can't unify across sources (Teams + Outlook + WhatsApp in one answer).
4. WhatsApp live-integration is ToS-risky (Baileys can get your number banned) and therefore off the table.

**The non-goals are as important as the goals.** waldo.WTF is explicitly NOT:
- A replacement for Teams/Outlook clients (no writing, no replying, no UI)
- A notification system (the TeamsChatNotifier already exists for that, this is its smarter successor)
- A generic "M365 MCP server" (softeria/ms-365-mcp-server already exists and is great for the simple cases — we're building past that)
- A shared/multi-user tool (single user, single owner, single brain)
- Live WhatsApp automation (manual export only, zero ban risk)

**The one-sentence test** for any feature: *"does this make 'wtf is going on in my life?' return a better answer?"* If no, don't build it.

---

## 2. Background context

- **Author**: Eric "waldo" Wauters ([waldo.be](https://waldo.be), [github.com/waldo1001](https://github.com/waldo1001)), founding partner & Development Manager at iFacto Business Solutions, Microsoft MVP for Business Central.
- **Relevant prior art**: [waldo.TeamsChatNotifier](https://github.com/waldo1001/waldo.TeamsChatNotifier) — Electron desktop app, 15 releases, MSAL multi-account Teams notifier. The auth pattern is battle-tested and should be **lifted, not redesigned**, for waldo.WTF. Everything else (Electron, React, notification logic, UI) is explicitly *not* wanted in waldo.WTF.
- **Adjacent projects**: [BCTB (BC Telemetry Buddy)](https://github.com/waldo1001) — waldo's MCP server for Business Central telemetry. Same architectural philosophy applies: **the tool exposes data, the LLM does the thinking**. Don't build summarization logic in waldo.WTF — Claude does that for free. The tool returns raw rows, Claude reasons over them.
- **Infrastructure**: MacBook for development, Synology NAS (novice level) as the eventual always-on home via Container Manager + Tailscale. Azure is available but **deliberately not used** — personal tool holding customer-tenant data should stay on hardware waldo physically owns.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Synology NAS — Container Manager (eventually)           │
│  Mac (during development)                                │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  waldo.WTF  (single Node container / process)       │ │
│  │                                                     │ │
│  │  ┌───────────────┐    ┌──────────────────────────┐ │ │
│  │  │  sync worker  │ →  │  SQLite (the lake)        │ │ │
│  │  │  ─ MSAL auth  │    │  ─ messages (unified)     │ │ │
│  │  │  ─ Graph poll │    │  ─ sync_state             │ │ │
│  │  │  ─ N accounts │    │  ─ sync_log               │ │ │
│  │  │  ─ delta qry  │    │  ─ accounts               │ │ │
│  │  │  ─ every 5min │    │  ─ FTS5 index             │ │ │
│  │  └───────────────┘    └────────────┬─────────────┘ │ │
│  │                                    │               │ │
│  │                       ┌────────────┴─────────────┐ │ │
│  │                       │  HTTP MCP server          │ │ │
│  │                       │  (bearer token auth)      │ │ │
│  │                       │  ─ get_recent_activity    │ │ │
│  │                       │  ─ search                 │ │ │
│  │                       │  ─ get_thread             │ │ │
│  │                       │  ─ list_accounts          │ │ │
│  │                       │  ─ get_sync_status        │ │ │
│  │                       └────────────┬─────────────┘ │ │
│  └────────────────────────────────────┼───────────────┘ │
└───────────────────────────────────────┼─────────────────┘
                                        │
                              Tailscale (private only)
                                        │
                  ┌─────────────────────┼─────────────────────┐
                  │                     │                     │
            Claude Desktop        Claude mobile          (later: PWA)
              (MacBook)             (Android)
```

**One container. One Node process. One SQLite file. Two logical components inside it** (sync worker + HTTP MCP server) sharing the database via WAL mode. Resist all urges to split into microservices.

---

## 4. Key architectural decisions (made deliberately, record here to prevent drift)

1. **Node + TypeScript.** Stack waldo already uses. No language switches.
2. **SQLite via better-sqlite3, WAL mode from day one.** Sync worker writes don't block MCP reads. No Postgres, no "for scale" excuses.
3. **MSAL Node with disk-persisted token cache on a mounted volume.** Lifted from TeamsChatNotifier. Container restarts do not log accounts out.
4. **Source-agnostic unified `messages` table with a `source` discriminator.** NOT separate tables per source. Enables cross-source queries trivially.
5. **Microsoft Graph delta queries, not full re-syncs.** `/delta` endpoints for mail and Teams chats. Store delta token per `(account, source)` in `sync_state`.
6. **5-minute polling interval.** Not lower. Rate limits and battery matter.
7. **HTTP MCP transport (not stdio).** So remote clients (Claude mobile) can reach it. Behind Tailscale + bearer token auth.
8. **Claude does the summarizing.** Tools return rows, not prose. No `summarize_*` tools.
9. **Everything Mac-local for v1, NAS-deployed for v2.** Don't touch Docker/Container Manager until the app works end-to-end locally.
10. **Keep `raw_json` per message.** Insurance policy — cheap to store, expensive to regret not having.

---

## 5. Schema sketch

```sql
-- The lake: every message from every source ends up here
CREATE TABLE messages (
  id TEXT PRIMARY KEY,           -- stable hash: source+account+native_id
  source TEXT NOT NULL,          -- 'teams' | 'outlook' | 'whatsapp'
  account TEXT NOT NULL,         -- 'waldo@ifacto.be', etc
  native_id TEXT NOT NULL,       -- Graph message id, for delta/dedup
  thread_id TEXT,                -- chat id, conversation id, etc
  thread_name TEXT,              -- "Defrancq channel", "Mom", "Re: Q2 release"
  sender_name TEXT,
  sender_email TEXT,
  sent_at INTEGER NOT NULL,      -- unix timestamp, indexed DESC
  imported_at INTEGER NOT NULL,
  is_read INTEGER,               -- nullable, source-dependent
  body TEXT,                     -- plain text, HTML stripped
  body_html TEXT,                -- optional for richer rendering later
  raw_json TEXT                  -- full Graph payload — insurance policy
);
CREATE INDEX idx_messages_sent_at ON messages(sent_at DESC);
CREATE INDEX idx_messages_account_source ON messages(account, source);

-- FTS5 for natural-language search — built into SQLite, no extra deps
CREATE VIRTUAL TABLE messages_fts USING fts5(
  thread_name, sender_name, body,
  content='messages', content_rowid='rowid'
);

-- Per-(account, source) delta token so polling is incremental, not full
CREATE TABLE sync_state (
  account TEXT NOT NULL,
  source TEXT NOT NULL,
  delta_token TEXT,
  last_sync_at INTEGER,
  PRIMARY KEY (account, source)
);

-- Forensic trail for "why didn't that message show up" debugging
CREATE TABLE sync_log (
  ts INTEGER NOT NULL,
  account TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,          -- 'ok' | 'error'
  messages_added INTEGER,
  error_message TEXT
);
CREATE INDEX idx_sync_log_ts ON sync_log(ts DESC);

-- Known accounts (so list_accounts MCP tool is trivial)
CREATE TABLE accounts (
  username TEXT PRIMARY KEY,
  display_name TEXT,
  tenant_id TEXT,
  added_at INTEGER
);
```

---

## 6. MCP tool surface (v1 — start tiny, grow from frustration)

Five tools. That's it for v1. Add more only after hitting real frustration in daily use.

- `get_recent_activity(hours, sources?, accounts?)` — "what happened recently" bread-and-butter
- `search(query, since?, until?, sources?, accounts?)` — full-text via FTS5
- `get_thread(thread_id, limit?)` — pull a full conversation for context
- `list_accounts()` — so Claude knows what's available
- `get_sync_status()` — last successful sync per (account, source), plus recent errors. **Critical for debugging and for Claude to know data freshness.**

**Deliberate non-tools** (don't build these):
- ❌ `summarize_chat` — Claude does this
- ❌ `who_is_waiting_on_me` — Claude can infer this from `get_recent_activity` + reasoning
- ❌ `send_message` / `reply` — read-only, forever
- ❌ `delete_*`, `archive_*` — read-only, forever
- ❌ Admin UI / dashboard — Claude is the UI

---

## 7. Build plan (weekend-sized steps)

### ✅ Weekend 0 (done — 2026-04-12)

**Spike complete.** Single-file Node script in `/Users/waldo/Temp/waldo-wtf-spike/` successfully:
- Authenticated via MSAL device-code flow against a multitenant Entra app registered in iFacto's directory
- Logged in as `eric.wauters@dynex.be` (proving multitenant works across waldo's accounts)
- Pulled 10 messages via Microsoft Graph `/me/mailFolders/inbox/messages`
- Wrote them to `lake.db` via better-sqlite3 in WAL mode
- Persisted refresh tokens to `token-cache.json` (so second run should be silent)

**Risks retired:** MSAL device code flow, multitenant app registration, delegated `Mail.Read` consent (no admin consent needed, at least for dynex.be), Graph response shape, better-sqlite3 installs cleanly on macOS, token cache persistence, WAL mode. All confirmed working on a real Mac.

**Entra app registration details:**
- Name: `waldo-wtf-spike`
- Account type: multitenant + personal Microsoft accounts
- Platform: none (device code flow, no redirect URI)
- Authentication: "Allow public client flows" = Yes
- API permissions (delegated): `User.Read` (auto), `Mail.Read`
- Client ID: stored in `.env` as `MS_CLIENT_ID`
- Authority: `https://login.microsoftonline.com/common`

### Weekend 1 — Extend the spike, don't graduate yet

Goal: prove delta queries and multi-account work on the same single-file spike. Still throwaway, still prepared to delete.

- [ ] Switch the inbox fetch from `/messages` to `/messages/delta`
- [ ] Store the resulting `@odata.deltaLink` somewhere (a `sync_state` table in the same db, or just a JSON file for now)
- [ ] On second run, use the delta link — verify only new messages come back
- [ ] Handle `@removed` messages (deleted in source → should soft-delete or skip in lake)
- [ ] Add a second account via a second `acquireTokenByDeviceCode` call
- [ ] Verify MSAL routes per-account silent refreshes correctly
- [ ] Loop the sync over all cached accounts
- [ ] Observe and note all edge cases — this is the weekend for *learning*, not polish

### Weekend 2 — Graduate to a real TypeScript project

- [ ] Create `~/code/waldo.WTF/` (new folder — keep spike untouched for reference)
- [ ] `npm init` + TypeScript setup (`tsconfig.json`, `tsx` for dev, `esbuild` or `tsc` for build)
- [ ] Folder structure:
  ```
  waldo.WTF/
  ├── src/
  │   ├── auth/         ← MSAL setup, cache plugin, multi-account helpers
  │   ├── sources/
  │   │   ├── outlook.ts
  │   │   └── teams.ts
  │   ├── store/        ← SQLite schema, migrations, queries
  │   ├── sync/         ← polling loop, delta handling, sync_log writer
  │   ├── mcp/          ← HTTP MCP server, tool definitions
  │   ├── config.ts     ← env vars, accounts.json loader
  │   └── index.ts      ← wires sync worker + MCP server together
  ├── data/             ← gitignored, contains lake.db + token-cache.json
  ├── accounts.json     ← gitignored, list of accounts to sync
  ├── .env              ← gitignored, client ID + bearer token
  └── package.json
  ```
- [ ] Port the spike's logic into properly separated files — **reference, don't copy-paste**
- [ ] Outlook source with delta queries, backed by the real schema (including `raw_json`)
- [ ] Minimal sync loop: every 5 minutes, for each account, call Outlook delta, write rows, log to `sync_log`
- [ ] Add `bearer_token` env var and skeleton HTTP MCP server (no tools wired yet, just the transport)

### Weekend 3 — First real MCP tool + Claude Desktop wiring

- [ ] Pick MCP SDK: `@modelcontextprotocol/sdk` (official, Node)
- [ ] Implement `get_recent_activity` and `get_sync_status` — that's it for now
- [ ] Bearer token middleware on the HTTP transport
- [ ] Wire into Claude Desktop's MCP config as a remote (HTTP) MCP server pointed at `http://localhost:PORT`
- [ ] Ask Claude: *"summarize my mail from the last 24 hours"*
- [ ] Validate the loop works end-to-end with ONE account before adding more
- [ ] Add `search` tool once the first two feel right

### Weekend 4 — Multi-account + Teams

- [ ] Add remaining accounts via device-code flow (one-time logins)
- [ ] Add Teams as a second source: `/me/chats/getAllMessages` with delta
- [ ] Handle the Teams-specific quirks (chat vs channel, reply threading, mentions)
- [ ] Write the Claude Desktop **system prompt** for "always check all accounts and both sources unless I specify otherwise"
- [ ] Live with it for a week. Take notes on frustrations.

### Weekend 5 — Dockerize and move to Synology

- [ ] Write `Dockerfile` (node:22-alpine base, maybe 15 lines)
- [ ] Two volume mounts: `/data/db` (SQLite + WAL) and `/data/auth` (token cache)
- [ ] Test container locally on Mac
- [ ] Install Synology Container Manager + Tailscale packages
- [ ] Deploy container to NAS via Container Manager (bind mounts on internal SSD — NOT network shares — for the db volume; SQLite + SMB = corruption)
- [ ] Confirm reachable from Mac via tailnet hostname
- [ ] Repoint Claude Desktop's MCP config from `localhost` to `waldo-nas.tailnet-name.ts.net`

### Weekend 6 — WhatsApp importer + Android

- [ ] New source module: WhatsApp `.txt` importer
- [ ] Chokidar watches `~/Downloads/` on the Mac for `WhatsApp Chat*.txt`
- [ ] Parser handles Mac's locale-specific date format (hardcode waldo's locale, don't auto-detect)
- [ ] Multi-line message handling
- [ ] Dedup hash = `sha256(chat_name + sender + timestamp + body)` as primary key, `INSERT OR IGNORE` for idempotent re-imports
- [ ] Move imported files to `~/WhatsAppArchive/YYYY-MM/` (never delete — audit trail)
- [ ] Writes into same unified `messages` table with `source='whatsapp'`
- [ ] Install Tailscale on Android phone
- [ ] Wire Claude mobile to the remote MCP endpoint via connectors UI
- [ ] Ask *"wtf is going on?"* from the train 🚄

### Weekend 7+ — Use, blog, iterate

- [ ] Live with it for a real week
- [ ] Blog post: *"I built a personal context server for my LLM and it changed how I triage work"* (waldo.be)
- [ ] Days of Knowledge 2026 lightning talk? 🤪
- [ ] Only add features driven by real frustration from real usage

---

## 8. Traps to avoid (hard-earned lessons, revisit before every weekend)

- ❌ **Don't build an admin UI.** Every line of UI is permanent maintenance. Claude is the UI.
- ❌ **Don't generalize prematurely.** No "source plugin system" until there are 4+ sources.
- ❌ **Don't perfectly normalize the schema.** NULLs are fine. Source-specific fields go in `raw_json`.
- ❌ **Don't build retry logic, queues, or job systems.** A `try/catch` that logs and returns is enough. Next 5-minute poll picks it up.
- ❌ **Don't preemptively build retention policies.** SQLite handles gigabytes fine. Decide when it's actually an issue.
- ❌ **Don't blog mid-build.** Wait until it's running on the NAS and being used daily.
- ❌ **Don't expose anything on the public internet.** Tailscale-only, always.
- ❌ **Don't commit `.env`, `token-cache.json`, `accounts.json`, or `lake.db`.** Gitignore from day one.
- ❌ **Don't put the SQLite file on an SMB share.** Internal disk only.
- ❌ **Don't scope-creep past the "does this answer 'wtf is going on?' better?" test.**

---

## 9. Security notes

- **Token cache contains refresh tokens = sensitive credentials.** Restrictive file permissions (`chmod 600`), never on network shares, never committed.
- **The SQLite lake will contain messages from multiple customer tenants where waldo is a guest.** This is powerful and also spicy. Encrypt the disk (FileVault on Mac, encrypted volume on Synology), never share screenshots without redacting, never sync to consumer cloud storage.
- **Bearer token for the HTTP MCP endpoint.** Long random string in `.env`, checked on every request. Second lock on top of the Tailscale lock.
- **Read-only forever.** No write tools in the MCP surface. If waldo.WTF is ever compromised, the blast radius is "attacker can read messages already on disk" — bad, but recoverable. Write access would mean "attacker can send from 4 accounts", which is significantly worse.
- **Don't blog screenshots without heavy redaction.** Customer tenant data, family WhatsApp chats — none of it should end up in a demo video.

---

## 10. Open questions (resolve as they come up)

- [ ] Will all 4 of waldo's Microsoft accounts support delegated `Mail.Read` without admin consent? (dynex.be: confirmed working. Others: unknown.)
- [ ] Do customer-tenant guest accounts give enough Graph access to be useful? (Tenant-dependent — find out empirically.)
- [ ] Teams channel messages vs chat messages — should both be in scope, or start with 1:1 and group chats only?
- [ ] How to handle `@mentions` of waldo specifically — flag them in the schema?
- [ ] Retention policy: keep everything forever, or prune after N months?
- [ ] Does Claude mobile's current remote-MCP connector support work cleanly on Android, or is a PWA fallback needed?
- [ ] Will waldo want a daily/weekly digest *pushed* somewhere (email, Slack, another Teams channel), or is pull-via-Claude enough?
- [ ] **Attachments & documents in scope?** Mail attachments, Teams/SharePoint documents, files shared in chat threads — none are currently ingested. `raw_json` preserves references but nothing indexes or fetches the content. Decide post-v1 whether the triage answer is materially worse without them.
- [ ] **Steering memory / "not interested" topics.** waldo needs a way to mark certain topics, threads, senders, or projects as low-signal ("not interested") so Claude can down-weight or skip them when answering *"wtf is going on?"*. Shape TBD — could be a `preferences` table exposed via an MCP tool (`get_steering`?), a static file Claude reads, or tags on `messages`. Key requirement: **the LLM must be able to take it into account at query time**, not just at sync time (so nothing is deleted — steering is a lens, not a filter).

---

## 11. Naming & branding

- **Project name**: `waldo.WTF`
- **Public backronym**: *What To Focus*
- **Real meaning**: *What The F\*\*\** 😂
- **Tagline**: *"Because asking 'what the f\*\*\* is going on in my life?' should return a useful answer."*
- **Repo**: `github.com/waldo1001/waldo.WTF` (private until weekend 7+)

---

## 12. Quick-start for tomorrow

When opening this as a Claude Project tomorrow, waldo can paste:

> *"Here's the project brief for waldo.WTF (attached). I finished Weekend 0 (the spike) successfully last night — MSAL device code flow, Graph Mail.Read, better-sqlite3 all working end-to-end on my Mac with one account (eric.wauters@dynex.be). I want to start Weekend 1: extend the spike with delta queries and a second account, still single-file throwaway shape. What's the smallest next change I should make to the existing spike.js to add delta-query support?"*

The spike currently lives at `/Users/waldo/Temp/waldo-wtf-spike/spike.js` and the working code is roughly:
- MSAL `PublicClientApplication` with disk cache plugin (`token-cache.json`)
- `getToken()` — silent first, device code fallback
- `openDb()` — creates `messages` table with a minimal 6-column schema
- `syncInbox()` — fetches `/me/mailFolders/inbox/messages?$top=10` and `INSERT OR REPLACE`s into SQLite
- Main — runs one sync and prints the 3 latest rows

---

*Written: 2026-04-12, end of Weekend 0. Next session starts Weekend 1.*
*Status: spike works, all foundational risks retired, ready to build the real thing.* 🚀
