# Getting Started

Five-minute version. Assumes you already know what waldo.WTF is and why
(if not, read [../waldo.WTF-project-brief.md](../waldo.WTF-project-brief.md)
first).

For the full story, see [setup.md](setup.md).

---

## 1. Prereqs in one line

macOS + Node 22 + Xcode CLT + at least one Microsoft work account where
you can consent to `Mail.Read` without a tenant admin.

## 2. Register an Entra app (once)

Portal → Entra ID → App registrations → New:
- multitenant + personal accounts
- no redirect URI
- Authentication → "Allow public client flows" = Yes
- API permissions → Microsoft Graph → Delegated → `Mail.Read`

Copy the client ID.

## 3. Clone and configure

```sh
git clone git@github.com:waldo1001/waldo.WTF.git
cd waldo.WTF
cp .env.example .env   # edit MS_CLIENT_ID and BEARER_TOKEN
npm install
```

## 4. Log in your first account

```sh
npm run login -- --account new
```

Follow the device-code prompt. Sign in with the account you want
synced. Re-run to verify it's silent.

## 5. Start the sync worker + MCP server

```sh
npm run dev
```

Watch for `delta_sync_completed` in the logs. First run pulls your
whole inbox (minutes), subsequent runs are instant.

## 6. Wire Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "waldo-wtf": {
      "transport": "http",
      "url": "http://localhost:8765",
      "headers": { "Authorization": "Bearer YOUR_BEARER_TOKEN_FROM_.env" }
    }
  }
}
```

Restart Claude Desktop. For verification steps (curl `/health` and
`tools/list`) and troubleshooting, see
[claude-desktop-wiring.md](claude-desktop-wiring.md).

## 7. First prompt

Ask Claude:

> *wtf is going on in my life?*

Expect a triage across your mail, surfaced from the lake, with sender
names and one-line gists. This is the moment the project justifies its
name.

---

## Next steps

- Add more accounts: `npm run login -- --account new`, repeat.
- Mute noise as it shows up — either in-chat ("not interested in mails
  from DevOps" — Claude calls `add_steering_rule`), or from the shell
  with `npm run dev -- --steer-list` and friends. See
  [user-guide.md §6e](user-guide.md#6e-muting-noisy-senders-steering-rules).
- Read the [user guide](user-guide.md) for the full MCP tool surface
  and day-to-day workflows.
- When anything feels frustrating, write it in
  [../PROGRESS.md](../PROGRESS.md) under the current weekend's
  frustrations log. That's how v2 gets scoped.
