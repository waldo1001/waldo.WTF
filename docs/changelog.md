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

- Landed Weekend 2 folder skeleton (`src/auth`, `src/store`, `src/sync`, `src/mcp`) + pure `loadConfig(env)` ([src/config.ts](../src/config.ts)) returning typed `Config` or throwing `ConfigError` listing all missing keys. 10 tests cover defaults, overrides, single/multi missing, empty-string, immutability. Stub `main()` in [src/index.ts](../src/index.ts). Env contract documented in [.env.example](../.env.example). Plan: [weekend-2-slice-4-folder-structure-and-config.md](plans/weekend-2-slice-4-folder-structure-and-config.md).
- Landed `GraphClient` seam ([src/sources/graph.ts](../src/sources/graph.ts)) + scripted `FakeGraphClient` ([src/testing/fake-graph-client.ts](../src/testing/fake-graph-client.ts)). 5 contract tests cover scripted ok/error replay, script order, past-end diagnostics, and `GraphRateLimitedError.retryAfterSeconds`. Plan: [weekend-2-slice-3-fake-graph-client.md](plans/weekend-2-slice-3-fake-graph-client.md).
- Landed `FileSystem` seam ([src/fs.ts](../src/fs.ts)) + `InMemoryFileSystem` trigger-driven fake ([src/testing/in-memory-file-system.ts](../src/testing/in-memory-file-system.ts)). 7 contract tests cover read/write/rename/listDir/watch incl. `"WhatsApp Chat*.txt"` glob. Plan: [weekend-2-slice-2-filesystem-seam.md](plans/weekend-2-slice-2-filesystem-seam.md).
- Bootstrapped TypeScript project in-place: `package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`. Node 22, ESM, strict TS, per-file 90% coverage thresholds. See [PROGRESS.md](../PROGRESS.md) Weekend 2.
- Landed first seam: `Clock` interface + `systemClock` ([src/clock.ts](../src/clock.ts)) and `FakeClock` test double ([src/testing/fake-clock.ts](../src/testing/fake-clock.ts)). 4 tests, 100% coverage on `clock.ts`.
- Added mandatory **Step 0 PLAN** to the TDD loop ([CLAUDE.md](../CLAUDE.md), [.claude/skills/tdd-cycle/SKILL.md](../.claude/skills/tdd-cycle/SKILL.md)): every task now writes an approvable md plan under [docs/plans/](plans/) before any FRAME/RED/code. First plan: [weekend-2-slice-1-bootstrap-and-clock.md](plans/weekend-2-slice-1-bootstrap-and-clock.md).
- Weekend 2 scaffolds in-place at `/Users/waldo/SourceCode/Community/waldo.WTF/`; spike at `/Users/waldo/Temp/waldo-wtf-spike` is reference-only.
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
