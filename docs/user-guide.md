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

Nine tools total. Claude chooses which to call.

### `get_recent_activity(hours, sources?, accounts?, kinds?, to?)`

"What's happened recently — and what's coming up". Default `kinds` is
`["message", "event"]`: a single chronological `items` feed mixing past
messages (`from = now - hours`) with calendar events up to `to`
(default `now + 7d` when events are included). Each item is
`{kind: "message", at, message}` or `{kind: "event", at, event}`,
ordered by `at` ascending. Filter by `sources`
(`["outlook", "teams", "teams-channel", "whatsapp", "viva-engage"]`,
messages only) or `accounts` (`["your@email.com"]`, both kinds) to
narrow. `teams` is 1:1 and group chats; `teams-channel` is messages
from channels you've explicitly subscribed to via `--teams-subscribe`
(see §5c).

Pass `kinds: ["message"]` to get the original messages-only response
shape (`{count, messages, muted_count}`) unchanged — useful when the
question is purely about messages and the mixed feed would just add
noise. `kinds: ["event"]` returns event items only, still in the new
`items` shape.

Each message item carries an optional `replied: boolean` — true iff
the latest in-window message in that thread has `fromMe: true` (your
own reply). Answers *"did I reply to X?"* in a single call. Messages
without a `threadId` are not annotated.

Typical prompt: *"What's on my plate?"* (mixed feed — recent mail plus
upcoming meetings) or *"What happened in the last 4 hours across all my
accounts?"* (`kinds: ["message"]`) or *"Which mails from today am I
still on the hook for?"* — Claude reads `replied=false` rows to build
the last answer.

### `search(query?, sender_email?, sender_name?, after?, before?, limit?, include_body?, kinds?)`

Full-text search via SQLite FTS5 over `thread_name`, `sender_name`,
`body`, plus optional structured filters on the stored From header and
`sent_at`. At least one of `query`, `sender_email`, or `sender_name`
must be present.

`kinds` defaults to `["message"]`, keeping the original response shape
(each hit carries `message` directly). Pass `kinds: ["transcript"]` or
`["message", "transcript"]` to also full-text search meeting
transcripts (requires `--transcripts-enable` for the account, §5e) —
once `kinds` includes `"transcript"`, every hit gains a `kind` field
plus either `message` or `segment`. `sender_email` / `sender_name` /
`after` / `before` / `include_body` are message-only — a
transcript-only search (`kinds: ["transcript"]`) ignores them and only
ever uses `query`; passing no query text with `kinds: ["transcript"]`
returns zero transcript hits, not an error. Transcript hits are never
filtered by steering (transcripts attach to events, which already have
their own steering predicates — same carve-out as `get_event`).

- `sender_email` — case-insensitive exact match on the From header
  address. Hits messages *from* that address, not just ones mentioning
  it in the body.
- `sender_name` — case-insensitive substring match on the From header
  display name. Handles "Gunter Peeters" vs "Peeters, Gunter".
- `after` / `before` — ISO 8601 bounds on `sent_at`. `after` is
  inclusive, `before` is exclusive.
- When `query` is omitted, results are ordered `sent_at DESC` instead
  of BM25 rank.

Structured filters compose with `query` and with steering via AND;
`muted_count` is scoped to the same filter set.

Pass `include_body: true` when the user wants the full text of the
matched messages (e.g. *"read me the mail"*); bodies are head-truncated
per message (50k chars, flagged with `bodyTruncated: true`) and the
response carries `bodyBudgetExhausted: true` when later hits had to be
returned without a body to protect context.

Typical prompts:
- *"Search for any mention of 'Q2 release' in the last month."*
- *"What has Gunter Peeters sent me in the last 30 days?"* →
  `sender_name: "peeters"`, `after: "2026-03-21"`.
- *"Find emails from Defrancq about the pricing proposal."* →
  `sender_name: "defrancq"`, `query: "pricing"`.
- *"Did anyone say 'budget' in a meeting recently?"* →
  `query: "budget"`, `kinds: ["transcript"]`.

### `get_thread(thread_id, limit?, include_body?, from_start?)`

Pull a conversation given a `thread_id` returned by one of the other
tools. Used to get back-and-forth context. Resolves by the stored
`thread_id` column (`limit` default 200, max 500). Covers **Teams
chats** (keyed on `chat.id`), **Outlook conversations** (keyed on
Graph's `conversationId`), and **WhatsApp chats** (keyed on the
normalized chat name). Outlook rows synced before the slice-3
follow-up have `thread_id = NULL` until their next delta touch; clear
the delta token for a forced resync.

**Default returns the LATEST `limit` messages**, ordered
chronologically (oldest→newest) within the returned slice. This is
what almost every prompt wants ("summarize today's discussion in X",
"what did Y say recently", "catch me up"). For long threads (>500
messages), the older messages beyond the slice are simply not
returned — there's no pagination today.

Pass `from_start: true` only when the user explicitly asks how a long
conversation began ("how did this thread start", "what was the
original message"). With `from_start: true` you get the first `limit`
messages (the original behavior up to 2026-05-03).

Pass `include_body: true` when the user wants the message text itself
(e.g. *"what did it say"*, *"summarize"*). Same truncation and budget
semantics as `search`.

Outlook threads interleave inbound and outbound: messages the user
sent (ingested from the Sent Items folder) appear alongside inbound
replies in `sent_at` order, each marked with `fromMe: true`. This
makes *"read back my last reply in this thread"* and *"did I answer
clearly?"* directly answerable.

Typical flow: Claude calls `search` → picks a result → calls
`get_thread` with the result's `thread_id` → reads the full exchange.
Every projection (`search`, `get_recent_activity`, `get_thread`)
echoes an optional `threadId` field on each message, so the round-trip
needs no guessing.

### `find_events(from?, to?, accounts?, subject_contains?, attendee?, order?, limit?, include_muted?)`

Agenda **and** history search over calendar events. Default (no args):
next 7 days across all calendar-enabled accounts, soonest first. Pass
`subject_contains` and/or `attendee` to search the full ~year of
synced history — "when is the meeting about the office move", "did I
already plan something with Kristof" — both are case-insensitive
substring matches (subject text; attendee display name, email, or
organizer). Setting either filter lifts the normal 92-day window cap
that otherwise bounds unfiltered queries. Use `order: "desc"` for
history questions (most recent match first); leave it at the default
`"asc"` for agenda questions. `truncated: true` in the response means
there were more matches than the `limit` (default 100, max 250) —
narrow the query rather than assume you saw everything. Prefer this
tool over `search` or `get_recent_activity` for anything about a
meeting or appointment. Needs `--calendar-enable` to have been run for
an account first (§5d) — otherwise there's nothing to find.

Events matching an `event_organizer_email` or `event_subject_contains`
steering rule are hidden by default (`muted_count` + `steering_hint`
report how many, same UX as `search`/`get_recent_activity`); pass
`include_muted: true` to see them (§6e).

### `get_event(event_id, account?, include_transcript?)`

Look up a single calendar event by id — take the id from a prior
`find_events` result. Returns the event, its attendees, and — for
online meetings — the last 50 messages from the linked Teams
meeting-chat, so "what did we say in the chat for the budget review
meeting" is one call once you have the event id. `linkedChat` is
`null` for in-person meetings; it's `{chatId, messages: []}` rather
than an error when the meeting is online but the chat sync hasn't
caught up yet. Steering does **not** apply here — neither to the event
itself nor to `linkedChat.messages` — same carve-out as `get_thread`.
Calendar sync is per-account opt-in (see §5d) — accounts that haven't
run `--calendar-enable` have no events for this tool to find.

Pass `include_transcript: true` to also pull the meeting transcript
into `linkedTranscript` (same shape as `get_event_transcript` below) —
useful for "give me everything about meeting X" in one call. The field
is absent entirely when not requested, not `null`.

### `get_event_transcript(event_id, account?)`

Return just the transcript for a calendar event — `{transcript,
segments}`. `transcript` is `null` and `segments` is `[]` when nothing
was fetched yet; this single shape covers "not transcribed", "sync
hasn't run", "quota-exhausted", and "fetch failed" indistinguishably —
check `get_sync_status`/`diagnose_sync_health` if the caller needs to
tell those apart. Requires `--transcripts-enable` for the account
(§5e); an event can accumulate more than one transcript row (e.g. a
recording restart) — this always returns the most recently fetched
*successful* one. No steering, same carve-out as `get_event`.

### `list_accounts()`

Which accounts are known to the sync worker. Used by Claude at the
start of a session so it knows which tenants exist.

### `list_threads(source)`

Diagnostic inventory of every distinct thread stored for a given
source (`outlook`, `teams`, `teams-channel`, `whatsapp`, or
`viva-engage`), with `messageCount` and
`newestSentAt` / `oldestSentAt`. Ordered newest-first by the latest
message in each thread.

Use it to: (a) discover the opaque `threadId` values that `get_thread`
expects, (b) detect bifurcated threads — e.g. a WhatsApp export
re-imported under a different filename produces two rows with the same
display name but distinct `threadId`s. **Not affected by steering
rules** — diagnostic tools always return the full inventory.

Typical prompt: *"List every WhatsApp thread in the lake — are any of
them split into duplicates?"*

### `get_sync_status()`

Per-`(account, source)`: `lastSyncAt`, `lastOkAt`, `lastStatus`,
`lastError`, `messagesAddedLastOk`, `messagesAddedLast24h`, and a
`stale` flag (true when no successful sync in the last 15 minutes).
Top-level `generatedAt`, `accountsTracked`, `staleCount`. **Critical**
for "is Claude's answer stale?" — Claude should check this at the top
of any triage.

### `diagnose_sync_health()`

Zero-input, read-only triage tool. Scans `sync_log`, `sync_state`,
`accounts`, and `viva_subscriptions` and returns a ranked list of
findings — each with a `category`, `severity`, and a paste-ready
`remediationPrompt` you can hand to a fresh agent session.

Categories: `auth` (token expired), `rate-limit` (server-imposed
backoff), `delta-invalid` (cursor rejected, resync needed), `stale`
(no ok tick in ≥15 min), `repeated-failure` (≥3 consecutive errors),
`viva-sub-drift` (enabled Viva subscription with no posts in 24h),
`never-synced` (account present but never ticked), `unknown-error`
(unclassified). `overallStatus` rolls up to `healthy` / `degraded` /
`critical`.

`lastError` strings are redacted (Bearer tokens, long opaque blobs)
before surfacing in either `evidence` or `remediationPrompt` — safe
to paste into chat. Typical prompt: *"is anything wrong with
sync?"* — Claude calls this, names the affected accounts, and
surfaces the first remediation prompt verbatim.

---

## 3. System prompt for Claude Desktop

Paste this into Claude Desktop's system prompt slot for the waldo.WTF
project:

```
When I ask about my messages, emails, chats, or "wtf is going on":
1. First call get_sync_status() to verify freshness. If staleCount > 0
   or any row has lastStatus="error", flag that before answering.
   For a ranked, remediation-ready view (auth expiry, rate-limit,
   stale, viva-sub drift, etc.), call diagnose_sync_health() instead.
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

## 5b. Subscribing to Viva Engage communities

**Upgrading from before 2026-04-22 (hotfix)?** Earlier builds mixed
Graph and Yammer scopes in a single token request, causing
`--add-account` to fail with `invalid_grant`. Delete the MSAL cache
file (`sudo rm /volume1/docker/waldo-wtf/auth/token-cache.json` on
the NAS) then re-run `--add-account <username>` once per account.

**First `--viva-discover` on any account will show a second device-code
prompt.** `--add-account` consents the Graph scopes (`Mail.Read`,
`Chat.Read`). The Yammer scope (`api.yammer.com/user_impersonation`) is
a different resource and is consented automatically the first time you
run `--viva-discover` — follow the second device-code URL, sign in with
the same account, and the token is cached for all subsequent calls.

Viva Engage subscriptions are explicit per `(account, community)` —
nothing is auto-discovered, so the lake only ingests communities you
opted into. The CLI lives next to the existing `--steer-*` family.

```sh
# List Viva subscriptions for an account
npm run dev -- --account your@email.com --viva-list

# Discover: enumerate every Yammer network + community the account can see,
# including external/guest networks (which the Graph API cannot return).
# On first run triggers a Yammer consent device-code prompt.
npm run dev -- --account your@email.com --viva-discover

# Subscribe: pick a community_id from --viva-discover. The CLI re-queries
# Yammer to capture (networkId, networkName, displayName) so re-syncs
# don't need to rediscover. Unknown ids fail fast with a pointer back to
# --viva-discover.
npm run dev -- --account your@email.com \
  --viva-subscribe 00000000-0000-0000-0000-000000000001

# If the same community_id appears in two networks, use the colon format
# to disambiguate: <networkId>:<communityId>
npm run dev -- --account your@email.com \
  --viva-subscribe net-123:00000000-0000-0000-0000-000000000001

# Unsubscribe (rows already in the lake stay; only stops new pulls)
npm run dev -- --account your@email.com \
  --viva-unsubscribe 00000000-0000-0000-0000-000000000001
```

Once subscribed, the next sync tick pulls posts under
`source: "viva-engage"` and threads them as
`viva:{networkId}:{communityId}:{conversationId}`. Per-community
errors are isolated — a single failing community does not stop the
others on the same tick. Requires the Yammer `user_impersonation`
Entra delegated permission (see [setup.md §2](setup.md)).

### 5b.1. External Viva Engage networks (guest access)

If the communities you care about live in someone else's tenant — for
example the Microsoft-hosted **BC Partners** communities, where you're
a B2B guest — a normal `--add-account` won't reach them. A token
issued via the default `/common/` authority is scoped to your home
tenant's Yammer network only, so `--viva-discover` returns zero
communities even though the Viva Engage web UI shows plenty.

Fix: add a **per-tenant** Viva account. Pass `--tenant <guid>` (the
external tenant's Entra tenant id) to `--add-account`:

```sh
# Add a Viva-only account for an external tenant. Uses the Azure CLI
# public client id (pre-consented globally, so no "Admin consent
# required" wall) and requests only the Yammer scope.
npm run dev -- --add-account \
  --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47
```

Sign in with the same email you use day to day. Behind the scenes,
waldo.WTF records a `(homeAccountId, externalTenantId)` registration
in `data/auth/viva-external-tenants.json` (mode 0600) so future
`--viva-discover` runs know to redeem a token against that external
tenant's authority. From here on,
`--viva-discover --account your@email.com` fans out — once against
your home tenant, then once per registered external tenant — and
merges the results. The output gains a `tenant_id` column so you can
tell which tenant each community belongs to:

```
community_id	network_id	network_name	tenant_id	display_name
238049591296	107	Microsoft	72f988bf-…	BC Partners | AI, Agents, and Copilot
240148481123	240148481	Dynex	d1…	General
```

If the same community id appears in more than one tenant, subscribe
with the three-part colon form:

```sh
npm run dev -- --account your@email.com \
  --viva-subscribe 72f988bf-86f1-41af-91ab-2d7cd011db47:107:238049591296
```

The two-part form `<networkId>:<communityId>` still works for within-
tenant disambiguation. A plain `<communityId>` still auto-resolves if
it's unique across all cached tenants.

**Dependency note**: external-tenant Viva auth uses the Azure CLI
first-party public client id (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`).
It's a well-known public identifier, pre-consented in every Entra
tenant — the same trick `az login` uses. If Microsoft ever revokes it
for third-party tools, external-network discovery breaks; a follow-up
would be a verified-publisher registration for waldo.WTF itself.

## 5c. Subscribing to Teams channels

Teams **channel** messages are a separate source from Teams 1:1 / group
chats — they live under `source: "teams-channel"` and are opt-in per
channel, mirroring the Viva Engage subscription pattern. Nothing is
auto-synced; the lake only ingests channels you explicitly subscribed
to. `get_recent_activity` and `search` accept `teams-channel` in their
`sources` filter so you can mute the noise of org-wide broadcasts
independently of personal chats.

```sh
# List Teams channel subscriptions for an account
npm run dev -- --account your@email.com --teams-list

# Discover: enumerate every team + channel the account can read,
# fanned out across every cached MSAL tenant for that username.
# On first use, prompts a device-code flow if the new scopes
# (Team.ReadBasic.All, Channel.ReadBasic.All, ChannelMessage.Read.All)
# need consent. Tenants that require admin consent for
# ChannelMessage.Read.All print one "skipped tenant <id>: admin-consent
# required" line and the rest of the tenants still resolve. Output
# columns: tenant_id, team_id, channel_id, team_name, channel_name.
npm run dev -- --account your@email.com --teams-discover

# Subscribe to one channel. Two-segment form works when the (teamId,
# channelId) pair is unambiguous across cached tenants. Real Graph
# channel IDs always start with "19:" and contain colons and "@" —
# paste them as-is, no escaping needed:
npm run dev -- --account your@email.com \
  --teams-subscribe <teamId>:19:<channelHash>@thread.tacv2

# Three-segment form (recommended for users with multiple cached
# tenants under the same UPN) makes the tenant explicit. The
# tenant_id comes from the first column of --teams-discover output:
npm run dev -- --account your@email.com \
  --teams-subscribe <tenantId>:<teamId>:19:<channelHash>@thread.tacv2

# Unsubscribe (rows already in the lake stay; only stops new pulls)
npm run dev -- --account your@email.com \
  --teams-unsubscribe <teamId>:<channelId>

# Print a tenant-wide admin-consent URL per cached MSAL tenant.
# Use this when --teams-discover prints "skipped tenant <id>:
# admin-consent required" for a tenant where you ARE an admin.
# Open the URL on your workstation, sign in as the tenant admin,
# click Accept once. The next sync tick will silently mint a
# channels-scoped token against the existing refresh token — no
# re-add-account needed.
npm run dev -- --account your@email.com --teams-admin-consent
```

Once subscribed, the next sync tick pulls channel messages via Graph's
delta endpoint (`/teams/{id}/channels/{id}/messages/delta` with
`$expand=replies`) and threads each conversation as
`teams-channel:<teamId>:<channelId>:<rootId>` — root post and replies
stay together, just like the Teams UI shows them. Per-channel errors
are isolated; one failing channel does not stop the others on the same
tick. If a tenant has not consented `ChannelMessage.Read.All` for the
app, the scheduler logs one `admin-consent-required` row per affected
account per tick and moves on.

Steering rules apply to channel rows the same way they apply to any
other source — `add_steering_rule(rule_type="thread_id", pattern=…)`
mutes a single channel-thread without touching anything else, and
`source: "teams-channel"` scopes a rule to channels only.

## 5d. Enabling calendar sync (per-account opt-in)

Unlike every other source, calendar sync is **off by default for every
account** — enable it only for the accounts whose agenda you actually
want in the lake.

```sh
# Enable calendar for one account. Prompts a device-code login
# requesting the Calendars.Read scope alongside the base scopes —
# this is the ONLY account that gets prompted; every other account is
# untouched. If the tenant requires admin consent for Calendars.Read,
# the command fails with a message naming the scope and tenant to hand
# to your admin, and nothing is written.
npm run dev -- --calendar-enable your@email.com

# Disable calendar for an account. Removes the opt-in row only —
# events already synced into the lake are kept, not deleted.
npm run dev -- --calendar-disable your@email.com
```

Once enabled, the next sync tick walks `/me/calendarView/delta` over a
rolling `[now − 365 days, now + 60 days]` window on first sync (so
"when did we meet about X" works for the past year), then resumes from
the stored delta cursor on every later tick.

```sh
# Operator-side inspection: print the next 7 days across every
# calendar-enabled account. Read-only.
npm run dev -- --calendar-list

# Clear the stored delta cursor for every calendar-enabled account, so
# the next scheduler tick re-walks the full window from scratch.
npm run dev -- --calendar-resync

# Clear just one account's cursor.
npm run dev -- --calendar-resync --account your@email.com
```

Ask Claude directly once an account is enabled and has synced —
`find_events` is the query tool (§2).

## 5e. Enabling meeting transcripts (per-account opt-in, requires calendar)

Meeting transcript sync is layered on top of calendar sync and is
**also off by default**. `--transcripts-enable` requires the account
already be calendar-enabled (§5d) — it errors with a pointer to
`--calendar-enable` otherwise.

```sh
# Enable transcripts for one account. Requires --calendar-enable to
# have been run for that account first. Prompts a device-code login
# requesting OnlineMeetings.Read + OnlineMeetingTranscript.Read.All
# alongside the account's
# existing scopes (Entra treats this as one combined consent grant —
# it does not re-prompt for Mail.Read/Chat.Read/Calendars.Read). If the
# tenant requires admin consent, the command fails with a message
# naming the scope, and the flag is not set.
npm run dev -- --transcripts-enable your@email.com

# Disable transcripts for an account. Clears the flag only — already
# fetched transcripts are kept, not deleted, and calendar sync for
# that account is unaffected.
npm run dev -- --transcripts-disable your@email.com
```

Before enabling, read the metering and meeting-expiration notes in
[setup.md](setup.md) — transcript *content* fetches are a metered
Graph API (free tier ~600 min/month/tenant/app, then billed), and the
API only works for meetings that haven't expired, so enabling
transcripts today cannot recover transcripts for meetings that already
happened.

Once enabled, transcript sync runs automatically on the next scheduler
tick (same background loop as everything else) — no separate command
needed. Query what was fetched with `get_event_transcript` (§2) or via
`get_event`'s `include_transcript` flag when you already have the
event id, or with `search(..., kinds: ["transcript"])` when you don't
— e.g. "did anyone say X in a meeting?".

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
you'll see 1170 new rows land. Chat names are normalized on import
(whitespace collapsed, trailing ` (…)` parenthetical suffix stripped),
so `WhatsApp Chat - General chat.zip` and `WhatsApp Chat - General
chat (BC Dev Talk).zip` converge on the same thread.

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
working. On every container start the watcher also sweeps any files
already sitting in `whatsapp-inbox/` (so a restart mid-drop doesn't
strand them) and emits one `whatsapp_sweep_complete: files=<N>
imported=<M>` line. Per-file failures log as
`whatsapp_parse_failed` (bad zip / unparseable chat) or
`whatsapp_archive_failed` (rename to archive dir failed, usually
EACCES / ENOSPC) — the file stays in the inbox and the next sweep
retries, safe because message ids are content-hashed.

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

## 6e. Muting noisy senders and meetings (steering rules)

`get_recent_activity` and `search` hide messages, and `find_events`
plus the event side of `get_recent_activity` hide calendar events,
that match **steering rules** by default. Rules are stored in the
lake's `steering_rules` table; sync is never touched — all
messages/events are still in the database, you just don't see them on
the default read path. Think of steering as a *lens*, not a filter:
every muted row is one `include_muted: true` away from returning.

Message-targeted and event-targeted rules never cross over: muting a
sender doesn't hide their meeting invites, and muting a meeting
organizer doesn't hide their emails. Each rule type only ever applies
to the one side it targets.

### Via Claude Desktop (the expected path)

Talk to it. When Claude surfaces something low-signal, say:

> *Not interested in mails from DevOps.*

Claude calls `add_steering_rule(rule_type="sender_domain",
pattern="devops.example.com", reason="too noisy")`. Next `search` or
`get_recent_activity` skips those rows and returns `muted_count` + a
`steering_hint` telling Claude how many were hidden. For meetings:

> *Hide the recurring standup invites.*

Claude calls `add_steering_rule(rule_type="event_subject_contains",
pattern="standup")`, and `find_events` / `get_recent_activity` skip
those events the same way. Claude can also:

- `get_steering()` to list all rules (enabled + disabled, both kinds).
- `remove_steering_rule(id)` to drop one.
- `set_steering_enabled(id, enabled)` to temporarily un-mute without
  deleting the rule.

`get_thread`, `get_event`, `get_event_transcript`, and `list_accounts`
are **not** filtered — once you open a thread or look up a specific
event you see everything in it, and account listing is metadata.

### Rule types

Message-targeted:

- `sender_email` — exact match on sender address (case-insensitive).
- `sender_domain` — sender email ends with `@<pattern>`.
- `thread_id` — exact match on thread id.
- `thread_name_contains` — case-insensitive substring on thread name.
- `body_contains` — keyword/phrase search in the message body.

Event-targeted:

- `event_organizer_email` — exact match on the event organizer's
  address (case-insensitive).
- `event_subject_contains` — case-insensitive substring on the event
  subject.

### Carve-out for your own replies

`sender_email`, `sender_domain`, and `body_contains` rules **do not
mute rows with `fromMe: true`** — ingested from Outlook Sent Items.
Muting a correspondent must not hide your own outgoing reply in that
thread, otherwise `replied=true` annotations would under-report. The
two thread-level rule types (`thread_id`, `thread_name_contains`)
still mute fromMe rows because muting a whole conversation is a
stronger, explicit intent. `muted_count` reflects what was actually
muted. (Event-targeted rules have no `fromMe`-equivalent concept —
there is no "your own meeting" carve-out.)

### Via the CLI (for bulk setup and recovery)

Same store, different frontend. Useful for scripting, bulk imports,
and recovery outside a chat session.

```sh
# add a rule — pick the right type
npm run dev -- --steer-add-sender  "noise@example.com"
npm run dev -- --steer-add-domain  "marketing.example.com" --reason "newsletters"
npm run dev -- --steer-add-thread  "AAMkA...thread-id"
npm run dev -- --steer-add-thread-name "[Jira]"
npm run dev -- --steer-add-body    "sync fail"
npm run dev -- --steer-add-event-organizer "noisy@example.com"
npm run dev -- --steer-add-event-subject   "daily standup"

# optional modifiers narrow a rule to one source / account:
npm run dev -- --steer-add-sender  "bob@example.com" \
    --source outlook --account me@example.com

# list / toggle / remove
npm run dev -- --steer-list
npm run dev -- --steer-disable 3
npm run dev -- --steer-enable  3
npm run dev -- --steer-remove  3
```

Rule types:

| Type | Matches | Notes |
|---|---|---|
| `sender_email` | exact `sender_email` | lowercased |
| `sender_domain` | `sender_email` ends with `@<pattern>` | reject patterns containing `@` |
| `thread_id` | exact `thread_id` | mute one conversation |
| `thread_name_contains` | case-insensitive substring on `thread_name` | good for `[Jira]`, `out of office` |
| `body_contains` | FTS5 match on the body | single word or phrase |
| `event_organizer_email` | exact event `organizer_email` | lowercased; event-targeted only |
| `event_subject_contains` | case-insensitive substring on event `subject` | event-targeted only |

### Why add-tools on a "read-only" MCP surface

Project brief §9 says no MCP write tools, so a compromised bearer
can't send, reply, delete, or archive across four Microsoft accounts.
Steering rules are a scoped exception: they write only to
`steering_rules` in the local SQLite lake — no Graph API call, no
external blast radius. The worst an attacker can do is hide messages
from you, which is fully reversible by calling `remove_steering_rule`.
That carve-out is documented in [CLAUDE.md](../CLAUDE.md) so the
constraint stays unambiguous.

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
| Adding the connector fails at registration (`invalid_redirect_uri`) | The client's OAuth callback is not on the redirect allowlist | Find the URI in the server log line `oauth_dcr_redirect_rejected`; if it is legitimate, add it to `WALDO_OAUTH_REDIRECT_ALLOWLIST` and restart — see [oauth.md §1.1](oauth.md) |
| `get_sync_status` shows account in error | Token expired or tenant revoked consent | Re-run `npm run login -- --account <email>` |
| Claude says "no recent activity" but mail is flowing | Sync worker crashed | Check logs for `delta_sync_failed`; restart `npm run dev` |
| SQLite "database is locked" | WAL mode lost, or db is on SMB | Confirm `journal_mode=wal`, move db to internal disk |
| MCP connection refused in Claude Desktop | Server not running, wrong port, or bearer mismatch | Curl the endpoint with `Authorization: Bearer ...`, verify |
| Adding the connector fails with `429` or `503` | OAuth rate limit or client cap hit ([oauth.md §1.2](oauth.md)) | Wait the `Retry-After` time; for 503 revoke stale clients or raise `WALDO_OAUTH_MAX_CLIENTS` |
| Static bearer gets `401` on the public URL | Since 2026-10-12 the public (OAuth-enabled) port accepts OAuth tokens only | Use the claude.ai connector (OAuth), or — on the server host only — `http://127.0.0.1:$WALDO_INTERNAL_PORT/mcp` ([oauth.md](oauth.md)) |
| Duplicate rows after re-import | Primary key collision disabled or hash function changed | Never change the hash function post-release; add a migration |
| `--viva-discover` shows "no viva communities" despite having communities | Yammer API returned suggested groups (empty for guests in external networks) | Fixed in 2026-04-23 deploy — upgrade and re-run `--viva-discover` |
| `--teams-discover` prints `admin-consent required` and returns no channels | Tenant has not consented `ChannelMessage.Read.All` for the app | Ask tenant admin to grant consent, or use a different account; other sources keep working |
| `sync_log` shows `admin-consent-required` rows for a teams-channel account every tick | Same as above — scheduler degrades cleanly per-account | Either grant the consent or `--teams-unsubscribe` the affected channels to silence the rows |
| `get_event_transcript` returns `transcript: null` for every meeting, and `transcripts` sync_log rows say `ok` with 0 fetched | Before the 2026-08-20 fix, transcripts were looked up with the audio dial-in id and always 404'd | Deploy 2026-08-20 or later, re-run `--transcripts-enable <account>` (adds `OnlineMeetings.Read`), then run the [repair-transcript-linkage](../docs/migrations/repair-transcript-linkage.md) migration to clear the false markers |
| `transcripts` sync_log rows say "Graph API access to transcripts is disabled for this tenant" | Tenant-wide Teams admin toggle, **off by default**; no app permission overrides it | A Teams admin must enable it: Teams admin center > Meetings > Meeting settings > Transcript API access > Microsoft Graph access (plus **Include speaker attribution**, a separate toggle also off by default), or `Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess $true -EnableAttributedTranscripts $true -Identity Global` |
| Transcript exists in Teams but the lake says `not-available` | Meeting expired past Teams' retention, or it resolves only for the organizer (see the open question in the plan) | Check `find_events` shows the meeting; transcripts are only fetchable for meetings that ended within the last 60 days |
| MCP tool error surfaces `<ErrorClass>: <message>` (e.g. `SqliteError: database is locked`) | The handler threw; the message is the first line of the underlying exception, secrets-redacted | Treat the class as the diagnosis; full stack is in NAS container stderr (`docker logs <ctr>`) — grep for `[mcp tool handler]` |

## 10. What NOT to do

- Don't add MCP tools for things Claude can infer (`summarize_*`,
  `who_is_waiting_on_me`). Claude does that for free.
- Don't build an admin UI. Claude is the UI.
- Don't add retry queues or job systems. The next 5-minute poll picks
  up any transient failure.
- Don't add features that don't pass the "does this make 'wtf is going
  on?' better?" test.
