# Deploying waldo.WTF on the Mac mini (native, no Docker)

This is the production deployment runbook. waldo.WTF runs **natively on the Mac
mini `waldomacmini1`** as a launchd LaunchDaemon — no Docker, no container, no
image. It replaces the retired Synology/Docker deployment (`docs/deploy-synology.md`,
removed). The Synology NAS is now a **backup-only** target.

## Topology

```
claude.ai / Claude mobile / Desktop ──HTTPS (public internet)──► <host>.<tailnet>.ts.net  (Tailscale FUNNEL, TLS)
                                            │  reverse-proxy
                                            ▼
                                      127.0.0.1:8765   (LaunchDaemon: tsx src/cli.ts)
                                            │
                                            ▼
                                /Users/waldo/waldo-wtf/   (lake.db + auth + whatsapp + .env)
                                            │ nightly backup (tar/ssh)
                                            ▼
                                waldonas3:/volume1/backup/waldo-wtf/YYYY-MM-DD/
```

WhatsApp capture stays on the laptop `waldos-mac`: a launchd WatchPaths agent runs
`bin/wtf-whatsapp-push`, which scp's exports to the Mac mini inbox; the server's
chokidar watcher imports + archives them.

## Layout

| Thing | Path |
|---|---|
| Code (this repo) | `/Users/waldo/Sourcecode/waldo.wtf` |
| Data root | `/Users/waldo/waldo-wtf/{db,auth,whatsapp-inbox,whatsapp-archive,logs}` |
| Config + secrets | `/Users/waldo/waldo-wtf/.env` (chmod 600) — loaded by dotenv from the daemon's WorkingDirectory |
| Server LaunchDaemon | `/Library/LaunchDaemons/com.waldo.wtf.server.plist` (template: `deploy/com.waldo.wtf.server.plist`) |
| Backup LaunchDaemon | `/Library/LaunchDaemons/com.waldo.wtf.backup.plist` (template: `deploy/com.waldo.wtf.backup.plist`, runs `deploy/wtf-backup.sh` @ 03:30) |
| Log rotation | `/etc/newsyslog.d/com.waldo.wtf.conf` (template: `deploy/newsyslog-waldo.conf`) |
| Node (pinned) | `/opt/homebrew/opt/node@22/bin/node` (ABI 127) |
| Logs | `/Users/waldo/waldo-wtf/logs/server.{out,err}.log`, `backup.log` |

## Prerequisites (one-time)

- Homebrew `node@22` + Xcode CLT (for any better-sqlite3 source build).
- Passwordless sudo for `waldo`: `/etc/sudoers.d/waldo` (`waldo ALL=(ALL) NOPASSWD: ALL`).
- Tailscale (standalone app) with MagicDNS + HTTPS certificates enabled in the admin console.
- Remote Login (sshd) ON, with the laptop's key in `~/.ssh/authorized_keys` (for WhatsApp push).
- `npm ci` in the repo (installs deps incl. `tsx`; **not** `--omit=dev`).

## Install the service

```bash
sudo cp deploy/com.waldo.wtf.server.plist /Library/LaunchDaemons/com.waldo.wtf.server.plist
sudo chown root:wheel /Library/LaunchDaemons/com.waldo.wtf.server.plist
sudo chmod 644       /Library/LaunchDaemons/com.waldo.wtf.server.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.waldo.wtf.server.plist
sudo launchctl enable  system/com.waldo.wtf.server
sudo launchctl kickstart -k system/com.waldo.wtf.server
sudo launchctl print system/com.waldo.wtf.server | grep -E 'state|pid'   # expect running, has pid
```

## Expose over HTTPS (Tailscale Funnel)

```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
sudo "$TS" funnel status      # expect: https://<host>.<tailnet>.ts.net (Funnel on) -> http://127.0.0.1:8765
# if missing:
sudo "$TS" funnel --bg http://127.0.0.1:8765
curl -s https://<host>.<tailnet>.ts.net/health      # {"ok":true}
```

Production is exposed with **Funnel, i.e. on the public internet**, not
tailnet-only Serve. That is required: the claude.ai connector (used by
claude.ai web, Claude mobile and Claude Desktop) connects from Anthropic's cloud,
which cannot reach a tailnet-only host. The config persists in tailscaled state
across reboots.

Implications — every route is reachable by anyone who knows the hostname:

- **OAuth is the public access path.** `WALDO_PUBLIC_URL=https://<host>.<tailnet>.ts.net`
  in `.env` enables it; DCR and authorize are restricted to allowlisted callbacks
  ([oauth.md §1.1](oauth.md)).
- **The static `BEARER_TOKEN` currently also works over Funnel.** It is being moved
  to a loopback-only listener — see [plans/security-hardening.md](plans/security-hardening.md) (S2).
- Funnel requests never carry Tailscale identity headers; the server sees every
  request as coming from `127.0.0.1`.

## Day-to-day

- **Deploy a change**: `/deploy-local` (or: `git pull --ff-only` → `npm ci` →
  `sudo launchctl kickstart -k system/com.waldo.wtf.server` → smoke `/health`).
- **Run a migration**: `/deploy-local --migrate <name>` (see `docs/migrations/`).
- **Logs**: `tail -f /Users/waldo/waldo-wtf/logs/server.out.log`.
- **Restart**: `sudo launchctl kickstart -k system/com.waldo.wtf.server`.
- **Stop**: `sudo launchctl bootout system/com.waldo.wtf.server`.

## Operational notes

- **better-sqlite3 is ABI-locked to Node 22 (modules 127).** Pin `node@22`; after any
  Node major bump, `npm rebuild better-sqlite3` (or boot fails with a NODE_MODULE_VERSION
  mismatch).
- **IPv4-first.** The plist sets `NODE_OPTIONS=--dns-result-order=ipv4first`: this
  network's IPv6 path to some Microsoft 365 endpoints is unreliable (an established
  IPv6 socket can stall on large responses). IPv4 is healthy.
- **No per-request HTTP timeout** in the Graph client (pre-existing). If a Graph
  endpoint hangs, the affected sync operation waits out the OS TCP timeout (~minutes)
  before continuing — the first tick after a restart can therefore be slow; the
  WhatsApp watcher + watchdog start only after that initial tick completes. Steady-state
  5-minute ticks are fast. Adding a client-side timeout is a recommended follow-up.
- **Crash/wedge recovery** is launchd `KeepAlive` + the in-process event-loop watchdog
  (`process.exit` on wedge → relaunch), replacing the Docker autoheal sidecar.

## Backups & rollback

- Nightly `com.waldo.wtf.backup` takes a hot, WAL-safe snapshot (better-sqlite3 online
  backup) + auth + whatsapp-archive → `waldonas3:/volume1/backup/waldo-wtf/YYYY-MM-DD/`,
  keeping 14 days. Run on demand: `sudo launchctl kickstart system/com.waldo.wtf.backup`.
- The NAS also holds the frozen **pre-migration** lake at `/volume1/docker/waldo-wtf/`
  (its compose file was neutralized so it can never restart a second writer).
- Restore: stop the daemon, copy a snapshot's `lake.db` into `/Users/waldo/waldo-wtf/db/`,
  restart.
