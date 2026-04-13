# Coverage Policy — waldo.WTF

## Thresholds (enforced by Vitest config)

- **Lines**: ≥90%
- **Branches**: ≥90%
- **Functions**: ≥90%
- **Statements**: ≥90%

Scope: every file under `src/` except the exclusions below. Enforced per-file,
not just global — a global average hides untested hot-spots.

## Exclusions (allowed to drop below 90%)

These files are allowed zero coverage because they are either composition
roots (only wire things together) or pure config:

- `src/index.ts` — top-level wire-up. Integration-tested via smoke run.
- `src/config.ts` — env var parsing. Integration-tested.
- `src/**/*.d.ts` — type definitions.
- `src/testing/**` — test doubles themselves (but their **contract tests**
  cover them indirectly).
- `src/**/__fixtures__/**` — static data.

Any new exclusion requires a comment in `vitest.config.ts` explaining why.

## What "90%" actually enforces

Mechanical coverage is necessary but not sufficient. See
[methodology.md §2.6](methodology.md). The PR/commit message MUST also include
a semantic mapping:

```
Acceptance criteria traceability:
- AC1 "..." → path/to/file.test.ts: "test name"
- AC2 "..." → path/to/file.test.ts: "test name"
```

A file at 100% line coverage whose tests don't assert on behavior is still a
REVIEW failure.

## What coverage does NOT replace

- **Mutation testing** (Stryker) is the next-level check: for each line, flip
  an operator or remove a branch and see if any test fails. If no test fails,
  the line was "covered" but not actually *tested*. Target: add Stryker at
  Weekend 3 once the unit suite exists. Minimum surviving-mutant rate: <20%.
- **Manual smoke tests** against a real account. Automated coverage cannot
  catch "the token cache schema changed in a new MSAL version". Smoke-test
  once per weekend milestone.

## Enforcement

- `npm test` runs the unit suite with coverage and fails if thresholds are not
  met.
- Pre-commit hook (set up at Weekend 2): runs `npm test` on changed files.
- CI (set up at Weekend 5 with Dockerization): runs full suite + coverage.
- A failing coverage gate is never bypassed with `--coverage.thresholds=...`
  overrides. Fix the tests instead.

## When a test drops coverage

If a refactor reveals that an existing line was only "covered" by a test that
no longer hits it, that's a signal:

1. The test was covering implementation, not behavior. Good riddance.
2. The line is genuinely untested now. Add a behavior-focused test.

Either way, never delete the line just to boost the number. Understand *why*
it's uncovered first.
