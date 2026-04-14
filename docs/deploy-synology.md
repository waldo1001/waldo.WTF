# Deploying waldo.WTF to a Synology NAS (DS223)

This guide takes you from a working local repo on your Mac to a long-running
waldo.WTF container on a Synology DS223, reachable from the Mac (and phone) over
Tailscale. It is written for the exact hardware and OS combo waldo is running:

- **Mac (build host):** macOS on Apple Silicon (arm64)
- **NAS:** Synology DS223, DSM 7.2+, Realtek RTD1619B (arm64)
- **Tunnel:** Tailscale, installed as a Synology package on the NAS and as the
  normal client on the Mac
- **MCP client:** Claude Desktop on the Mac

If your NAS is a different model, check `uname -m` on the NAS first and adapt the
`--platform` flag accordingly (`linux/amd64` on x86 models like the DS923+).

> ⚠️ **Before you trust this manual end-to-end, run Part A (local smoke test) on
> your Mac.** The Dockerfile and compose file in this repo were written from
> inside an environment that had no Docker daemon, so they have not been built
> against a live engine. Part A is the validation step — if anything is wrong,
> fix it there, *then* proceed to the NAS.

---

## Part A — Build and smoke-test on the Mac

**Goal.** Build the image, run it locally, hit `/health` through the published
port, and confirm that the bind-mounted volumes receive the SQLite file and
token cache.

### A1. Prerequisites

- Docker Desktop for Mac (or OrbStack) running.
- `docker buildx` available (bundled with Docker Desktop 4.x+).
- A populated `.env` file at the repo root — copy from `.env.example`:

  ```sh
  cp .env.example .env
  ```

  Fill in `MS_CLIENT_ID` and `BEARER_TOKEN`. Leave everything else commented
  out; `docker-compose.yml` sets the paths and bind host explicitly.

### A2. Build

```sh
docker buildx build --platform linux/arm64 --load -t waldo-wtf:local .
```

`--load` places the image in the local Docker engine (the default buildx
driver pushes to a registry).

**If the build fails on `better-sqlite3`**, the most likely cause is a missing
prebuilt binary for arm64 on `node:22-bookworm-slim`. The Dockerfile already
installs `python3 make g++` in the deps stage, so the from-source compile
should succeed — just slower. First build takes 5–10 minutes; subsequent
builds are cached.

### A3. Run

```sh
mkdir -p ./data/db ./data/auth
docker compose up -d
docker compose logs -f
```

You should see:

```
waldo.WTF MCP server listening on http://0.0.0.0:8765
```

The `0.0.0.0` is deliberate — that's the `WALDO_BIND_HOST` override from
`docker-compose.yml`. Outside the container, the server is reachable at
`http://127.0.0.1:8765` via the published port.

### A4. Smoke test

In another terminal:

```sh
# Unauthenticated health check
curl -sS http://127.0.0.1:8765/health
# => {"ok":true}

# Authenticated MCP call (replace with the BEARER_TOKEN from your .env)
curl -sS -H "Authorization: Bearer $(grep BEARER_TOKEN .env | cut -d= -f2)" \
  http://127.0.0.1:8765/mcp
```

Check the volumes:

```sh
ls -la ./data/db ./data/auth
# First tick will create lake.db in ./data/db once the sync loop runs.
```

### A5. First-run login (on the Mac — optional but recommended)

Before you take the image to the NAS, prove the login flow works here:

```sh
docker compose run --rm waldo --add-account
```

This attaches your terminal to a throwaway container that shares the same
bind-mounted `./data/auth` volume. MSAL prints a device code; follow the URL,
sign in, and the token cache lands in `./data/auth/token-cache.json`. Next
`docker compose up -d` will pick it up.

### A6. Tear down

```sh
docker compose down
```

The `./data/db` and `./data/auth` directories survive. Delete them only if you
want to start clean.

**Do not proceed to Part B until Part A works end-to-end.** If anything in A1–A5
fails, fix the Dockerfile / compose / source and re-run before moving on.

---

## Part B — Prepare the Synology NAS

### B1. Install Container Manager

1. Open DSM in your browser.
2. Package Center → search "Container Manager" → **Install**.
3. Launch it once to accept the EULA and let it create `/var/packages/ContainerManager`.

### B2. Install Tailscale

1. Package Center → search "Tailscale" → **Install** (official Tailscale
   package, not a community one).
2. Launch Tailscale → **Log in** → authenticate in the browser tab that opens.
3. In the Tailscale admin console (`login.tailscale.com`), confirm the NAS
   appears with a MagicDNS name like `waldo-nas.<tailnet-name>.ts.net`.
4. On your Mac, confirm you can reach the NAS:

   ```sh
   tailscale ping waldo-nas
   ```

   If that fails, don't proceed — fix the tunnel first.

### B3. Decide on the storage path

SQLite with WAL journaling **must** live on a local filesystem, never on an SMB
/ NFS share. On a single-volume DS223 the internal SSD/HDD is typically
`/volume1`, so a safe layout is:

```
/volume1/docker/waldo-wtf/
├── db/       # will receive lake.db + lake.db-wal + lake.db-shm
├── auth/     # will receive token-cache.json, delta-state.json
├── .env
└── docker-compose.yml
```

Verify `/volume1` is local:

- DSM → **Storage Manager** → check the Volume entry. It should list one of
  the physical drives, not `SMB` or `NFS`.
- SSH into the NAS (enable SSH in Control Panel → Terminal & SNMP if you
  haven't) and run `df -T /volume1` — filesystem type should be `btrfs` or
  `ext4`, not `cifs` or `nfs`.

### B4. Create the directories

SSH to the NAS and run:

```sh
sudo mkdir -p /volume1/docker/waldo-wtf/db /volume1/docker/waldo-wtf/auth
sudo chown -R 1000:1000 /volume1/docker/waldo-wtf/db /volume1/docker/waldo-wtf/auth
sudo chmod -R u+rwX /volume1/docker/waldo-wtf/db /volume1/docker/waldo-wtf/auth
# UID 1000 = the `node` user inside the image. Matches the non-root USER in
# the Dockerfile so the container can write into the bind mounts.
```

> **Do NOT create these directories through DSM's File Station or SMB.**
> DSM applies extended ACLs on shared-folder paths that can override the UNIX
> owner set by `chown`, leaving the container with `EACCES` on first write
> even though `ls -la` shows the right owner. Always create the bind-mount
> directories over SSH.
>
> Also: if you ran `docker compose` before creating these directories, Docker
> will have auto-created them as `root:root`. Re-run the `chown` + `chmod`
> above to fix, then verify with `ls -la /volume1/docker/waldo-wtf/` — both
> `db/` and `auth/` must show owner `1000`.

### B4a. Verify the container can write to the bind mounts

Before Part E (first-run MSAL login), sanity-check the permissions from
*inside* the container so you don't waste a device-code flow on a perms bug:

```sh
cd /volume1/docker/waldo-wtf
sudo /usr/local/bin/docker compose run --rm --entrypoint sh waldo -c \
  'touch /data/auth/.write-test /data/db/.write-test && rm /data/auth/.write-test /data/db/.write-test && echo OK'
```

Expected output: `OK`. If you see `Permission denied`, re-run the `chown` +
`chmod` from B4 and try again. Do not proceed to Part E until this prints
`OK` — the MSAL device-code flow writes `token-cache.json` to `/data/auth`
on success, and a perms failure there manifests as a confusing
`MSAL device-code login failed / caused by: EACCES` error *after* you've
already burned the code in the browser.

---

## Part C — Get the image onto the NAS

Two options. Pick one.

### Option 1 — Build locally on the Mac, `docker save` → `scp` → `docker load`

This is the simplest path for a one-off deployment.

On the **Mac**:

```sh
# (You should already have built waldo-wtf:local in A2.)
docker save waldo-wtf:local -o waldo-wtf.tar
scp waldo-wtf.tar waldo@waldo-nas:/tmp/waldo-wtf.tar
```

On the **NAS** (via SSH):

```sh
sudo docker load -i /tmp/waldo-wtf.tar
sudo docker image ls waldo-wtf
# Expect: waldo-wtf   local   <sha>   ...   linux/arm64
rm /tmp/waldo-wtf.tar
```

### Option 2 — Build on the NAS directly

Slower (the DS223 isn't fast) but avoids the tarball shuffle.

On the **NAS**:

```sh
cd /volume1/docker/waldo-wtf
git clone https://github.com/<your-account>/waldo.WTF.git src
cd src
sudo docker build -t waldo-wtf:local .
```

Then copy `docker-compose.yml` up one level (you want it next to the `.env`
file, not inside the source checkout):

```sh
cp docker-compose.yml ../docker-compose.yml
```

---

## Part D — Compose file and `.env` on the NAS

Copy `docker-compose.yml` and `.env` to `/volume1/docker/waldo-wtf/`. You need
to edit the compose file so the bind-mount paths are absolute NAS paths, not
`./data/*` (relative paths resolve against the compose file's directory, so
this only matters if the compose file is not at the layout shown in B3).

Edit `/volume1/docker/waldo-wtf/docker-compose.yml` and change:

```yaml
    volumes:
      - ./data/db:/data/db
      - ./data/auth:/data/auth
```

to:

```yaml
    volumes:
      - /volume1/docker/waldo-wtf/db:/data/db
      - /volume1/docker/waldo-wtf/auth:/data/auth
```

Also remove the `build:` block if you used Option 1 (you loaded the image,
there's nothing to build on the NAS):

```yaml
  waldo:
    image: waldo-wtf:local
    # delete the `build:` section
```

Populate `/volume1/docker/waldo-wtf/.env` with real values:

```
MS_CLIENT_ID=...
BEARER_TOKEN=...
```

Generate a fresh bearer token on the NAS if you don't have one:

```sh
openssl rand -hex 32
```

Lock the `.env` down:

```sh
sudo chown 1000:1000 /volume1/docker/waldo-wtf/.env
sudo chmod 600 /volume1/docker/waldo-wtf/.env
```

---

## Part E — First-run MSAL login on the NAS

The token cache you used on the Mac in A5 does NOT transfer — it was issued for
a different device (MSAL binds some refresh tokens to the origin). Do the
device-code flow again, this time against the NAS volume.

```sh
cd /volume1/docker/waldo-wtf
sudo docker compose run --rm waldo --add-account
```

You'll see output like:

```
To sign in, use a web browser to open the page https://microsoft.com/devicelogin
and enter the code ABCD-EFGH to authenticate.
```

Open that URL on any browser (your Mac is fine), enter the code, pick the
Microsoft account(s) you want waldo.WTF to index. When it finishes, the
container exits and `token-cache.json` is written to
`/volume1/docker/waldo-wtf/auth/token-cache.json`.

Verify:

```sh
sudo ls -la /volume1/docker/waldo-wtf/auth/
# token-cache.json should be present, owned by 1000:1000, mode 600 (via TokenCacheStore).
```

To add a second account, just run the same command again.

---

## Part F — Start the long-running container

```sh
cd /volume1/docker/waldo-wtf
sudo docker compose up -d
sudo docker compose logs -f
```

Expected log lines within the first minute:

```
waldo.WTF MCP server listening on http://0.0.0.0:8765
starting initial sync tick (this may take a while on first run)
sync tick complete: N account(s), N ok, 0 error(s)
```

The first tick can take a while if `WALDO_BACKFILL_DAYS` is unset and the
mailbox is large — cap it in `.env` if you want to iterate faster:

```
WALDO_BACKFILL_DAYS=30
```

Then `sudo docker compose restart waldo`.

Confirm from the Mac (over Tailscale):

```sh
curl -sS http://waldo-nas:8765/health
# => {"ok":true}

# Authenticated ping — use the SAME BEARER_TOKEN you put in the NAS .env.
curl -sS -H "Authorization: Bearer <token>" http://waldo-nas:8765/mcp
```

If `waldo-nas` doesn't resolve, use the tailnet IPv4 from `tailscale status`
or the full MagicDNS name (`waldo-nas.<tailnet-name>.ts.net`).

---

## Part G — Repoint Claude Desktop

Edit Claude Desktop's MCP config. On macOS that's usually:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Claude Desktop's `claude_desktop_config.json` only speaks **stdio** to MCP
servers — it does NOT have a native remote-HTTP transport. To talk to a
remote MCP server you run [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)
as a stdio-to-HTTP bridge:

```json
{
  "mcpServers": {
    "waldo-wtf": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://waldo-nas.<tailnet-name>.ts.net:8765/mcp",
        "--allow-http",
        "--header",
        "Authorization: Bearer <the-same-BEARER_TOKEN>"
      ]
    }
  }
}
```

Three non-obvious things that will bite you:

1. **`--allow-http` is required.** `mcp-remote` refuses plaintext URLs by
   default and exits with `Non-HTTPS URLs are only allowed for localhost or
   when --allow-http flag is provided`. This is safe over Tailscale because
   the tailnet link is WireGuard-encrypted end-to-end — but on pure LAN or
   public internet, set up real TLS instead.

2. **Use the full MagicDNS name**, not a short hostname — a bare `waldo-nas`
   can collide with LAN mDNS resolution and `mcp-remote` will then hit the
   wrong host (or `ECONNREFUSED` on a stale loopback entry).

3. **`--header` takes a single `Name: value` string**, not a JSON object.
   Claude Desktop's documented `"headers": { ... }` form does NOT work with
   `mcp-remote` — it's a hypothetical future native-HTTP transport that
   doesn't exist in the current Claude Desktop build.

Fully quit Claude Desktop (`Cmd+Q`, not just close the window) and reopen.
Ask it something like *"what's the last message I got from my boss?"* to
confirm it's hitting the NAS-hosted server.

---

## Troubleshooting

### `docker compose up` fails with `exec /bin/sh: exec format error`
You shipped an amd64 image to an arm64 NAS (or vice versa). Rebuild with the
right `--platform`:

```sh
docker buildx build --platform linux/arm64 --load -t waldo-wtf:local .
```

### Container starts, but `curl http://waldo-nas:8765/health` hangs
`WALDO_BIND_HOST` isn't `0.0.0.0`. Check:

```sh
sudo docker compose exec waldo sh -c 'echo $WALDO_BIND_HOST'
```

`docker-compose.yml` sets it explicitly — if the value is `127.0.0.1`, the
`environment:` block got dropped. Re-check the file.

### `sync tick complete: 0 account(s)`
The token cache is empty. Re-run Part E against the NAS volume — the Mac's
`token-cache.json` doesn't transfer.

### `SQLITE_BUSY` or `database is locked` in the logs
Check that `/data/db` is NOT on a network share. On the NAS:

```sh
df -T /volume1/docker/waldo-wtf/db
# filesystem should be btrfs or ext4, never cifs/nfs.
```

If it is on a share, **stop the container immediately** (`sudo docker compose
down`), move the directory to `/volume1/docker/...` on the internal volume,
update the bind-mount path in `docker-compose.yml`, and restart. A corrupted
SQLite file on SMB is not always recoverable.

### The MagicDNS name resolves but the connection refuses
Tailscale is up (`tailscale ping waldo-nas` succeeds) but the port is
unreachable. Two usual causes:

1. Compose file doesn't publish the port — check `ports: - "8765:8765"`.
2. Synology firewall is blocking it. Control Panel → Security → Firewall,
   allow port 8765 TCP on the Tailscale interface. (On most default DSM
   setups the firewall is off and this isn't needed.)

### `Error: ENOENT: no such file or directory, open '/data/auth/token-cache.json'`
Expected on first run — the cache doesn't exist until you complete Part E.

### Claude Desktop says `MCP server disconnected`
Tail `~/Library/Logs/Claude/mcp-server-waldo-wtf.log` on the Mac — the real
error is almost always in there. Common causes, in order of likelihood:

1. **`Non-HTTPS URLs are only allowed for localhost or when --allow-http
   flag is provided`** → add `--allow-http` to the `mcp-remote` args (see
   Part G). `mcp-remote` rejects plaintext URLs by default.
2. **Bearer token mismatch** — the token in `claude_desktop_config.json`
   doesn't match `/volume1/docker/waldo-wtf/.env`. Copy verbatim, no
   whitespace.
3. **`ECONNREFUSED`** — DNS resolved but the container isn't listening on
   that host/port. Test from the Mac: `curl http://<tailnet-host>:8765/health`
   should return `{"ok":true}`. If it times out, check the container is up
   on the NAS (`sudo /usr/local/bin/docker compose ps`) and that
   `WALDO_BIND_HOST=0.0.0.0` is set in the compose environment — without it
   the server binds to loopback only and the published port forwards to a
   dead listener.

### `exec /app/node_modules/.bin/tsx: no such file or directory`
The runtime stage's `npm install tsx` didn't land. Rebuild without cache:

```sh
docker buildx build --no-cache --platform linux/arm64 --load -t waldo-wtf:local .
```

---

## Updating waldo.WTF later

When you pull new code:

1. On the Mac, rebuild + re-smoke-test (Part A).
2. `docker save` → `scp` → `docker load` the new image to the NAS (Part C
   option 1) — OR `git pull && sudo docker build` on the NAS.
3. `cd /volume1/docker/waldo-wtf && sudo docker compose up -d`
4. Compose sees the new image SHA and recreates the container; volumes (and
   therefore the SQLite lake + token cache) survive.

The database schema is migrated by the app on startup — you don't need to do
anything special when bumping versions unless the changelog says so.

---

## Security notes (brief)

- `BEARER_TOKEN` is the only thing between anyone on your tailnet and your
  entire mailbox index. Make it long (`openssl rand -hex 32`) and don't reuse
  it elsewhere.
- The container runs as a non-root user (`node`, UID 1000) and only writes to
  `/data/*`. It does not need privileged mode, host networking, or any
  capability beyond the defaults.
- There is no HTTPS. That's OK *because* the only route to port 8765 is the
  tailnet; Tailscale is already an authenticated, encrypted overlay. Do NOT
  publish port 8765 to the public internet (DSM Reverse Proxy, port forward,
  etc.) without terminating TLS and rate-limiting.
- `.env` should be mode `600`, owner `1000:1000`. It contains a secret.
