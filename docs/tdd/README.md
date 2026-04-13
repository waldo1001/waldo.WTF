# TDD Toolkit — waldo.WTF

Read in this order:

1. [methodology.md](methodology.md) — the RED/GREEN/REFACTOR workflow and the definition-of-done. Read this first, every time.
2. [testability-patterns.md](testability-patterns.md) — how to make this project's seams (MSAL, Graph, SQLite, clock, fs, HTTP) injectable.
3. [ai-maintainability.md](ai-maintainability.md) — code rules that keep the codebase legible to humans and future Claude sessions.
4. [coverage-policy.md](coverage-policy.md) — 90% thresholds, exclusions, enforcement.

Drop-in tooling: [../../testing/](../../testing/) — Vitest config, dev deps, and example test scaffolds ready to copy into the TypeScript project at Weekend 2.

Invoke [`/tdd-cycle`](../../.claude/skills/tdd-cycle/SKILL.md) at the start of any coding task.
