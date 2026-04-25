# Setup

Everything you need to go from a blank Mac to a working waldo.WTF
development environment. For the abridged five-minute version, see
[getting-started.md](getting-started.md).

> **Status note**: at time of writing, waldo.WTF is pre-Weekend-2 — the
> real TypeScript project does not exist yet. The spike lives at
> `/Users/waldo/Temp/waldo-wtf-spike/`. This doc describes the target
> state. Mark sections "spike" or "project" to indicate which applies.

---

## 1. Prerequisites

- **macOS** (primary dev). Linux works for deployment (Synology NAS).
- **Node.js 22 LTS** via `nvm` recommended.
- **Xcode Command Line Tools** — required by `better-sqlite3` native build.
- **A Microsoft work or school account** in at least one tenant where
  you can get delegated `Mail.Read` without admin consent. For waldo,
  `eric.wauters@dynex.be` is confirmed working.

Verify:

```sh
node --version    # should be 22.x
npm --version
xcode-select -p   # should print a path, not "not found"
```

## 2. Entra app registration

One-time, per developer. Required for MSAL device code flow.

1. Portal → **Microsoft Entra ID** → **App registrations** → **New
   registration**.
2. Name: `waldo-wtf-spike` (or `waldo-wtf-dev`).
3. Supported account types: **Accounts in any organizational directory
   and personal Microsoft accounts** (multitenant).
4. Redirect URI: **leave blank** — device code flow doesn't use one.
5. After creation → **Authentication** → enable **Allow public client
   flows** = Yes.
6. **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions**:
   - `User.Read` (added automatically)
   - `Mail.Read`
   - Later (Weekend 4): `Chat.Read`, `ChannelMessage.Read.All`
   - For Viva Engage subscriptions (optional): **Yammer** →
     `user_impersonation` (delegated). Add this under **APIs my
     organisation uses** → search "Yammer". Only required if you intend
     to subscribe to one or more Viva communities via `--viva-subscribe`.

   `--add-account` requests only the two Graph scopes (`Mail.Read`,
   `Chat.Read`) in one device-code prompt. The Yammer scope is requested
   separately, on first Viva sync, via MSAL's incremental-consent /
   multi-resource token chain. **If you are upgrading from a version
   prior to 2026-04-22 (hotfix)**, every existing account must re-run
   `--add-account <username>` to clear the stale mixed-resource token
   cache; `--add-account` was broken by an earlier commit that mixed
   Graph and Yammer scopes in one request. See the Viva section of
   [user-guide.md](user-guide.md).
7. Copy the **Application (client) ID** — you'll put it in `.env`.

## 3. Environment variables

Copy [../.env.example](../.env.example) to `.env` at the project root
(gitignored from day one — see [../waldo.WTF-project-brief.md](../waldo.WTF-project-brief.md) §8)
and fill in the required values. The env contract is enforced by
[`loadConfig`](../src/config.ts):

```env
# Required — Entra app from §2
MS_CLIENT_ID=your-client-id-guid-here

# Required — bearer token for the HTTP MCP endpoint.
# Generate with: openssl rand -hex 32
BEARER_TOKEN=generate-a-long-random-hex-string

# Optional — paths. Defaults shown.
# WALDO_DB_PATH=./data/lake.db
# WALDO_AUTH_DIR=./data/auth

# Optional — OAuth 2.1 surface for the MCP endpoint (rolled out across slices).
# When WALDO_PUBLIC_URL is set, the server mounts /.well-known/oauth-* and
# POST /oauth/register so claude.ai / Claude mobile can register as a client.
# Must be the externally reachable URL (https, or http://localhost for dev),
# no trailing slash. Required for the Tailscale-Funnel deployment.
# WALDO_PUBLIC_URL=https://waldo-nas.your-tailnet.ts.net
# WALDO_ADMIN_PASSWORD=  # generate with: openssl rand -hex 24 — gates consent (slice 2+)
# WALDO_DISABLE_STATIC_BEARER=  # set to true once OAuth is the primary path (slice 4+)

# Optional — kill switch for the in-process watchdogs (event-loop lag +
# self-loopback healthcheck). On wedge, the process logs and exits so
# Docker's restart policy + autoheal sidecar can recover. Set to "1" to
# disable for interactive runs (e.g. --add-account) or local debugging.
# WALDO_WATCHDOG_DISABLED=1
```

`loadConfig` throws `ConfigError` listing every missing required key on
startup, so a half-populated `.env` fails fast with a clear message.

## 4. Install (project, Weekend 2+)

```sh
cd ~/code/waldo.WTF
npm install
npm test      # expect "no test files found" on a fresh clone — that's OK
```

Copy the TDD toolchain from [../testing/](../testing/) as described in
[../testing/README.md](../testing/README.md).

## 5. First login (device code flow)

Run the login helper (spike: `node spike.js`; project: `npm run
login -- --account new`). You'll see:

```
To sign in, use a web browser to open the page
https://microsoft.com/devicelogin and enter the code ABC123DEF.
```

Open the URL on any device, enter the code, sign in with the Microsoft
account you want to sync. The refresh token lands in the token cache on
disk. The process exits successfully. Re-running should **not** prompt
for a code again — silent refresh works.

Repeat for every account you want to sync (Weekend 1 step, one-time per
account).

## 6. Data directory

```
data/
├── lake.db                                ← SQLite WAL (gitignored)
├── lake.db-wal                            ← WAL sidecar
├── lake.db-shm                            ← shared memory
├── token-cache.json                       ← MSAL token cache (chmod 600, gitignored)
└── auth/
    └── viva-external-tenants.json         ← per-account external-tenant registrations (chmod 600, gitignored)
```

`chmod 700 data/` and `chmod 600 data/token-cache.json
data/auth/viva-external-tenants.json`. These files contain refresh
tokens, external-tenant opt-ins, and customer-tenant message bodies —
treat like credentials.

## 7. Running the sync worker (project, Weekend 2+)

```sh
npm run dev   # starts sync worker + MCP server via tsx
```

Logs are JSON on stdout. Watch for `delta_sync_started` →
`delta_sync_completed` per `(account, source)`. Errors go to
`sync_log` table and to stderr.

## 8. Wiring Claude Desktop (project, Weekend 3+)

See [user-guide.md §2](user-guide.md) for the Claude Desktop MCP config
block and the first test prompt.

## 9. Deployment to Synology (project, Weekend 5+)

Full step-by-step recipe: [deploy-synology.md](deploy-synology.md).
Covers Docker build on the Mac, Container Manager + Tailscale on the
NAS, first-run MSAL login inside the container, and repointing Claude
Desktop to the tailnet host. Do **not** attempt before the local
`npm test` + `tsx src/cli.ts` flow works end-to-end for one full week.

## 10. Operations & autoheal sidecar

`docker-compose.yml` runs two containers:

- `waldo-wtf` — the MCP server itself.
- `waldo-autoheal` — the
  [willfarrell/autoheal](https://github.com/willfarrell/docker-autoheal)
  sidecar that watches every container labeled `autoheal=true` and
  restarts those whose Docker healthcheck reports `unhealthy` for
  several consecutive cycles. The `waldo` service carries that
  label; the sidecar restarts it ~90s after the event loop wedges.

The sidecar bind-mounts the host docker socket
(`/var/run/docker.sock`) and is therefore a privileged container.
The trust decision (why this is acceptable on a single-tenant home
NAS) is documented in
[runbooks/autoheal-smoke.md](runbooks/autoheal-smoke.md). Read it
once and then forget it; the runbook also contains the manual smoke
procedure to verify the safety net is still on.

If you ever want to opt out of the sidecar (e.g. one-shot manual
debugging where you'd rather a wedge stay wedged so you can dig in),
either remove the `autoheal=true` label from the `waldo` service or
`docker compose stop waldo-autoheal`.

---

## Troubleshooting

- **`better-sqlite3` native build fails**: install Xcode CLT, delete
  `node_modules`, `npm install` again.
- **Device code flow 400 error**: "Allow public client flows" probably
  not enabled — see §2 step 5.
- **`AADSTS65001` consent required**: the account's tenant requires
  admin consent for `Mail.Read`. This is a tenant-policy question, not
  a code fix. Use a different account or ask the tenant admin.
- **SQLite "database is locked"**: you forgot WAL mode, or you put the
  db on an SMB share. Internal disk only.
- **Coverage fails at 89.x%**: find the uncovered lines with
  `npm test -- --coverage` and either add behavior-focused tests or
  justify an exclusion in `vitest.config.ts` with a comment.
