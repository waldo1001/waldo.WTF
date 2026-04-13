# Changelog

Reverse-chronological. One entry per day that had meaningful changes.
Each entry is a short bulleted list — one bullet per change, one line
per bullet. No prose, no long explanations. Link to PROGRESS.md for
milestones and to commit hashes for detail.

Updated as the last step of every `/tdd-cycle` invocation (see
[tdd/methodology.md §10](tdd/methodology.md)) via the `/docs-update`
skill.

---

## 2026-04-13

- Added [.github/copilot-instructions.md](../.github/copilot-instructions.md) — GitHub Copilot follows the same TDD toolchain as Claude, via references (no duplication).
- Added `/security-scan` skill (gitignore baseline, secret patterns, real-data scan, log hygiene, error-message interpolation, snapshot/fixture scan, `npm audit`). Wired into the TDD cycle between COVER and UPDATE DOCS. Added root `.gitignore` with the secrets baseline.
- Added root [README.md](../README.md) as the project's front door; wired maintenance into `/docs-update` so scope / status / architecture changes update it automatically.
- Added FRAME step (≤150-word step framing) as Step 0 of the TDD cycle — every coding task now opens with goal, project position, why, and contribution.
- Established TDD methodology: RED/GREEN/REFACTOR cycle, 90% per-file coverage, AI-maintainability rules, testability patterns for all seams (Graph, MSAL, SQLite, clock, fs, logger, HTTP).
- Added repo-local `/tdd-cycle` skill enforcing the cycle at the start of every coding task.
- Added repo-local `/docs-update` skill enforcing changelog + doc updates at the end of every coding task.
- Added `/docs` skillset: index README, changelog, setup, getting-started, user guide.
- Added drop-in Vitest toolchain under `/testing`: config, deps, example fakes (`FakeClock`, `FakeGraphClient`, canonical `deltaSync` unit test).
- Weekend 1 delta queries verified: run 1 = 36154 msgs across 724 pages, run 2 = +0/-0 (see [../PROGRESS.md](../PROGRESS.md)).

## 2026-04-12

- Weekend 0 spike complete: MSAL device-code flow, Graph `Mail.Read`, better-sqlite3 WAL, single-account end-to-end on `eric.wauters@dynex.be`.
- Entra app `waldo-wtf-spike` registered (multitenant + personal MS accounts, public client flows, delegated `Mail.Read`).
- All foundational risks retired — see [project brief §7 Weekend 0](../waldo.WTF-project-brief.md).
