# Plan: `/deploy-nas` skill + migration registry

## Task

Turn today's manual NAS deploy dance (build image on Mac → ship → stop
container → maybe run migration → verify → restart → smoke) into a
repeatable Claude-driven workflow, plus a migration registry the skill
can look up recipes from.

## Scope boundary

**In scope:**
- New skill at [.claude/skills/deploy-nas/SKILL.md](../../.claude/skills/deploy-nas/SKILL.md).
- New directory `docs/migrations/` with an `INDEX.md` and one migration
  recipe: `body-backfill.md` (today's Slice A backfill), so the skill
  has at least one entry to drive.
- Explicit flags only:
  - `/deploy-nas` — routine deploy (tests → build → ship → restart).
  - `/deploy-nas --migrate <name>` — routine deploy + run one named
    migration between "stop" and "restart". `<name>` must match a file
    in `docs/migrations/`.
  - `/deploy-nas --dry-run` — prints the plan without executing.
- Skill drives step-by-step: prompts user one command at a time, waits
  for output, interprets, decides next step.
- Bake in today's lessons so we don't rediscover them: service name
  `waldo`, no entrypoint override, `immutable=1` SQLite URI for
  readonly queries, sudo password re-prompts, first-tick log delay.
- Rollback runbook in the skill, driven from the snapshot the skill
  itself creates.

**Out of scope:**
- Auto-detecting migrations from git diff. Explicit only.
- Running migrations that aren't in the registry. Unknown `<name>` =
  skill refuses and lists known migrations.
- Touching the NAS via automation (SSH key, `docker -H`, etc.). All NAS
  commands go through the user — sudo password stays local to them.
- A generic `/deploy` skill. This one is Synology-specific; a Mac-local
  compose deploy is a different workflow.
- Changing any production code.

## Files to touch

- `.claude/skills/deploy-nas/SKILL.md` — **new**, the skill.
- `docs/migrations/INDEX.md` — **new**, lists every registered
  migration with name, one-line description, and link to its recipe.
- `docs/migrations/body-backfill.md` — **new**, recipe for today's
  backfill. Schema: see below.
- `CLAUDE.md` — add `/deploy-nas` to the Repo-local skills section so
  it's discoverable from the project brief.
- `docs/changelog.md` — dated entry.

## Migration recipe schema

Every file in `docs/migrations/<name>.md` has this shape, so the skill
can read any one the same way:

```markdown
# <name>

**Status**: active | obsolete | deprecated
**Added**: YYYY-MM-DD
**One-line**: <what this migration does in one sentence>

## Why
<1-2 paragraphs on the bug or need that motivated this migration>

## Prerequisites
- <schema version required, e.g. "user_version >= 5">
- <container image must contain: e.g. "src/cli.ts --backfill-bodies flag">
- <any other preconditions>

## Pre-verify
```sh
<exact command the skill runs to check the problem still exists>
```
Expected: <what counts as "yes, run the migration">.

## Command
```sh
<exact docker compose run ... invocation>
```
Expected output pattern: <what a successful run looks like>.

## Post-verify
```sh
<exact command to confirm the migration succeeded>
```
Expected: <what counts as success>.

## Rollback
<specific rollback for this migration, usually "restore the snapshot">

## Idempotence
<what happens if the migration is run twice — the skill uses this to
decide whether re-runs are safe>

## Risks
<bullet list of things that can go wrong and how the skill should react>
```

## Skill step flow

The SKILL.md enumerates these phases. Each phase lists the exact
prompt the skill posts to the user, the exact expected output pattern,
and the branch taken on anomaly.

1. **Pre-flight (Claude-driven, no user interaction)**:
   - `npm test` must pass.
   - `git status` must be clean, or user confirms.
   - `git log origin/main..HEAD` — warn if unpushed commits about to
     ship.
   - If `--migrate <name>`, read `docs/migrations/<name>.md`. If
     missing, list `docs/migrations/INDEX.md` and stop.
   - Post the full planned sequence in chat, ask for one "go" token.

2. **Local build (user runs)**:
   - Command: `docker buildx build --platform linux/arm64 -t waldo-wtf:local --load .`
   - Expected tail: `naming to docker.io/library/waldo-wtf:local`.
   - Known warning (ignore): `SecretsUsedInArgOrEnv` on `WALDO_AUTH_DIR`.

3. **Ship to NAS (user runs)**:
   - Command: `./deploy-to-nas.sh`.
   - Expected tail: `Loaded image: waldo-wtf:local` + `docker image ls`
     listing.

4. **SSH + stop (user runs)**:
   - `ssh waldo@waldonas3` then `cd /volume1/docker/waldo-wtf`.
   - `sudo docker compose stop` — note: first sudo may reprompt.

5. **Snapshot** (only when `--migrate` was passed):
   - `sudo cp db/lake.db db/lake.db.pre-<migration-name>-$(date +%Y%m%d)`
   - `sudo ls -lh db/lake.db*` — skill checks snapshot size ≈ original.

6. **Pre-verify** (from migration recipe, only if `--migrate`):
   - Runs the recipe's pre-verify command (SQLite with
     `immutable=1`).
   - Expected output from recipe.

7. **Run migration** (only if `--migrate`):
   - Runs the recipe's command.
   - Interprets output against the recipe's expected pattern.

8. **Post-verify** (only if `--migrate`):
   - Runs the recipe's post-verify command.
   - If it fails, skill enters rollback mode: guides user through
     `mv` of the snapshot back into place.

9. **Restart**:
   - `sudo docker compose up -d`
   - Wait 30s (the skill tells the user to `sleep 30`, not to poll).
   - `sudo docker compose ps` — expect `(healthy)`.
   - `sudo docker compose logs --tail=60` — expect `listening on ...`
     and eventually `sync tick complete: N account(s), M ok, 0 error(s)`.

10. **Smoke prompt**:
    - For a routine deploy: "curl health + list_accounts via Claude
      Desktop".
    - For `--migrate`: skill posts the exact Claude Desktop question
      from the recipe, tells user what a success response looks like.

11. **Report**:
    - Summary of what changed, migration name (if any), snapshot path,
      duration estimates, "clean up snapshot after 24h" reminder.

## Out-of-scope / deferred

- Backfill body slice (already run in this session — `body-backfill.md`
  will be written as "status: active, can still be re-run safely").
- Slice B `include_body` — does not need a migration, it's a code-only
  change; routine `/deploy-nas` will ship it.
- Automated snapshot cleanup after N days.
- A `/deploy-nas --rollback <snapshot>` mode. For now rollback is
  manual with guided steps.

## Risks

- **R1: Skill becomes stale when compose/Dockerfile change.** Mitigation:
  one skill, one source of truth — the service-name `waldo`, image
  `waldo-wtf:local`, and compose path are read from `docker-compose.yml`
  by the skill's first step (cat the file and verify). If compose
  changes, the skill's first prompt shows the mismatch.
- **R2: Migration recipe drifts from the actual CLI.** Mitigation: the
  recipe's "prerequisites" section lists the image-content
  requirement (e.g. "src/cli.ts must accept --backfill-bodies"), and
  the skill's pre-flight checks that the local source satisfies it
  before building.
- **R3: User runs skill on a detached HEAD or wrong branch.** Mitigation:
  pre-flight shows branch + HEAD commit and asks for confirmation.
- **R4: Skill prompts are ignored because user is in autonomous mode.**
  Not a real risk: the skill only runs when invoked, and the step-by-step
  pattern is the whole point.

## Definition of done

- Skill exists and is discoverable via `/deploy-nas`.
- `docs/migrations/INDEX.md` lists `body-backfill` as active.
- `docs/migrations/body-backfill.md` is fully filled in from today's
  session — everything I'd need to run it again without re-reading
  this conversation.
- CLAUDE.md references the new skill.
- Changelog updated.
- Dry-run of the skill in chat against current state works end to end
  without actually running any command — i.e. I post the plan, you
  confirm it matches what we just did, we stop there.
