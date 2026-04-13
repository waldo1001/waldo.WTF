# User Guide

How to live with waldo.WTF once it's running.

---

## 1. What waldo.WTF is (and isn't)

It's a **read-only context server**. It syncs your messages from
Microsoft 365 (and eventually WhatsApp exports) into a local SQLite
"lake", then exposes that lake to Claude via MCP tools.

- It does NOT send, reply, delete, or archive anything.
- It does NOT summarize — Claude summarizes. Tools return raw rows.
- It is NOT a Teams/Outlook client replacement.
- It is NOT shared with anyone. One user, one brain, one owner.

The single test for any feature request: *does this make "wtf is going
on in my life?" return a better answer?* If no, don't build it.

---

## 2. The MCP tool surface (v1)

Five tools total. Claude chooses which to call.

### `get_recent_activity(hours, sources?, accounts?)`

"What's happened recently". Returns rows across all sources and
accounts, ordered `sent_at DESC`, within the last `hours`. Filter by
`sources` (`["outlook", "teams", "whatsapp"]`) or `accounts`
(`["eric.wauters@dynex.be"]`) to narrow.

Typical prompt: *"What happened in the last 4 hours across all my
accounts?"*

### `search(query, since?, until?, sources?, accounts?)`

Full-text search via SQLite FTS5 over `thread_name`, `sender_name`,
`body`. Returns top N ranked matches.

Typical prompts:
- *"Search for any mention of 'Q2 release' in the last month."*
- *"Find emails from Defrancq about the pricing proposal."*

### `get_thread(thread_id, limit?)`

Pull a full conversation given a `thread_id` returned by one of the
other tools. Used to get back-and-forth context.

Typical flow: Claude calls `search` → picks a result → calls
`get_thread` with the result's thread_id → reads the full exchange.

### `list_accounts()`

Which accounts are known to the sync worker. Used by Claude at the
start of a session so it knows which tenants exist.

### `get_sync_status()`

Per-`(account, source)`: when it last synced successfully, how many
messages it added on the last run, any recent errors. **Critical** for
"is Claude's answer stale?" — Claude should check this at the top of
any triage.

---

## 3. System prompt for Claude Desktop

Paste this into Claude Desktop's system prompt slot for the waldo.WTF
project:

```
When I ask about my messages, emails, chats, or "wtf is going on":
1. First call get_sync_status() to verify freshness. If any account is
   stale (last_sync_at > 10 minutes old) or erroring, flag that before
   answering.
2. Then call list_accounts() if you haven't yet this session.
3. Default to checking ALL accounts and ALL sources unless I specify.
4. Call get_recent_activity(24) as the baseline, then drill deeper with
   search() or get_thread() as needed.
5. Surface what needs my attention: direct messages to me, questions
   awaiting my reply, @mentions, and senders I interact with often.
6. Do NOT read everything aloud. Triage. Group by theme. Be terse.
7. Never offer to reply, send, or archive — this server is read-only.
```

---

## 4. Daily workflows

### Morning triage

> *wtf is going on in my life?*

Claude pulls 24h of activity across all sources, groups by urgency,
flags stale accounts, shows you what you missed while asleep.

### "Did I reply to Sarah?"

> *Did I reply to Sarah's email about the Q2 release?*

Claude searches, finds the thread, pulls the full conversation, tells
you whether your last message is at the bottom or hers is.

### Customer meeting prep

> *What's the latest from the Defrancq tenant? Last two weeks.*

Claude filters on `accounts` and `sources`, returns a chronological
recap.

### WhatsApp catch-up (Weekend 6+)

> *What did my mom send me this weekend?*

Claude searches `source='whatsapp'`, returns parsed chat lines.

---

## 5. Adding more accounts

```sh
npm run login -- --account new
```

Follow the device-code prompt. MSAL persists the refresh token to the
on-disk cache and the sync loop picks up the new account on its next
tick (within 5 minutes). No restart needed.

## 6. Adding WhatsApp exports (Weekend 6+)

1. In WhatsApp → chat → Export chat → Without media.
2. Save or AirDrop to your Mac's `~/Downloads/`.
3. The chokidar watcher picks up `WhatsApp Chat*.txt` within seconds,
   parses it, inserts into the lake under `source='whatsapp'`, and
   moves the original to `~/WhatsAppArchive/YYYY-MM/`.
4. Ask Claude about it.

Re-exporting the same chat is idempotent (dedup hash on primary key) —
re-import as often as you like.

## 7. Deployment to Synology NAS (Weekend 5+)

See [setup.md §9](setup.md). Short version: Container Manager +
Tailscale + two bind mounts (`/data/db`, `/data/auth`) on internal SSD
— **never** an SMB share. Claude Desktop repoints from `localhost:8765`
to `waldo-nas.<tailnet>.ts.net:8765`.

## 8. Security hygiene

- **Never** screenshot a triage without redacting — it contains
  customer-tenant data.
- **Never** commit `.env`, `token-cache.json`, `accounts.json`, or
  `lake.db`. They're gitignored from day one.
- **Never** put the SQLite file on a network share. SMB + SQLite =
  corruption.
- **Never** expose the MCP port on the public internet. Tailscale only.
- Rotate the bearer token if you suspect compromise: regenerate in
  `.env`, restart the server, update Claude Desktop's config.
- Full-disk encryption on every machine that holds `lake.db`
  (FileVault on Mac, encrypted volume on Synology).

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `get_sync_status` shows account in error | Token expired or tenant revoked consent | Re-run `npm run login -- --account <email>` |
| Claude says "no recent activity" but mail is flowing | Sync worker crashed | Check logs for `delta_sync_failed`; restart `npm run dev` |
| SQLite "database is locked" | WAL mode lost, or db is on SMB | Confirm `journal_mode=wal`, move db to internal disk |
| MCP connection refused in Claude Desktop | Server not running, wrong port, or bearer mismatch | Curl the endpoint with `Authorization: Bearer ...`, verify |
| Duplicate rows after re-import | Primary key collision disabled or hash function changed | Never change the hash function post-release; add a migration |

## 10. What NOT to do

- Don't add MCP tools for things Claude can infer (`summarize_*`,
  `who_is_waiting_on_me`). Claude does that for free.
- Don't build an admin UI. Claude is the UI.
- Don't add retry queues or job systems. The next 5-minute poll picks
  up any transient failure.
- Don't add features that don't pass the "does this make 'wtf is going
  on?' better?" test.
