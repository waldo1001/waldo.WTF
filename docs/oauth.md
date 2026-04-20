# OAuth 2.1 operator guide

This document covers setting up the OAuth 2.1 surface so claude.ai or Claude mobile can connect to waldo.WTF without the static bearer token.

---

## 1. Prerequisites

| Var | Required | Notes |
|-----|----------|-------|
| `WALDO_PUBLIC_URL` | Yes | Externally reachable base URL of the MCP server (https, no trailing slash). Enables all OAuth routes. |
| `WALDO_ADMIN_PASSWORD` | Yes | Passphrase shown on the consent page when a client registers. Generate: `openssl rand -hex 24` |
| `BEARER_TOKEN` | Keep | Static bearer still works unless you set `WALDO_DISABLE_STATIC_BEARER=true`. |
| `WALDO_DISABLE_STATIC_BEARER` | Optional | Set to `true` once OAuth is your primary access path to harden the endpoint. |

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
  "expires_in": 3600,
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

Refresh tokens rotate on use: the old refresh token is invalidated, a fresh pair is returned.

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

- The password is hashed at startup (scrypt N=16384); old tokens remain valid until they expire (access: 1 h, refresh: 30 days).
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
| MCP endpoint → 401 even with fresh token | `WALDO_DISABLE_STATIC_BEARER=true` and token lookup failed | Verify `WALDO_PUBLIC_URL` resolves correctly |
| MCP endpoint → 401 with bare `Bearer` (no resource_metadata) | `WALDO_PUBLIC_URL` not set | OAuth not mounted; static bearer only |
| `redirect_uri_mismatch` on register | Supplied `redirect_uri` not in client's registered list | Re-register or fix the redirect URI |
