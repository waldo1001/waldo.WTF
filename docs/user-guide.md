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
other tools. Used to get back-and-forth context. Resolves by the
stored `thread_id` column (oldest→newest, `limit` default 200, max
500). Covers both **Teams chats** (keyed on `chat.id`) and **Outlook
conversations** (keyed on Graph's `conversationId`). Outlook rows
synced before the slice-3 follow-up have `thread_id = NULL` until
their next delta touch; clear the delta token for a forced resync.

Typical flow: Claude calls `search` → picks a result → calls
`get_thread` with the result's `thread_id` → reads the full exchange.
Every projection (`search`, `get_recent_activity`, `get_thread`)
echoes an optional `threadId` field on each message, so the round-trip
needs no guessing.

### `list_accounts()`

Which accounts are known to the sync worker. Used by Claude at the
start of a session so it knows which tenants exist.

### `get_sync_status()`

Per-`(account, source)`: `lastSyncAt`, `lastOkAt`, `lastStatus`,
`lastError`, `messagesAddedLastOk`, `messagesAddedLast24h`, and a
`stale` flag (true when no successful sync in the last 15 minutes).
Top-level `generatedAt`, `accountsTracked`, `staleCount`. **Critical**
for "is Claude's answer stale?" — Claude should check this at the top
of any triage.

---

## 3. System prompt for Claude Desktop

Paste this into Claude Desktop's system prompt slot for the waldo.WTF
project:

```
When I ask about my messages, emails, chats, or "wtf is going on":
1. First call get_sync_status() to verify freshness. If staleCount > 0
   or any row has lastStatus="error", flag that before answering.
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

The end-to-end flow, once set up:

1. In WhatsApp → chat → **Export chat → Without media**.
2. Save (or Share → "Save to Files") the resulting file to
   **`~/WaldoInbox/`** on your Mac. iOS WhatsApp produces a `.zip`
   containing `_chat.txt`; Android usually produces a `.txt` directly.
   Both are supported — the importer handles either.
3. Within ~2s, a launchd agent fires `bin/wtf-whatsapp-push`, which
   scp's the file to the NAS inbox bind mount and moves the local copy
   to `~/WhatsAppArchive/YYYY-MM/`.
4. On the NAS, the running container has a chokidar watcher on the
   inbox folder. It picks up the new file within ~500ms of the scp
   finishing, parses it, inserts into the lake under
   `source='whatsapp'`, and moves the original to
   `/volume1/docker/waldo-wtf/data/whatsapp-archive/YYYY-MM/`.
5. Ask Claude about it.

No terminal command after step 2. Re-exporting the same chat is
idempotent (sha256 dedup on primary key) — re-import as often as you
like. If the export contains 1170 new messages and 50 old ones,
you'll see 1170 new rows land.

### 6a. Why `~/WaldoInbox` and not `~/Downloads`

macOS **TCC** (Transparency, Consent, Control) blocks launchd-spawned
shells from reading the protected user folders (`Downloads`,
`Documents`, `Desktop`) even when you grant the script Full Disk
Access. Interactive Terminal.app has the grant and works; the same
script under launchd silently sees an empty directory and reports
"no exports found". Attributing TCC to a shell script is unreliable
because the kernel sometimes checks the interpreter (`/bin/bash`)
instead of the script path.

The clean fix: use a dedicated folder outside the three protected
locations. `~/WaldoInbox/` is not TCC-gated, so launchd reads it
without any permission dance. The cost: one extra click in the
WhatsApp share sheet ("Save to Files → WaldoInbox" instead of
"Downloads").

### 6b. One-time setup

You only do these steps once per Mac.

**Create the inbox folder:**

```sh
mkdir -p ~/WaldoInbox
```

**Install an SSH key for passwordless scp to the NAS.**
`wtf-whatsapp-push` uses `scp -O` (Synology's SFTP subsystem is
disabled, so we force the legacy protocol). Key auth avoids a password
prompt on every export:

```sh
ssh-keygen -t ed25519 -C "waldo-mac"    # skip if ~/.ssh/id_ed25519 exists
ssh-copy-id waldo@waldonas3              # prompts for NAS password once
ssh waldo@waldonas3 "echo ok"            # verify: must print "ok" with no prompt
```

If `ssh-copy-id` succeeds but key auth still prompts — DSM refuses
pubkey auth when the home dir or `.ssh` is group-writable:

```sh
ssh waldo@waldonas3
chmod 700 ~ ~/.ssh
chmod 600 ~/.ssh/authorized_keys
exit
```

**Install the launchd WatchPaths agent.** It watches `~/WaldoInbox`
and fires the push script within ~1s of any file landing there. The
agent survives reboot. The script is a no-op on empty scans, so
stray non-WhatsApp files in the inbox are harmless.

```sh
sed "s|__HOME__|$HOME|g" \
  bin/com.waldo.wtf.whatsapp-push.plist \
  > ~/Library/LaunchAgents/com.waldo.wtf.whatsapp-push.plist

launchctl unload ~/Library/LaunchAgents/com.waldo.wtf.whatsapp-push.plist 2>/dev/null
launchctl load   ~/Library/LaunchAgents/com.waldo.wtf.whatsapp-push.plist
launchctl list | grep waldo.wtf
```

Last line should read `-\t0\tcom.waldo.wtf.whatsapp-push` — second
column `0` = loaded, no launch errors. If it's anything else, check
`/tmp/wtf-whatsapp-push.err`.

**Smoke-test** by moving any `WhatsApp Chat*.zip` you still have in
`~/Downloads` into `~/WaldoInbox`, then:

```sh
tail -f /tmp/wtf-whatsapp-push.log /tmp/wtf-whatsapp-push.err
```

Within ~2s you should see "Found 1 file(s)", an scp progress line, and
"moving local copies to ~/WhatsAppArchive/…". On the NAS:

```sh
sudo docker logs waldo-wtf --tail=10
sudo ls /volume1/docker/waldo-wtf/data/whatsapp-inbox \
        /volume1/docker/waldo-wtf/data/whatsapp-archive/$(date +%Y-%m)/
```

Inbox empty, file in archive, no error lines in the logs = end-to-end
working. The watcher logs only on failures, not successes — silent
success is the design.

### 6c. Downloads → WaldoInbox relay (optional but recommended)

In practice you'll export from WhatsApp on your phone and AirDrop to
the Mac, which always lands in `~/Downloads` (macOS has no setting to
change this). Rather than manually move every file into
`~/WaldoInbox`, attach a **Folder Action** to `~/Downloads` that does
the move for you. Finder (which hosts Folder Actions) has the
Downloads TCC grant that launchd lacks, so it can see the files and
move them — after which the launchd agent from §6b takes over as
normal.

The AppleScript source lives at
[../bin/folder-actions/wtf-whatsapp-relay.applescript](../bin/folder-actions/wtf-whatsapp-relay.applescript).
Install:

```sh
mkdir -p "$HOME/Library/Scripts/Folder Action Scripts"
cp bin/folder-actions/wtf-whatsapp-relay.applescript \
   "$HOME/Library/Scripts/Folder Action Scripts/"
osacompile \
  -o "$HOME/Library/Scripts/Folder Action Scripts/wtf-whatsapp-relay.scpt" \
  "$HOME/Library/Scripts/Folder Action Scripts/wtf-whatsapp-relay.applescript"

osascript <<'EOF'
tell application "System Events"
    set folder actions enabled to true
    set downloadsPath to (POSIX path of (path to downloads folder))
    try
        delete (every folder action whose name is "Downloads")
    end try
    set fa to make new folder action at end of folder actions ¬
        with properties {name:"Downloads", path:downloadsPath}
    tell fa
        make new script at end of scripts ¬
            with properties {name:"wtf-whatsapp-relay.scpt"}
    end tell
end tell
EOF
```

**Test** by renaming any WhatsApp zip inside `~/Downloads` (Finder
fires the action on "items added", which a rename counts as):

```sh
mv "$HOME/Downloads/WhatsApp Chat - BC Dev Talk.zip" \
   "$HOME/Downloads/tmp.zip"
mv "$HOME/Downloads/tmp.zip" \
   "$HOME/Downloads/WhatsApp Chat - BC Dev Talk.zip"
sleep 4
ls ~/Downloads/ ~/WaldoInbox/ ~/WhatsAppArchive/$(date +%Y-%m)/
```

Expected: file gone from `Downloads` and `WaldoInbox`, present in
`WhatsAppArchive/YYYY-MM/`. The launchd push log
(`/tmp/wtf-whatsapp-push.log`) should show "Found 1 file(s)" and a
successful scp.

**Uninstall**:

```sh
osascript -e 'tell application "System Events" to delete (every folder action whose name is "Downloads")'
rm "$HOME/Library/Scripts/Folder Action Scripts/wtf-whatsapp-relay.scpt"
rm "$HOME/Library/Scripts/Folder Action Scripts/wtf-whatsapp-relay.applescript"
```

### 6c-bis. Daily use

Export a WhatsApp chat → AirDrop or share-sheet to your Mac. The
Folder Action relays it into `~/WaldoInbox`, launchd pushes it to the
NAS, the container imports it and archives. You do nothing after the
export. Ask Claude Desktop *"What did my mom send me this weekend?"*
five minutes later.

### 6d. Troubleshooting the auto-push

| Symptom | Cause | Fix |
|---|---|---|
| `launchctl list` shows non-zero in col 2 | Script failed to launch | `cat /tmp/wtf-whatsapp-push.err` for the error |
| "No WhatsApp exports found" but file is present | Filename doesn't start with `WhatsApp Chat ` (e.g. you renamed it) | Rename it back, or run the push script manually |
| "Permission denied" on scp | NAS dir perms regressed | On NAS: `sudo chown waldo:1000 data/whatsapp-inbox data/whatsapp-archive && sudo chmod 775 data/whatsapp-*` |
| "subsystem request failed on channel 0" | Using plain `scp` instead of `scp -O` | Script already passes `-O`; check you haven't shadowed it |
| scp prompts for password | Key not installed / wrong perms on NAS `~/.ssh` | Redo §6b step "Install an SSH key" |
| Agent doesn't fire on new files | Plist points at wrong `WatchPaths` | Inspect `~/Library/LaunchAgents/com.waldo.wtf.whatsapp-push.plist` |
| `EXDEV: cross-device link` in container logs | Archive and inbox are on different mounts — should be handled | Check `src/fs-node.ts` has the copy+unlink fallback |
| Launchd agent silently reads empty dir | You're watching a TCC-protected folder (`Downloads`, `Documents`, `Desktop`) | Don't. Use `~/WaldoInbox` |

**Uninstall:**

```sh
launchctl unload ~/Library/LaunchAgents/com.waldo.wtf.whatsapp-push.plist
rm             ~/Library/LaunchAgents/com.waldo.wtf.whatsapp-push.plist
```

### 6c. Working from anywhere (Tailscale)

Both your Mac and the NAS are on your tailnet, so `waldonas3` resolves
and routes the same way from home, a hotel, or cellular. The push
script and the Claude Desktop MCP endpoint both keep working — no VPN
toggle, no port forwarding, no DDNS. If you ever disable MagicDNS, use
the full FQDN `waldonas3.<tailnet>.ts.net` instead. **Do not expose
port 8765 on the public internet** — Tailscale is the authentication
boundary.

**One-shot import** (bypasses the watcher, useful for backfilling):

```sh
npm run dev -- --import-whatsapp
```

Scans `WALDO_WHATSAPP_DOWNLOADS_PATH` for `WhatsApp Chat*.txt`, imports
each, archives to `WALDO_WHATSAPP_ARCHIVE_PATH/YYYY-MM/`, and exits.

**Env knobs** (all optional; sensible defaults):

| Var | Default | Purpose |
|---|---|---|
| `WALDO_WHATSAPP_WATCH` | unset | Set to `true` to start the chokidar watcher in the main process |
| `WALDO_WHATSAPP_DOWNLOADS_PATH` | `~/Downloads` | Where to watch / scan for exports |
| `WALDO_WHATSAPP_ARCHIVE_PATH` | `~/WhatsAppArchive` | Where imported files are moved |
| `WALDO_WHATSAPP_ACCOUNT` | `whatsapp-local` | `account` column value for imported rows |

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
