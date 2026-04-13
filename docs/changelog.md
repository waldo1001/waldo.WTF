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

- Landed real `SqliteMessageStore` ([src/store/sqlite-message-store.ts](../src/store/sqlite-message-store.ts)) behind the slice-6 `MessageStore` seam, backed by `better-sqlite3` with `messages` + `sync_state` tables, transactional `upsertMessages` (rolls back whole batch on mid-batch failure), millisecond `Date` round-trip, and nullable-field → `undefined` round-trip. Contract tests extracted to shared helper ([src/store/message-store-contract.ts](../src/store/message-store-contract.ts)) so `InMemoryMessageStore` and `SqliteMessageStore` run the same 10 cases. Added `openDatabase(path)` helper ([src/store/open-database.ts](../src/store/open-database.ts)) applying WAL + `foreign_keys=ON` + `synchronous=NORMAL`. `accounts` / `sync_log` / FTS5 / query ops still deferred to their first consuming tests. 16 new tests, 100% line + branch coverage. Plan: [weekend-2-slice-7-sqlite-message-store.md](plans/weekend-2-slice-7-sqlite-message-store.md).
- Landed `src/store` testable core: `Message`/`SyncStateEntry`/`MessageSource` types + `StoreError` ([src/store/types.ts](../src/store/types.ts)) mirroring brief §5 1:1, `MessageStore` interface ([src/store/message-store.ts](../src/store/message-store.ts)) with `upsertMessages`/`deleteMessages`/`get`+`setSyncState`, and `InMemoryMessageStore` scripted fake with `calls` log + `seed` ([src/testing/in-memory-message-store.ts](../src/testing/in-memory-message-store.ts)). 16 new tests (10 contract + 4 fake-specific + 2 StoreError), 100% branch coverage on touched files. Real `better-sqlite3` adapter + FTS5 + `sync_log`/`accounts` tables + query ops deferred to follow-up slices. Plan: [weekend-2-slice-6-store-seam.md](plans/weekend-2-slice-6-store-seam.md).
- Landed `src/auth` testable core: `Account`/`AccessToken`/`AuthError` types ([src/auth/types.ts](../src/auth/types.ts)), `AuthClient` interface ([src/auth/auth-client.ts](../src/auth/auth-client.ts)), fs-seam-backed `TokenCacheStore` with atomic temp+rename write at mode `0o600` ([src/auth/token-cache-store.ts](../src/auth/token-cache-store.ts)), and scripted `FakeAuthClient` ([src/testing/fake-auth-client.ts](../src/testing/fake-auth-client.ts)). 17 new tests, 100% branch coverage on touched files. `InMemoryFileSystem` extended with `ops` log, `modeOf`, `injectReadError` to support atomic-write and corruption tests. Real `@azure/msal-node` adapter deferred to a follow-up slice. Plan: [weekend-2-slice-5-auth-seam-and-token-cache.md](plans/weekend-2-slice-5-auth-seam-and-token-cache.md).
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
