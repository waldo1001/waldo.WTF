# CLAUDE.md — waldo.WTF

Project brief: [waldo.WTF-project-brief.md](waldo.WTF-project-brief.md)
Progress: [PROGRESS.md](PROGRESS.md)

## Non-negotiable: Test-Driven Development

Every code change in this workspace — new feature, bug fix, refactor — follows
the TDD cycle defined in [docs/tdd/methodology.md](docs/tdd/methodology.md).

**The loop** (never skip a step, never merge steps):

0. **PLAN** — write a markdown plan under [docs/plans/](docs/plans/) for the
   next task: goal, scope boundary, files to touch, seams, RED test list,
   risks, out-of-scope. **Stop and wait for explicit user approval of the
   plan before doing anything else.** No FRAME, no RED, no code until the
   plan is acknowledged. This exists so the agent surfaces decisions
   instead of silently assuming them.
1. **FRAME** — post a ≤150-word framing: goal of this step, where it stands
   in the project, why it is needed, what it contributes. See
   [docs/tdd/methodology.md §2.0](docs/tdd/methodology.md).
2. **RED** — write a failing test that encodes the requirement.
3. **PROVE RED** — run it, observe the failure, confirm the failure message is
   about the thing under test (not a typo, not a missing import).
4. **SCAFFOLD** — add only the minimum shape (files, exports, types, seams) so
   the test *can* fail for the right reason. Return stubs, throw `not
   implemented`. This step exists so code is born testable.
5. **GREEN** — write the smallest implementation that turns the test green.
6. **REFACTOR** — clean up with the tests as a safety net. Tests stay green.
7. **COVER** — verify ≥90% line + branch coverage on touched files and that
   every acceptance criterion from the task has at least one named test.
8. **SECURITY SCAN** — run [`/security-scan`](.claude/skills/security-scan/SKILL.md).
   A finding blocks the cycle. Never "note and continue".
9. **UPDATE DOCS** — run [`/docs-update`](.claude/skills/docs-update/SKILL.md)
   to update the [changelog](docs/changelog.md) and any user-visible docs.
10. **REVIEW** — run the self-review checklist in
    [docs/tdd/methodology.md §2.8](docs/tdd/methodology.md).

Before writing any implementation code, **post the PLAN (and get approval),
then the FRAME, then the RED test list** in chat. Before calling a task
done, **cite the test names that cover each requirement**.

## Supporting documents

- [docs/tdd/methodology.md](docs/tdd/methodology.md) — the full TDD workflow, RED/GREEN/REFACTOR rules, definition-of-done.
- [docs/tdd/testability-patterns.md](docs/tdd/testability-patterns.md) — how to make waldo.WTF's seams (MSAL, Graph, SQLite, clock, fs, HTTP) mockable.
- [docs/tdd/ai-maintainability.md](docs/tdd/ai-maintainability.md) — rules that keep the codebase legible to both humans and future Claude sessions.
- [docs/tdd/coverage-policy.md](docs/tdd/coverage-policy.md) — 90% thresholds, exclusions, enforcement.
- [testing/](testing/) — drop-in Vitest config, dev deps, and example test scaffolds. Copy into the TypeScript project when Weekend 2 starts.

## Repo-local skills

- [`/tdd-cycle`](.claude/skills/tdd-cycle/SKILL.md) — invoke at the **start** of
  any coding task. Walks RED → GREEN → REFACTOR → COVER and produces the RED
  test list before any production code is written.
- [`/security-scan`](.claude/skills/security-scan/SKILL.md) — invoked from
  Step 10 of `/tdd-cycle` and before any commit/push. Scans for secrets,
  real tenant/account data in fixtures, log hygiene, error-message
  leakage, and (once the TS project exists) `npm audit` findings. A
  finding blocks the cycle.
- [`/docs-update`](.claude/skills/docs-update/SKILL.md) — invoke at the **end**
  of any coding task (fired from Step 11 of `/tdd-cycle`). Keeps the
  [changelog](docs/changelog.md), [setup](docs/setup.md),
  [getting-started](docs/getting-started.md), and [user guide](docs/user-guide.md)
  in sync with reality.
- [`/deploy-nas`](.claude/skills/deploy-nas/SKILL.md) — invoke when
  shipping code changes to the running Synology container, or when
  running any one-shot data migration from [docs/migrations/](docs/migrations/).
  Drives the full build → ship → stop → migrate → verify → restart →
  smoke loop one command at a time. `--migrate <name>` inserts a
  registered migration; `--dry-run` prints the plan without executing.

A task is not done until all three coding skills (tdd-cycle,
security-scan, docs-update) have been run. `/deploy-nas` is a separate
operator workflow, invoked when you want to deploy — not part of the
coding-task definition-of-done.

GitHub Copilot uses the **same** toolchain via
[.github/copilot-instructions.md](.github/copilot-instructions.md), which
points at the files above rather than duplicating them. Keep that file in
sync when the toolchain structure changes (new skill, renamed doc).

## Project-specific reminders

- Read-only forever. No write tools in the MCP surface, and no tests that
  exercise writes against real Microsoft Graph — Graph is always faked.
- SQLite uses WAL mode. Tests use in-memory (`:memory:`) or a tmp-dir db with
  WAL, never the real `lake.db`.
- Clock and filesystem are injected, never imported directly in business logic.
- Tokens, bearer secrets, account emails: never in fixtures or snapshots.
