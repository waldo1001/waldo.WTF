---
name: deploy-nas
description: Deploy waldo.WTF to the Synology DS223 NAS. Drives the full recurring deploy loop step-by-step — build image on Mac, ship to NAS, stop container, optionally run a one-shot migration from the registry, verify, restart, smoke. Use whenever shipping code changes to the running NAS container, OR when running any data migration from docs/migrations/. Flags; `--migrate <name>` to run a registered migration, `--dry-run` to print the plan without executing. Never touches the NAS directly — prompts the operator one command at a time and interprets output to decide the next step.
---

# /deploy-nas — Synology NAS deploy driver

You are about to guide the operator through a deploy to the waldo.WTF
production container on the Synology DS223. **You do not have SSH access
to the NAS.** Your job is to post exactly one command at a time, wait
for the operator to paste the output, interpret it against the expected
pattern, and decide whether to advance, retry, or roll back.

Reference: [../../../docs/plans/deploy-nas-skill.md](../../../docs/plans/deploy-nas-skill.md)
for the design rationale and scope boundary. This file is the runtime.

## Flags

Parse the arguments passed to the skill:

- `--migrate <name>` — also run a one-shot migration between "stop" and
  "restart". `<name>` must match a file in
  [../../../docs/migrations/](../../../docs/migrations/) (without the
  `.md` extension). Examples: `--migrate body-backfill`.
- `--dry-run` — print the full planned sequence with every command and
  expected output, but do not prompt the operator to run anything.
  Stops after the plan.
- No flags — routine deploy: tests → build → ship → restart. No stop,
  no snapshot, no migration.

If `--migrate` is passed without a name, or with a name that has no
recipe file, **list the contents of `docs/migrations/INDEX.md` and
stop**. Never invent a migration.

## Step 0 — Load the registry (Claude-only)

Before prompting the operator:

1. Read [../../../docs/migrations/INDEX.md](../../../docs/migrations/INDEX.md)
   so you know what's registered.
2. If `--migrate <name>` was passed, read the full recipe at
   `../../../docs/migrations/<name>.md`. Note its pre-verify, command,
   post-verify, rollback, idempotence, smoke prompt sections — you will
   cite them verbatim.
3. Read [../../../docker-compose.yml](../../../docker-compose.yml) and
   extract the service name (should be `waldo`), image tag (should be
   `waldo-wtf:local`), and the host bind mount path (should be
   `/volume1/docker/waldo-wtf`). If any of these differ from the
   hardcoded assumptions below, **stop and surface the mismatch** — the
   recipes encode these paths literally.
4. Read [../../../deploy-to-nas.sh](../../../deploy-to-nas.sh) and
   confirm it still exists. This is the Mac→NAS shipper.

## Step 1 — Pre-flight (Claude-only, no operator interaction)

Run these in order. Any failure stops the skill; fix first, retry later.

1. **Tests green.** Run `npm test` via Bash. Expect `Tests  N passed
   (N)` and no failed suites. If red, stop: a failing local suite must
   not ship.
2. **Git state.** Run `git status --short`. If non-empty, list the
   dirty files and ask the operator: "You have uncommitted changes:
   <list>. These will be included in the image via `COPY src ./src`.
   OK to proceed? (yes/no)". If they say no, stop.
3. **Unpushed commits.** Run `git log --oneline origin/main..HEAD`. If
   non-empty, tell the operator they're about to deploy commits that
   aren't on `origin/main` yet — surface the list and ask confirmation.
4. **Branch.** Run `git branch --show-current`. If not `main`, warn and
   ask confirmation.
5. **Migration prerequisites** (only if `--migrate`). Walk the recipe's
   "Prerequisites" section and check each one you can verify locally
   (e.g. "src/cli.ts must accept `--backfill-bodies`" → grep for the
   flag in `src/cli.ts`). Any unmet prerequisite stops the skill.

Post the full plan in chat — every command you'll ask the operator to
run, in order, with what each one does. End with: "Ready to start? Say
'go' to begin Step 2." Wait for confirmation before prompting anything.

If `--dry-run`, stop here. The plan is the whole output.

## Step 2 — Local build (operator runs)

Post this single command:

```sh
docker buildx build --platform linux/arm64 -t waldo-wtf:local --load .
```

Explain: "This rebuilds the arm64 image for the DS223 and loads it into
OrbStack's local daemon. Expect ~30–60s on a cache hit, ~2–3min cold."

**Expected success pattern** in the output tail:
- `=> => naming to docker.io/library/waldo-wtf:local`
- Build duration line.
- `1 warning found ...SecretsUsedInArgOrEnv... WALDO_AUTH_DIR` — this
  is a **known false positive**, tell the operator to ignore it.

**Failure patterns**:
- `failed to compute cache key` → the Dockerfile changed paths; re-read
  the Dockerfile and surface the issue.
- `better-sqlite3` build errors → the arm64 prebuilt is missing and the
  fallback C compile failed; surface the full error and stop.

Wait for the operator to paste output. Confirm the naming line appears,
then advance.

## Step 3 — Ship to NAS (operator runs)

```sh
./deploy-to-nas.sh
```

Explain: "This saves the image to `/tmp/waldo-wtf.tar`, scp's it to
`waldonas3`, loads it into the NAS Docker daemon, and removes the
tarball. You'll be prompted for your NAS sudo password — possibly
twice."

**Expected success pattern**:
- `-rw-------... /tmp/waldo-wtf.tar` with a size in hundreds of MB.
- `waldo-wtf.tar ... 100% ...` scp progress line.
- `Loaded image: waldo-wtf:local`
- `docker image ls waldo-wtf` showing the new image ID and size.
- Final `==> Done.`

**Known-harmless quirk**: if there's already an image with the same
tag, the loader may say `The image waldo-wtf:local already exists,
renaming the old one with ID sha256:... to empty string`. That's
Synology's orphan-tag pattern — ignore it. The new image is now
authoritative.

**Failure patterns**:
- `Permission denied (publickey)` → SSH key not loaded; stop and tell
  operator to fix.
- `No space left on device` → NAS is full; stop.

## Step 4 — SSH into the NAS + stop container (operator runs)

Post:

```sh
ssh waldo@waldonas3
```

Wait for the operator to confirm they're in. Then post:

```sh
cd /volume1/docker/waldo-wtf
sudo docker compose stop
```

Explain: "The backfill and any migration need an exclusive write lock
on `lake.db`, so we stop the running container first. Routine deploys
also benefit from a clean stop before the image swap."

**Expected**:
- First `sudo` may prompt for password twice on a cold session — tell
  operator this is normal, not an error.
- `✔ Container waldo-wtf  Stopped` (note: container name is
  `waldo-wtf`, service name is `waldo`, image is `waldo-wtf:local` —
  do not mix them up in later commands).

## Step 5 — Snapshot (only if `--migrate`)

Derive the snapshot name from the migration: `lake.db.pre-<name>-YYYYMMDD`.

Post:

```sh
sudo cp db/lake.db db/lake.db.pre-<name>-$(date +%Y%m%d)
sudo ls -lh db/lake.db*
```

Explain: "Bit-for-bit snapshot of the lake before the migration
touches it. 842 MB copies in sub-second on the SSD. Keep the snapshot
for 24h in case we need to roll back."

**Expected**:
- Two `lake.db*` files of matching size.
- Possibly `lake.db-wal` (few MB) and `lake.db-shm` (32 KB) — these
  are uncommitted WAL pages from the last sync tick, and they will
  stay around. The migration will absorb them through `tsx`'s own
  better-sqlite3 handle.

## Step 6 — Pre-verify (only if `--migrate`)

Post the recipe's Pre-verify command verbatim. Explain what the expected
output signals.

**Known gotcha** for recipes that query SQLite from outside the waldo
image: the `keinos/sqlite3` image runs as root (UID 0), but `lake.db`
is owned by UID 1000. WAL-mode open fails with `attempt to write a
readonly database (8)` even for read-only queries, because SQLite
needs to touch the SHM file. The workaround, already baked into every
recipe, is to open with `"file:/db/lake.db?immutable=1"` which tells
SQLite to read the file without touching WAL or SHM at all.

If the operator pastes a `readonly database (8)` error, the recipe
command is wrong — audit the recipe. If the recipe already has
`immutable=1` and the error still happens, the DB is actually
read-only at the filesystem level (permissions regression) — stop.

**Branch**: if the pre-verify output indicates the migration has
already run (e.g. `user_version` is already at the target), ask the
operator whether to skip or force re-run. Per the recipe's idempotence
section, most migrations are safe to re-run.

## Step 7 — Run migration (only if `--migrate`)

Post the recipe's Command verbatim. Cite the expected output pattern
and the expected wall-clock duration from the recipe.

**Hard rules** (from body-backfill experience):
- Service name: `waldo` (not `waldo-wtf`).
- Never override the entrypoint. The image runs `tsx src/cli.ts`
  natively — just append flags via
  `docker compose run --rm waldo <flags>`. Overriding with `node
  --experimental-strip-types` fails with `ERR_MODULE_NOT_FOUND` on
  TypeScript `.js` import rewriting.

Wait for the migration to complete. If the output matches the recipe's
success pattern, advance. If it doesn't, consult the recipe's Risks
section before deciding between retry, rollback, or escalate.

## Step 8 — Post-verify (only if `--migrate`)

Post the recipe's Post-verify command. Check the output against the
recipe's expected success pattern.

**On failure**: enter rollback mode. Post the recipe's Rollback
section as a sequence of commands, one at a time:

```sh
sudo docker compose stop
sudo mv db/lake.db db/lake.db.broken
sudo mv db/lake.db.pre-<name>-YYYYMMDD db/lake.db
sudo rm -f db/lake.db-wal db/lake.db-shm
sudo docker compose up -d
```

Confirm the container comes back healthy at the pre-migration state.
Report the failure, including the full post-verify output, so the
operator can investigate offline. Do not retry the migration in the
same session.

## Step 9 — Restart container

Post:

```sh
sudo docker compose up -d
```

Then:

```sh
sleep 30
sudo docker compose ps
sudo docker compose logs --tail=60
```

Explain: "The compose file has a health check that polls `/health`
every few seconds. First startup usually reaches `(healthy)` within
~30s. The first sync tick takes a minute or two to log because it
catches up whatever arrived while the container was stopped."

**Expected**:
- `ps` shows `Up N seconds (healthy)` and port `0.0.0.0:8765->8765/tcp`.
- `logs` contains:
  - `waldo.WTF MCP server listening on http://0.0.0.0:8765`
  - `starting initial sync tick (this may take a while on first run)`
  - Eventually: `sync tick complete: N account(s), M ok, 0 error(s)`.

**Quirk**: `logs --tail` immediately after `up -d` may return empty
because the log buffer hasn't flushed. Tell the operator to re-run
after ~30s. Not an error.

**Failure patterns**:
- `(health: starting)` that never advances → check `logs` for errors
  like `ConfigError`, `EADDRINUSE`, `ENOENT` on volumes.
- `error calling getDelta ... 401` → token cache invalid; operator
  needs `--add-account` again for that account.

## Step 10 — Smoke (operator action in Claude Desktop)

For routine deploys, post:

> Open Claude Desktop and ask: *"Which accounts do you have access to,
> and when was the last sync?"*
>
> Expected: Claude calls `list_accounts` and `get_sync_status`, returns
> a fresh response (not a cached one). `last_ok_at` should be within
> the last few minutes.

For `--migrate <name>` deploys, post the **Smoke prompt** section from
the recipe verbatim, including the success and failure signals.

## Step 11 — Report

Post a short summary:

```
Deploy complete.
- Mode: routine | --migrate <name> | --dry-run
- Image: waldo-wtf:local (sha256:<first 12>)
- Duration: local build <X>s, ship <Y>s, migration <Z>s (if any), total <T>.
- Snapshot (if migration): /volume1/docker/waldo-wtf/db/lake.db.pre-<name>-<date>
  — remove after 24h with `sudo rm db/lake.db.pre-<name>-*`.
- Health: (healthy) at <timestamp>.
- Sync: first post-restart tick — <status>.
- Smoke result: <what the operator observed in Claude Desktop>.
- Anomalies: <anything unusual — surface even if non-blocking>.
```

## Things to NEVER do

- Never SSH to the NAS yourself. You have no credentials there, and
  even if you did, sudo password stays on the operator side.
- Never run `docker compose down` — that removes the container and can
  lose unmounted state. Always use `stop`/`up -d`.
- Never run `docker system prune` or `docker volume prune` — could
  delete the bind-mounted data directories or their sibling volumes.
- Never invent a migration name. `--migrate` arguments must match an
  existing recipe file 1:1.
- Never skip the snapshot when `--migrate` is active, even if the
  operator says "it's fine, I'll risk it". The snapshot is sub-second
  and 842 MB — the cost is zero, the value on a bad migration is
  "didn't lose a year of mail".
- Never mark a deploy "done" if the post-verify, health, or smoke
  step didn't match the expected pattern. "Note and continue" is how
  production breaks silently.

## Today's lessons (baked-in hints)

These are gotchas discovered on 2026-04-15 during the first production
run. The recipes encode them, and Claude should recognize them in
operator output:

1. **Service name is `waldo`**, not `waldo-wtf`. `docker compose run
   --rm waldo ...` — the `no such service: waldo-wtf` error means the
   command was wrong, not the compose file.
2. **Don't override the entrypoint**. `docker compose run --rm waldo
   --backfill-bodies` (good) vs `docker compose run --rm --entrypoint
   "" waldo node --experimental-strip-types src/cli.ts
   --backfill-bodies` (bad, fails with `ERR_MODULE_NOT_FOUND`).
3. **SQLite readonly queries need `immutable=1`**. WAL-mode + UID
   mismatch between `keinos/sqlite3` (root) and `lake.db` owner
   (UID 1000) breaks even read-only opens. The `immutable=1` URI
   parameter bypasses WAL and SHM entirely.
4. **First `sudo` re-prompts.** On a fresh SSH session, the first
   `sudo` command may prompt for password twice (Synology quirk). Not
   an error.
5. **`logs --tail` can return empty** right after `up -d`. Buffer
   hasn't flushed. Re-run after 30s.
6. **`Loaded image ... renaming the old one ... to empty string`** is
   a Synology pattern for orphaning the previous tag. Harmless.
