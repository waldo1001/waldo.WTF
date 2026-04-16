---
name: deploy-nas
description: Deploy waldo.WTF to the Synology DS223 NAS. Runs all local steps (tests, build, save, scp) automatically, then hands the operator a single NAS-side script block for the sudo-gated commands. Use whenever shipping code changes to the running NAS container, OR when running any data migration from docs/migrations/. Flags; `--migrate <name>` to run a registered migration, `--dry-run` to print the plan without executing.
---

# /deploy-nas — Synology NAS deploy driver

You are deploying waldo.WTF to the production container on the Synology
DS223. **Run every local command yourself via the Bash tool.** Only hand
off to the operator for NAS-side commands that require `sudo` (which
needs an interactive password).

Reference: [../../../docs/plans/deploy-nas-skill.md](../../../docs/plans/deploy-nas-skill.md)
for the design rationale and scope boundary.

## Automation principle

**Run it yourself unless you physically can't.** The only thing you
cannot do is type a sudo password on the NAS. Everything else — tests,
git checks, docker build, docker save, scp — you execute directly via
the Bash tool. For NAS-side commands, batch them into the fewest
possible operator interactions.

## Flags

Parse the arguments passed to the skill:

- `--migrate <name>` — also run a one-shot migration between "stop" and
  "restart". `<name>` must match a file in
  [../../../docs/migrations/](../../../docs/migrations/) (without the
  `.md` extension). Examples: `--migrate body-backfill`.
- `--dry-run` — print the full planned sequence with every command and
  expected output, but do not execute anything. Stops after the plan.
- No flags — routine deploy: tests → build → ship → restart. No
  snapshot, no migration.

If `--migrate` is passed without a name, or with a name that has no
recipe file, **list the contents of `docs/migrations/INDEX.md` and
stop**. Never invent a migration.

## Step 0 — Load the registry (Claude-only, no output)

Before doing anything:

1. Read [../../../docs/migrations/INDEX.md](../../../docs/migrations/INDEX.md)
   so you know what's registered.
2. If `--migrate <name>` was passed, read the full recipe at
   `../../../docs/migrations/<name>.md`. Note its pre-verify, command,
   post-verify, rollback, idempotence, smoke prompt sections — you will
   cite them verbatim later.
3. Read [../../../docker-compose.yml](../../../docker-compose.yml) and
   extract the service name (should be `waldo`), image tag (should be
   `waldo-wtf:local`), and the host bind mount path (should be
   `/volume1/docker/waldo-wtf`). If any of these differ from the
   hardcoded assumptions below, **stop and surface the mismatch**.
4. Read [../../../deploy-to-nas.sh](../../../deploy-to-nas.sh) and
   confirm it still exists.

## Step 1 — Pre-flight (Claude runs everything)

Run these via the Bash tool, in parallel where independent. Any failure
stops the skill.

1. **Tests green.** Run `npm test` via Bash. Expect all suites to pass.
   If red, stop — a failing local suite must not ship.
2. **Git state.** Run `git status --short`. If non-empty, list the
   dirty files and ask the operator: "You have uncommitted changes:
   <list>. These will be included in the image. OK to proceed?"
   If they say no, stop.
3. **Unpushed commits.** Run `git log --oneline origin/main..HEAD`. If
   non-empty, tell the operator and ask confirmation.
4. **Branch.** Run `git branch --show-current`. If not `main`, warn and
   ask confirmation.
5. **Migration prerequisites** (only if `--migrate`). Walk the recipe's
   "Prerequisites" section and check each one you can verify locally.
   Any unmet prerequisite stops the skill.

If `--dry-run`, post the full planned sequence and stop here.

## Step 2 — Local build (Claude runs)

Run via Bash tool:

```sh
docker buildx build --platform linux/arm64 -t waldo-wtf:local --load .
```

**Expected success pattern** in the output tail:
- `naming to docker.io/library/waldo-wtf:local`
- `1 warning found ...SecretsUsedInArgOrEnv... WALDO_AUTH_DIR` — known
  false positive, ignore it.

**Failure patterns**:
- `failed to compute cache key` → Dockerfile changed paths; read the
  Dockerfile and surface the issue.
- `better-sqlite3` build errors → arm64 prebuilt missing; surface the
  full error and stop.

## Step 3 — Save and ship image (Claude runs)

Run these via Bash tool sequentially:

```sh
docker save waldo-wtf:local -o /tmp/waldo-wtf.tar
ls -lh /tmp/waldo-wtf.tar
```

Then ship via scp (SSH key auth works non-interactively):

```sh
scp -O /tmp/waldo-wtf.tar waldo@waldonas3:/tmp/waldo-wtf.tar
```

Then clean up the local tarball:

```sh
rm /tmp/waldo-wtf.tar
```

**Expected**: tarball is ~500 MB. scp completes in ~10-30s over
Tailscale.

**Failure patterns**:
- `Permission denied (publickey)` → SSH key not loaded; stop.
- `No space left on device` (on NAS side) → NAS is full; stop.

## Step 4 — NAS-side commands (operator runs)

This is the **only step that needs the operator**. `sudo` on the NAS
requires an interactive password, so you cannot run these commands
yourself.

### For routine deploys (no `--migrate`)

Post a single script block the operator can paste after SSH-ing in:

```
SSH into the NAS and run these commands:

    ssh waldo@waldonas3

Then paste this block:

    cd /volume1/docker/waldo-wtf
    sudo docker load -i /tmp/waldo-wtf.tar
    sudo docker compose stop
    sudo docker compose up -d
    rm /tmp/waldo-wtf.tar
    sleep 30
    sudo docker compose ps
    sudo docker compose logs --tail=60
```

Tell the operator: "You'll be prompted for your sudo password — possibly
twice on a fresh session (Synology quirk). Paste the full output when
done."

### For `--migrate` deploys

Post a multi-phase script. The operator must paste output after each
phase so you can verify before proceeding.

**Phase A — Load image + stop + snapshot:**

```sh
cd /volume1/docker/waldo-wtf
sudo docker load -i /tmp/waldo-wtf.tar
sudo docker compose stop
sudo cp db/lake.db db/lake.db.pre-<name>-$(date +%Y%m%d)
sudo ls -lh db/lake.db*
rm /tmp/waldo-wtf.tar
```

Wait for output. Verify snapshot sizes match. Then post:

**Phase B — Pre-verify:**

Post the recipe's Pre-verify command verbatim.

**Known gotcha**: `keinos/sqlite3` runs as root (UID 0), but `lake.db`
is owned by UID 1000. WAL-mode open fails with `readonly database (8)`.
Recipes use `"file:/db/lake.db?immutable=1"` to bypass this.

If pre-verify shows the migration already ran, ask operator whether to
skip or re-run.

**Phase C — Run migration:**

Post the recipe's Command verbatim. Cite expected output and duration.

**Hard rules**:
- Service name: `waldo` (not `waldo-wtf`).
- Never override the entrypoint. Use
  `docker compose run --rm waldo <flags>`.

Wait for output. Verify against recipe's success pattern.

**Phase D — Post-verify + restart:**

Post the recipe's Post-verify command. If it passes, then:

```sh
sudo docker compose up -d
sleep 30
sudo docker compose ps
sudo docker compose logs --tail=60
```

**On post-verify failure**: enter rollback mode:

```sh
sudo docker compose stop
sudo mv db/lake.db db/lake.db.broken
sudo mv db/lake.db.pre-<name>-YYYYMMDD db/lake.db
sudo rm -f db/lake.db-wal db/lake.db-shm
sudo docker compose up -d
```

Report the failure with full output. Do not retry in the same session.

## Step 5 — Verify health (Claude interprets operator output)

When the operator pastes the output from Step 4, check:

**Expected from `docker compose ps`**:
- `Up N seconds (healthy)` and port `0.0.0.0:8765->8765/tcp`.

**Expected from `docker compose logs --tail=60`**:
- `waldo.WTF MCP server listening on http://0.0.0.0:8765`
- `starting initial sync tick`
- Eventually: `sync tick complete: N account(s), M ok, 0 error(s)`.

**Quirk**: `logs --tail` immediately after `up -d` may return empty
because the log buffer hasn't flushed. Tell the operator to re-run
after ~30s. Not an error.

**Failure patterns**:
- `(health: starting)` that never advances → check `logs` for
  `ConfigError`, `EADDRINUSE`, `ENOENT`.
- `error calling getDelta ... 401` → token cache invalid; operator
  needs `--add-account` again.

## Step 6 — Smoke (operator action in Claude Desktop)

For routine deploys, tell the operator:

> Open Claude Desktop and ask: *"Which accounts do you have access to,
> and when was the last sync?"*
>
> Expected: Claude calls `list_accounts` and `get_sync_status`, returns
> a fresh response. `last_ok_at` should be within the last few minutes.

For `--migrate <name>` deploys, post the **Smoke prompt** section from
the recipe verbatim.

## Step 7 — Report

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

- Never type or guess a sudo password. That stays on the operator side.
- Never run `docker compose down` — that removes the container and can
  lose unmounted state. Always use `stop`/`up -d`.
- Never run `docker system prune` or `docker volume prune` — could
  delete bind-mounted data.
- Never invent a migration name. `--migrate` arguments must match an
  existing recipe file 1:1.
- Never skip the snapshot when `--migrate` is active, even if the
  operator says "it's fine". Sub-second cost, infinite rollback value.
- Never mark a deploy "done" if health or smoke didn't match the
  expected pattern.

## Baked-in hints (from production experience)

1. **Service name is `waldo`**, not `waldo-wtf`. Container name is
   `waldo-wtf`. Don't mix them up.
2. **Don't override the entrypoint**. `docker compose run --rm waldo
   --backfill-bodies` (good) vs overriding with `node
   --experimental-strip-types` (bad, fails with `ERR_MODULE_NOT_FOUND`).
3. **SQLite readonly queries need `immutable=1`**. WAL-mode + UID
   mismatch between `keinos/sqlite3` (root) and `lake.db` owner
   (UID 1000) breaks even read-only opens.
4. **First `sudo` re-prompts.** Synology quirk on fresh SSH sessions.
5. **`logs --tail` can return empty** right after `up -d`. Re-run
   after 30s.
6. **`Loaded image ... renaming the old one ... to empty string`** is
   Synology's orphan-tag pattern. Harmless.
7. **SSH key auth works** — `ssh waldo@waldonas3` connects without a
   password. Only `sudo` on the NAS is interactive.
