# Slice plan — Lint rule banning bare `fetch` (A3.4)

Parent plan: [server-hang-autoheal.md](server-hang-autoheal.md) §3.4.

## Goal

Lock in the wrapping work from slices A3.1–A3.2: any future bare `fetch`
in `src/sources/**` or `src/sync/**` must be a build/test failure. The
project has no ESLint setup yet, so this slice introduces the minimum
viable lint surface.

## Files to touch / add

- `package.json` — add devDeps `eslint` and `typescript-eslint`. Add
  `"lint": "eslint src"` script. Run lint as part of `npm test`?
  **No** — keep it separate; CI calls both. (Test runner already
  enforces correctness; lint enforces conventions and runs faster
  standalone.)
- `eslint.config.js` (new) — flat config. Two layers:
  - Base: `tseslint.configs.recommended` for type-aware basics.
  - Override for `src/sources/**` and `src/sync/**`:
    `no-restricted-globals: ['error', { name: 'fetch', message: 'Use
    the injected FetchLike, wrapped by createFetchWithTimeout. Bare
    fetch hangs forever.' }]`.
- `src/sources/__lint__/bare-fetch.fixture.ts` (new) — a deliberate
  bare-fetch call to anchor the regression test. Imports nothing,
  exports a no-op function. Excluded from production tsconfig via
  pattern (or covered by a separate tsconfig.lint).
- `src/__meta__/lint-bare-fetch.test.ts` (new) — programmatic ESLint
  invocation against the fixture, asserting the rule fires with the
  expected message.
- `docs/tdd/testability-patterns.md` — append a one-paragraph "All
  outbound HTTP must use `FetchLike` wrapped by
  `createFetchWithTimeout`" section.

## Seams

- `ESLint` API used as a library — no shell-out. Construct an `ESLint`
  instance, call `lintFiles` against the fixture, inspect the result.

## RED test list

1. `lint flags bare fetch in src/sources fixture` — invoke ESLint
   programmatically on `src/sources/__lint__/bare-fetch.fixture.ts`,
   expect 1 error, ruleId `no-restricted-globals`, message includes
   "FetchLike".
2. `clean tree passes lint` — invoke ESLint on `src/sources` excluding
   the fixture; expect zero errors. (Locks the slice A3.1–A3.2 work
   in: any regression that re-introduces a bare `fetch` will fail
   this test.)

## Out of scope (this slice)

- Strict type-checked rules (`@typescript-eslint/strict-type-checked`).
  Future incremental config; not load-bearing for the safety property
  this slice ships.
- Auto-fix on save / pre-commit hook. Operators run `npm run lint`
  manually or via CI.

## Risks

- **devDep churn**: `typescript-eslint` pulls in ~10 transitive packages
  (~30 MB). Acceptable cost — ESLint becomes the home for any future
  custom rule (e.g. "no `process.env` outside config.ts").
- **Lint vs. test perf**: running ESLint inside a Vitest test adds ~1s.
  Keep `lintFiles` scope tight (only the fixture + its directory).
- **Pre-existing yammer client uses param-shadowed `fetch`**: at
  http-yammer-client.ts:26, `fetch(url, ...)` resolves to a function
  parameter. ESLint's `no-restricted-globals` is scope-aware and will
  NOT flag it. Verify in test 2.

## Definition of done

- 2 new tests green; existing suite stays green.
- `npm run lint` passes on the current tree.
- `/security-scan` clean.
- `/docs-update` run.
