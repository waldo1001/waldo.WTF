---
name: deploy-local
description: Deploy waldo.WTF to the Mac mini (waldomacmini1) native LaunchDaemon — no Docker. Runs tests + local-smoke, refreshes deps, restarts the launchd service, re-asserts Tailscale Serve, and smoke-checks HTTPS health + the MCP tool surface. Use whenever shipping code changes to the running Mac mini server, OR when running a data migration from docs/migrations/. Flags; `--migrate <name>` to run a registered migration, `--dry-run` to print the plan without executing.
---

# /deploy-local — native Mac mini deploy (no Docker)

waldo.WTF runs natively on the Mac mini `waldomacmini1` as a LaunchDaemon
(`com.waldo.wtf.server`), reachable at `https://waldomacmini1.tailb07704.ts.net`
via Tailscale Serve (TLS → `127.0.0.1:8765`). The data lake, auth cache, and
`.env` live under `/Users/waldo/waldo-wtf/`; the code runs from this checkout via
`tsx`. There is **no container, no image, no scp** — deploy is local.

Replaces the retired `/deploy-nas` (Docker-on-Synology) skill. The NAS is now a
backup-only target (nightly `com.waldo.wtf.backup`).

## Key paths / facts

- Code: `/Users/waldo/Sourcecode/waldo.wtf` (this repo). Entry: `node_modules/.bin/tsx src/cli.ts`.
- Data root: `/Users/waldo/waldo-wtf/{db,auth,whatsapp-inbox,whatsapp-archive,logs}` + `.env` (chmod 600).
- Service: LaunchDaemon `com.waldo.wtf.server` (`/Library/LaunchDaemons/com.waldo.wtf.server.plist`,
  template in `deploy/`). `KeepAlive` + the in-process watchdog replace Docker autoheal.
- Node: `/opt/homebrew/opt/node@22/bin/node` (pin node@22 — better-sqlite3 is ABI-locked, currently 127).
- Logs: `/Users/waldo/waldo-wtf/logs/server.{out,err}.log` (rotated by newsyslog).
- Privileged steps use `sudo` (passwordless for `waldo` via `/etc/sudoers.d/waldo`).

## Routine deploy

1. **Pre-flight** — `npm test` green; `git status --short` clean (or confirm); on a branch, confirm.
2. **Local smoke** — run `/local-smoke` (throwaway DB + port). Stop on failure.
3. **Pull** — `git pull --ff-only` (or already on the intended commit).
4. **Deps** — `/opt/homebrew/opt/node@22/bin/npm ci`. If Node's ABI changed
   (`node -p process.versions.modules` ≠ what better-sqlite3 was built for):
   `npm rebuild better-sqlite3`. Verify `node_modules/.bin/tsx` exists.
5. **Restart** — `sudo launchctl kickstart -k system/com.waldo.wtf.server`.
6. **Re-assert exposure** — `sudo /Applications/Tailscale.app/Contents/MacOS/Tailscale serve status`
   should still show `https://waldomacmini1.tailb07704.ts.net → http://127.0.0.1:8765`;
   if missing, `sudo … serve --bg --https=443 http://127.0.0.1:8765`.
7. **Smoke** — `curl -sS https://waldomacmini1.tailb07704.ts.net/health` → `{"ok":true}`;
   then ask Claude (Desktop/web) `list_accounts` + `get_sync_status` — `last_ok_at` within minutes.
   Watch `tail -f logs/server.out.log` for `sync tick complete: N account(s), M ok, 0 error(s)`.

> First tick after a restart can be slow if a Graph endpoint hangs (no per-request
> timeout); the watcher/watchdog start only after the initial tick completes. This
> is expected; subsequent 5-min ticks are fast.

## Migration deploy (`--migrate <name>`)

Migrations are native one-shots (no Docker). Recipes live in `docs/migrations/`.

1. Validate the recipe + prerequisites (schema version, CLI flag) from `docs/migrations/<name>.md`.
2. **Snapshot** the lake first: `cp /Users/waldo/waldo-wtf/db/lake.db{,.pre-<name>-YYYYMMDD}`
   (or trigger `com.waldo.wtf.backup`).
3. **Stop the writer**: `sudo launchctl bootout system/com.waldo.wtf.server`.
4. **Run the one-shot** from the data root so dotenv loads `.env`:
   `cd /Users/waldo/waldo-wtf && /opt/homebrew/opt/node@22/bin/node \
   /Users/waldo/Sourcecode/waldo.wtf/node_modules/.bin/tsx \
   /Users/waldo/Sourcecode/waldo.wtf/src/cli.ts --<migration-flag>` (checkpoints WAL on exit).
5. **Post-verify** (recipe's check), then restart:
   `sudo launchctl bootstrap system /Library/LaunchDaemons/com.waldo.wtf.server.plist`.

## `--dry-run`

Print the plan (steps, paths, the migration recipe if any) without executing.

## Rollback

- Bad deploy: `git checkout <prev>` → `npm ci` → `sudo launchctl kickstart -k system/com.waldo.wtf.server`.
- Service wedged: `sudo launchctl bootout … && sudo launchctl bootstrap system <plist>`.
- Catastrophic: the NAS holds the pre-migration cold snapshot at `/volume1/docker/waldo-wtf/`
  and nightly snapshots at `/volume1/backup/waldo-wtf/` — restore the lake from there.
