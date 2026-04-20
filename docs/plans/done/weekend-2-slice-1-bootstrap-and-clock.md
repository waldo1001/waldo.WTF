# Weekend 2 — Slice 1: Toolchain bootstrap + Clock seam

**Status:** DRAFT — awaiting user approval before FRAME/RED.

## Task

Stand up the TypeScript project in-place at `/Users/waldo/SourceCode/Community/waldo.WTF/`, wire up vitest, and land the first production seam (`Clock`) with its in-memory fake, proven by one failing-then-passing test.

## Why this slice first

- Establishes the TDD harness end-to-end: `npm test` must actually run before any domain code arrives.
- `Clock` is the lowest-risk seam — zero external dependencies, no secrets, no network, no SQLite native build — so toolchain problems surface on their own without being tangled up with MSAL/Graph/better-sqlite3 build issues.
- Every downstream seam (sync loop, token refresh, delta state) injects a clock, so this is genuinely load-bearing, not busywork.

## Scope boundary

**IN this slice:**
- `package.json` (npm init, scripts: `test`, `test:watch`, `typecheck`)
- `tsconfig.json` (strict, NodeNext, target ES2022, `src/` → `dist/`)
- `vitest.config.ts` copied from [testing/vitest.config.ts](../../testing/vitest.config.ts)
- Dev deps merged from [testing/package.deps.json](../../testing/package.deps.json): `typescript`, `tsx`, `vitest`, `@vitest/coverage-v8`, `@types/node`
- `.gitignore` additions: `node_modules/`, `dist/`, `coverage/`
- `src/clock.ts` — `Clock` interface (`now(): Date`) and `systemClock` impl
- `src/testing/fake-clock.ts` — `FakeClock` with `constructor(initial: Date)`, `now()`, `advance(ms: number)`, `set(d: Date)`
- `src/testing/fake-clock.test.ts` — RED list below
- Verify `npm test` runs green locally

**OUT of scope (deferred to later slices — do NOT touch in this cycle):**
- MSAL / auth wiring
- Graph client / fakes
- SQLite store, schema, better-sqlite3 install
- Sync loop
- MCP server skeleton
- `.env` loading, config module
- `src/auth`, `src/sources`, `src/store`, `src/sync`, `src/mcp` folders (create only when their first test arrives)
- Porting any spike logic
- Coverage thresholds enforcement in CI (config only, no CI file yet)

## Files to create / touch

| Path | New? | Purpose |
|---|---|---|
| `package.json` | new | project manifest + scripts + dev deps |
| `tsconfig.json` | new | strict TS config |
| `vitest.config.ts` | new (from `testing/`) | test runner + coverage config |
| `.gitignore` | new or edit | ignore build/test artifacts |
| `src/clock.ts` | new | `Clock` interface + `systemClock` |
| `src/testing/fake-clock.ts` | new | `FakeClock` test double |
| `src/testing/fake-clock.test.ts` | new | RED tests for the fake |

## Seams involved

- `clock` (introduced this slice)
- none other

## RED test list

```
- AC1: FakeClock constructed with a Date returns that Date from now()
  - test file: src/testing/fake-clock.test.ts
  - test name: "now() returns the initial time it was constructed with"
  - seams touched: clock
  - edge cases: none — this is the baseline

- AC2: FakeClock.advance(ms) moves now() forward by exactly ms milliseconds
  - test file: src/testing/fake-clock.test.ts
  - test name: "advance(ms) moves now() forward by the given milliseconds"
  - seams touched: clock
  - edge cases: advance(0) is a no-op; successive advances compound

- AC3: FakeClock.set(d) jumps now() to the given Date (forward or backward)
  - test file: src/testing/fake-clock.test.ts
  - test name: "set(d) replaces the current time with the given Date"
  - seams touched: clock
  - edge cases: setting to an earlier time works (we explicitly allow backward jumps so tests can simulate clock skew)

- AC4: systemClock.now() returns a Date within 1s of Date.now() at call time
  - test file: src/clock.test.ts
  - test name: "systemClock.now() returns current wall time"
  - seams touched: clock
  - edge cases: none — smoke test only, not a race-condition hunt
```

Four ACs, four tests. Each written and turned green one at a time per the skill.

## Open questions / assumptions

1. **Assumption:** `tsconfig.json` uses `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"strict": true`, `"target": "ES2022"`, `"outDir": "dist"`, `"rootDir": "src"`, `"esModuleInterop": true`. → **Confirm or override.**
2. **Assumption:** `package.json` uses `"type": "module"` (ESM everywhere, matching NodeNext). → **Confirm.**
3. **Assumption:** node version target = **Node 22** (matches Weekend 5 Dockerfile plan of `node:22-alpine`). Recorded in `"engines"`. → **Confirm.**
4. **Assumption:** npm is the package manager (not pnpm / yarn / bun). → **Confirm.**
5. **Assumption:** `Clock` interface surface is just `now(): Date`. No `monotonic()`, no `sleep()`, no timezone helpers. Added only when a future test demands them. → **Confirm.**
6. **Assumption:** `FakeClock.advance` takes milliseconds (number), not a `Duration` object. Simpler, matches `Date` arithmetic. → **Confirm.**
7. **Assumption:** `src/testing/` is the permanent home for test doubles (per [docs/tdd/testability-patterns.md](../tdd/testability-patterns.md)), imported by tests only. Not excluded from production build — it ships. Acceptable because it's test-only-by-convention and keeps imports simple. → **Confirm or override** (alternative: exclude from `tsconfig` build).
8. **Question:** Do you want `"packageManager"` field pinned (e.g. `npm@10.x`) for reproducibility?
9. **Question:** License field — MIT, UNLICENSED, or omit? The repo has no LICENSE file yet.

## Risks

- **Vitest config drift** — `testing/vitest.config.ts` may reference paths that don't exist yet. Mitigation: read it first in Step 1 (FRAME), adjust paths before copying.
- **ESM + NodeNext + vitest interaction** — occasional friction with `.js` extensions in imports. Mitigation: if a test fails on plumbing, fix imports before moving past Step 4 RED.
- **Coverage threshold surprise** — `testing/vitest.config.ts` likely enforces 90% line/branch. With only a clock seam this will pass trivially, but if it doesn't we'll see it early.
- **`package.json` already exists?** — `ls` showed none at root, but double-check before `npm init -y`. If it exists, abort and ask.

## Out-of-scope follow-ups (track for later slices)

- Slice 2 candidate: `Fs` seam + `FakeFs` (needed for token-cache, delta-state persistence).
- Slice 3 candidate: `Logger` seam + silent fake (needed before anything that logs).
- Slice 4 candidate: SQLite store — `openStore(path)` returns a handle, uses real `better-sqlite3` with `:memory:` in tests.
- Slice 5+: auth, graph, sync, mcp — each its own plan file.
- CI wiring (GitHub Actions running `npm test` + `npm run typecheck`) — deferred until there's enough surface to justify it.
- `.env` loading and `src/config.ts` — deferred until the first module actually needs a config value.

## Definition of done for this slice

- [ ] Plan file approved by user.
- [ ] `npm test` runs and reports 4 passing tests.
- [ ] `npm run typecheck` passes with zero errors.
- [ ] Coverage on `src/clock.ts` and `src/testing/fake-clock.ts` ≥ 90% lines + branches.
- [ ] `/security-scan` passes.
- [ ] `/docs-update` run — changelog entry added.
- [ ] PROGRESS.md Weekend 2 checkboxes ticked for: `npm init / tsconfig / tsx`, vitest config, first RED test.
