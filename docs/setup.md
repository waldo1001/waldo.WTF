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
7. Copy the **Application (client) ID** — you'll put it in `.env`.

## 3. Environment variables

Create `.env` at the project root (gitignored from day one — see
[../waldo.WTF-project-brief.md](../waldo.WTF-project-brief.md) §8):

```env
# Entra app from §2
MS_CLIENT_ID=your-client-id-guid-here
MS_AUTHORITY=https://login.microsoftonline.com/common

# Bearer token for the HTTP MCP endpoint (project only, not spike).
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
BEARER_TOKEN=generate-a-long-random-hex-string

# Paths (project only). Absolute paths preferred.
DB_PATH=./data/lake.db
TOKEN_CACHE_PATH=./data/token-cache.json

# MCP HTTP server
MCP_PORT=8765
```

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
├── lake.db             ← SQLite WAL (gitignored)
├── lake.db-wal         ← WAL sidecar
├── lake.db-shm         ← shared memory
└── token-cache.json    ← MSAL token cache (chmod 600, gitignored)
```

`chmod 700 data/` and `chmod 600 data/token-cache.json`. These files
contain refresh tokens and customer-tenant message bodies — treat like
credentials.

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

See [user-guide.md §5](user-guide.md) for the Docker + Container Manager
+ Tailscale recipe. Do **not** attempt before the local setup works
end-to-end for one full week.

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
