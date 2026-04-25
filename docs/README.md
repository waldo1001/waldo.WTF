# waldo.WTF — Documentation

The single entry point for everything you need to understand, set up, use,
or maintain waldo.WTF. Keep this file short — link out, don't inline.

## For users

- [Getting Started](getting-started.md) — five-minute walk from zero to
  "Claude can see my mail".
- [Setup](setup.md) — detailed environment, Entra app registration,
  accounts, token cache, NAS deployment.
- [User Guide](user-guide.md) — what the MCP tools do, how to ask Claude
  about your inbox, day-to-day workflows, troubleshooting.

## For contributors (human or AI)

- [Changelog](changelog.md) — reverse-chronological, per-day, terse
  overview of what changed. Updated at the end of every TDD cycle (see
  [tdd/methodology.md §10](tdd/methodology.md)).
- [TDD methodology](tdd/methodology.md) — how every code change is made
  in this repo. Non-negotiable.
- [Testability patterns](tdd/testability-patterns.md) — how to make the
  project's seams injectable.
- [AI-maintainability rules](tdd/ai-maintainability.md) — code rules
  keeping the codebase legible to humans and future Claude sessions.
- [Coverage policy](tdd/coverage-policy.md) — 90% thresholds, exclusions,
  enforcement.
- [Runbooks](runbooks/README.md) — manual operational procedures
  (autoheal smoke test, etc).

## Project background

- [Root README](../README.md) — the project's front door: overview,
  status, scope, how to start.
- [Project brief](../waldo.WTF-project-brief.md) — why this exists, what
  it is and isn't, architecture, build plan.
- [Progress log](../PROGRESS.md) — checkbox-style weekend-by-weekend
  progress against the brief.
- [Root CLAUDE.md](../CLAUDE.md) — the prime directive for Claude sessions
  working in this repo.

## Tooling

- [Repo-local skills](../.claude/skills/) — `/tdd-cycle`, `/docs-update`.
  Invoke at the start / end of every coding task.
- [Testing toolchain templates](../testing/) — Vitest config, dev deps,
  example fakes. Drop-in at Weekend 2.
