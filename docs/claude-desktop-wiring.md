# Wiring Claude Desktop to waldo.WTF

This is the operator recipe for pointing Claude Desktop at the local
MCP HTTP server shipped in Weekend 3. If you just want the system
prompt, that lives in [user-guide.md §3](user-guide.md).

---

## 1. Prerequisites

- `waldo.WTF` running locally (`npm run dev`) with at least one
  account logged in and one delta sync completed.
- `.env` populated — see [.env.example](../.env.example). You need:
  - `MS_CLIENT_ID` — your Entra app client ID
  - `BEARER_TOKEN` — generate with `openssl rand -hex 32`
  - `WALDO_PORT` — defaults to `8765` if unset
- Claude Desktop installed (macOS or Windows).

## 2. Verify the server is reachable

Before touching Claude Desktop, prove the server is up with `curl`. If
these two checks fail, Claude Desktop will also fail — fix it here
first.

**Health check** (no auth):

```sh
curl -sS http://localhost:8765/health
# → {"ok":true}
```

**JSON-RPC `tools/list`** (bearer required):

```sh
curl -sS http://localhost:8765/ \
  -H "Authorization: Bearer $BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should see three tools: `get_recent_activity`, `get_sync_status`,
`search`. That's everything shipped in Weekend 3. The other tools
documented in [user-guide.md §2](user-guide.md) (`get_thread`,
`list_accounts`) land in later weekends.

## 3. Claude Desktop config

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the `waldo-wtf` server under `mcpServers`:

```json
{
  "mcpServers": {
    "waldo-wtf": {
      "transport": "http",
      "url": "http://localhost:8765",
      "headers": {
        "Authorization": "Bearer YOUR_BEARER_TOKEN_FROM_DOT_ENV"
      }
    }
  }
}
```

Replace `YOUR_BEARER_TOKEN_FROM_DOT_ENV` with the exact value of
`BEARER_TOKEN` in `.env`. **Never commit this file.**

Restart Claude Desktop fully (quit + relaunch) — it reads the config
once at startup.

## 4. First prompt

In a new Claude Desktop conversation:

> *"Use waldo-wtf. Summarize my mail from the last 24 hours."*

Claude should call `get_sync_status` first (if you're using the
recommended system prompt), then `get_recent_activity` with
`hours: 24`, then summarize. If it picks `search` when you mention a
keyword, that's expected.

## 5. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Claude Desktop: "server not found" | Server not running | `npm run dev`; verify `/health` returns 200 |
| Claude Desktop: 401 unauthorized in logs | Bearer mismatch | Compare `.env` `BEARER_TOKEN` to the `Authorization` header in config |
| `tools/list` returns only `get_recent_activity` | Running a stale build | `git pull && npm run build` / restart `npm run dev` |
| `get_recent_activity` returns `count: 0` | First delta sync hasn't completed yet | Watch logs for `delta_sync_completed`; retry |
| `get_sync_status` rows all `stale: true` | Sync loop crashed or account login expired | Check `sync_log` table; re-run device code login |
| Empty `search` results but data exists | FTS5 index not populated | Restart; schema migration rebuilds the index on startup |

## 6. Security notes

- The MCP server binds to `localhost` only in dev. Do **not** expose
  `WALDO_PORT` on your LAN or public internet — anyone who can reach
  it and has (or can brute-force) the bearer token can read your mail.
- The `/health` endpoint intentionally skips auth. It returns only
  `{"ok": true}` — no data — so it's safe to probe.
- Rotate `BEARER_TOKEN` any time you suspect the config file leaked:
  edit `.env`, restart the server, update Claude Desktop config,
  restart Claude Desktop.
- Remote access (Synology + Tailscale) is a Weekend 5 concern — see
  [user-guide.md §5](user-guide.md).

---

Done. For the recommended system prompt and daily workflows, jump to
[user-guide.md §3](user-guide.md).
