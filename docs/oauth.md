# OAuth 2.1 operator guide

This document covers setting up the OAuth 2.1 surface so claude.ai or Claude mobile can connect to waldo.WTF without the static bearer token.

---

## 1. Prerequisites

| Var | Required | Notes |
|-----|----------|-------|
| `WALDO_PUBLIC_URL` | Yes | Externally reachable base URL of the MCP server (https, no trailing slash). Enables all OAuth routes. |
| `WALDO_ADMIN_PASSWORD` | Yes | Passphrase shown on the consent page when a client registers. Generate: `openssl rand -hex 24` |
| `BEARER_TOKEN` | Keep | **Not accepted on the public port** once `WALDO_PUBLIC_URL` is set. Only honoured on the internal listener (`WALDO_INTERNAL_PORT`). |
| `WALDO_INTERNAL_PORT` | Optional | Loopback-only (`127.0.0.1`) listener that accepts the static bearer and has no OAuth routes. For headless local clients (Jarvis). Never Serve/Funnel it. |
| `WALDO_DISABLE_STATIC_BEARER` | Optional | `true` = don't start the internal listener, i.e. no static-bearer access at all. |
| `WALDO_OAUTH_REDIRECT_ALLOWLIST` | Optional | Comma-separated https callback URIs a client may register/use. See §1.1. |

Add to `.env` (or the container environment):

```
WALDO_PUBLIC_URL=https://waldo-nas.your-tailnet.ts.net
WALDO_ADMIN_PASSWORD=<openssl rand -hex 24 output>
```

Restart the server. The three OAuth routes are now live:

```
GET  /.well-known/oauth-authorization-server   # RFC 8414 metadata
GET  /.well-known/oauth-protected-resource     # RFC 9728 metadata
POST /oauth/register                           # Dynamic Client Registration
GET  /oauth/authorize                          # Consent page
POST /oauth/authorize                          # Consent submit
POST /oauth/token                              # Token exchange + refresh
```

### 1.1. Redirect allowlist and what the consent page checks

The server is internet-reachable (Tailscale Funnel), so `/oauth/register` is
open to anyone. To stop **consent phishing** (an attacker registers a client
named "Claude" whose callback is their own host, then sends you the real
consent link), codes are only ever sent to allowlisted callbacks:

- **Remote callbacks** must match an entry of `WALDO_OAUTH_REDIRECT_ALLOWLIST`
  **exactly**. Default: `https://claude.ai/api/mcp/auth_callback`,
  `https://claude.com/api/mcp/auth_callback`.
- **Loopback** `http://localhost`, `http://127.0.0.1`, `http://[::1]` (any
  port, any path) is always allowed — Claude Desktop / Claude Code listen on a
  random local port.
- Credentials (`user@`) and fragments (`#`) are always rejected.

Both `GET` and `POST /oauth/authorize` re-check: the client exists, the
redirect URI is registered for it **and** still allowlisted, `S256`, and a
well-formed 43–128 char challenge. The POST checks this **before** the
password, so a hand-crafted form can never mint a code. Clients registered
before the allowlist existed with other callbacks are refused at authorize time
(revoke them, §5).

The consent page shows **"After approval you will be sent to: `<host>`"**.
Only approve if that is the client you just started connecting. The client
name is self-declared and proves nothing.

A rejected registration logs one line:
`oauth_dcr_redirect_rejected redirect_uris=[...]`. If claude.ai ever moves to a
new callback, that line tells you what to add.

`POST /oauth/token`: if the client sends `client_id`, it must match the client
the code / refresh token was issued to (`invalid_grant` otherwise).

---

## 2. Registering a client manually (curl walkthrough)

This is what claude.ai does automatically — useful for debugging.

**Step 1 — Dynamic Client Registration**

```bash
curl -s -X POST https://waldo-nas.your-tailnet.ts.net/oauth/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "my-test-client",
    "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
    "token_endpoint_auth_method": "none"
  }' | jq .
```

Expected response (201):

```json
{
  "client_id": "01JT...",
  "client_name": "my-test-client",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"]
}
```

Save the `client_id`.

**Step 2 — Generate PKCE pair**

```bash
VERIFIER=$(openssl rand -base64 32 | tr -d '=+/' | head -c 43)
CHALLENGE=$(echo -n "$VERIFIER" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')
echo "verifier=$VERIFIER"
echo "challenge=$CHALLENGE"
```

**Step 3 — Visit the consent URL in a browser**

```
https://waldo-nas.your-tailnet.ts.net/oauth/authorize
  ?client_id=<client_id>
  &redirect_uri=https://claude.ai/api/mcp/auth_callback
  &response_type=code
  &code_challenge=<CHALLENGE>
  &code_challenge_method=S256
  &scope=mcp
  &state=test-state-123
```

Enter your `WALDO_ADMIN_PASSWORD` and click **Allow**. The browser redirects to the `redirect_uri` with `?code=<auth_code>&state=test-state-123`. Extract the code from the URL bar.

**Step 4 — Exchange code for tokens**

```bash
curl -s -X POST https://waldo-nas.your-tailnet.ts.net/oauth/token \
  -d "grant_type=authorization_code" \
  -d "code=<auth_code>" \
  -d "redirect_uri=https://claude.ai/api/mcp/auth_callback" \
  -d "code_verifier=$VERIFIER" | jq .
```

Expected response:

```json
{
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "refresh_token": "...",
  "scope": "mcp"
}
```

**Step 5 — Call the MCP endpoint**

```bash
curl -s https://waldo-nas.your-tailnet.ts.net/mcp \
  -H "Authorization: Bearer <access_token>"
```

**Step 6 — Refresh before expiry**

```bash
curl -s -X POST https://waldo-nas.your-tailnet.ts.net/oauth/token \
  -d "grant_type=refresh_token" \
  -d "refresh_token=<refresh_token>" | jq .
```

Refresh is **non-rotating**: the same refresh token is reused, a fresh access token is minted (the previous access token stops validating), and the refresh token's 30-day expiry slides forward. The refresh token therefore stays valid for retries — a lost refresh response no longer bricks the client. An unknown or already-expired refresh token returns `400 invalid_grant` and leaves stored state untouched.

---

## 3. Connecting claude.ai

1. Go to **claude.ai → Settings → Connectors → Add custom connector**.
2. Enter the server URL: `https://waldo-nas.your-tailnet.ts.net`
3. claude.ai fetches `/.well-known/oauth-authorization-server`, performs DCR, and opens the consent page in a pop-up.
4. Enter `WALDO_ADMIN_PASSWORD` and click **Allow**.
5. claude.ai completes the code exchange and stores the tokens.

---

## 4. Admin password rotation

Set a new `WALDO_ADMIN_PASSWORD` in `.env` (or the container environment) and restart the server.

- The password is hashed at startup (scrypt N=16384); old tokens remain valid until they expire (access: 24 h, refresh: 30 days).
- Existing clients do not need to re-register — they just re-authorize next time their access token expires.
- If you want to force all clients to re-authorize immediately, see §5.

---

## 5. Client revocation (manual)

The CLI `--list-oauth-clients` / `--revoke-oauth-client` subcommands are deferred. In the meantime, use SQLite directly.

**List registered clients**

```bash
sqlite3 data/lake.db \
  "SELECT client_id, client_name, created_at FROM oauth_clients ORDER BY created_at;"
```

**List active tokens**

```bash
sqlite3 data/lake.db \
  "SELECT client_id, access_token, access_expires_at FROM oauth_access_tokens;"
```

**Revoke a single client** (deletes the client registration; any existing access/refresh tokens are left to expire naturally)

```bash
# Stop server first, or use WAL mode's locking
sqlite3 data/lake.db \
  "DELETE FROM oauth_clients WHERE client_id = '<id>';"
```

**Revoke all tokens for a client**

```bash
sqlite3 data/lake.db \
  "DELETE FROM oauth_access_tokens WHERE client_id = '<id>';"
```

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `POST /oauth/register` → 404 | `WALDO_PUBLIC_URL` not set | Set the var and restart |
| Consent page shows "no admin password configured" (503) | `WALDO_ADMIN_PASSWORD` not set | Set the var and restart |
| Wrong password on consent page → 401 | Mistyped or wrong env var | Check `WALDO_ADMIN_PASSWORD` |
| `POST /oauth/token` → `invalid_grant` | Auth code already used, or expired (10-min window) | Restart the OAuth flow |
| `POST /oauth/token` → PKCE `code_verifier does not match` | Client sent wrong verifier | Client bug; re-run the PKCE generation |
| MCP endpoint → 401 with `WWW-Authenticate: Bearer resource_metadata=…` | Access token expired | Refresh via `grant_type=refresh_token` |
| MCP endpoint → 401 even with fresh token | Token lookup failed (expired / revoked / wrong server) | Verify `WALDO_PUBLIC_URL` resolves correctly; re-authorize the connector |
| Static `BEARER_TOKEN` → 401 on the `ts.net` URL | Expected since S2: the public port is OAuth-only | Use the internal listener `http://127.0.0.1:$WALDO_INTERNAL_PORT/mcp` from the server host |
| MCP endpoint → 401 with bare `Bearer` (no resource_metadata) | `WALDO_PUBLIC_URL` not set | OAuth not mounted; static bearer only |
| `redirect_uri_mismatch` on register | Supplied `redirect_uri` not in client's registered list | Re-register or fix the redirect URI |
| `POST /oauth/register` → 400 `invalid_redirect_uri` | Callback not on the allowlist (§1.1) | Check the `oauth_dcr_redirect_rejected` log line; add the URI to `WALDO_OAUTH_REDIRECT_ALLOWLIST` if legitimate |
| Consent page → 400 "redirect_uri is not registered for this client or not allowed" | Client registered before the allowlist with a callback that is no longer allowed | Remove/re-add the connector (fresh DCR) |

### 6.1. Tools error or time out after an OAuth deploy

After any OAuth-surface change (new client registration, admin-password
rotation, `WALDO_DISABLE_STATIC_BEARER` flip, DCR table migration, or a
server-side refactor that changes the `/.well-known/*` payload) the client
holds cached DCR `client_id`, token, or tool-discovery state that is no
longer valid against the current server. The server is healthy; the client
is stale. The clients do not advertise this state and do not re-register
on their own.

**Symptoms**

- **Claude Desktop:** calling the affected tool hangs until the MCP call
  times out. Other tools on the same connector may still work.
- **claude.ai web:** calling the affected tool returns a generic
  *"tool execution error"*, often repeated identically across retries.
  Other tools on the same connector may still work. The server log
  (since the debuggability fix in [../src/mcp/mcp-server.ts](../src/mcp/mcp-server.ts))
  will show nothing for the failing tool — a telltale sign the request
  never reached the handler at all, and the failure is on the client side.

**Fix — per client**

- **Claude Desktop (macOS):** Settings → Connectors → find the waldo-wtf
  connector → **Disconnect**. Then **quit Claude Desktop fully** with
  `Cmd+Q` (closing the window is not enough — the MCP transport keeps
  running). Relaunch. Settings → Connectors → **Add custom connector** →
  paste the `https://…ts.net` Tailscale URL → complete the OAuth
  consent flow.
- **claude.ai web:** Settings → Connectors → find the connector →
  **Remove**. Hard-reload the tab (`Cmd+Shift+R`, not a plain reload —
  service workers cache the DCR client). Re-add the connector and
  complete the consent flow.

**When to escalate**

If remove/re-add does not resolve it:

1. Check the server log (`sudo docker compose logs waldo | tail -200`
   on the NAS). With the debuggability fix in place, a failing tool
   logs `[mcp tool handler] <tool_name> failed: <message>\n<stack>`.
   If that line appears, the request *is* reaching the server — it is
   a server bug, not a stale-client bug.
2. If no log line appears for the failing tool, the request is being
   dropped before it reaches the dispatcher. Run the in-container
   diagnostic recipe in [deploy-synology.md](deploy-synology.md) to
   isolate transport from handler.
