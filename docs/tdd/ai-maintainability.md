# AI-Maintainability Rules — waldo.WTF

This codebase will be extended across many Claude sessions with no shared
memory. Code that Claude-next can't understand from a cold read is code that
will decay. These rules exist to keep the codebase legible to both humans and
future AI contributors.

These are non-negotiable during REVIEW. A "yes" to every rule, or go back.

---

## 1. Explicit over clever

- Prefer long, descriptive names to short clever ones. `deltaLink` not `dl`.
  `accountUsername` not `user`. `sentAtUnixMs` not `ts`.
- Prefer straight-line code to chained abstractions. A 20-line function with a
  clear name beats a 5-line function that calls four helpers that each call
  two more.
- Prefer explicit types on every public function signature. Never rely on
  inference at module boundaries.
- Never use non-null assertion `!` to silence the type checker. If the value
  really can't be null, narrow it with a check and throw with a message that
  explains why it was unreachable.

## 2. Every public function is a spec

Public = exported from a module. Every public function must have:

- An explicit parameter type and return type.
- A test whose name reads like a behavioral specification (see methodology §4).
- No side effects beyond those visible in the return type. If a function
  writes to the DB, the return type should say so (`Promise<InsertResult>`,
  not `Promise<void>`).

If a reader can't infer what the function does from its name, parameter
types, return type, and test names alone, rename or split it.

## 3. Seams are contracts, not implementation details

Every injected dependency (see [testability-patterns.md](testability-patterns.md))
is declared as an `interface` in its own file, with:

- A doc comment on every method explaining the contract (inputs, outputs, error
  modes, idempotency).
- A contract test suite that every implementation (real + fake) must pass.

This is how Claude-next knows what the fake is allowed to simplify and what
it isn't.

## 4. Errors carry context

- Never `throw new Error("failed")`. Include what failed, what it was trying to
  do, and what the relevant identifiers were:
  `throw new Error(\`delta sync failed for account=\${account} source=\${source}: \${cause.message}\`)`
- Prefer typed error classes at module boundaries (`TokenExpiredError`,
  `GraphRateLimitedError`, `DeltaTokenInvalidError`) so callers can discriminate.
- Every `catch` either handles the error meaningfully or rethrows. Never
  swallow, never log-and-continue unless the business rule is explicitly
  "log and continue to next account" (and then the test asserts on the log).

## 5. No magic values

- No unnamed numbers in logic. `5 * 60 * 1000` → `const POLL_INTERVAL_MS = 5 * 60 * 1000`.
- No unnamed strings as discriminators. `source === "teams"` is fine only if
  `Source` is a string literal union type. No free-form strings.
- Config values come from `src/config.ts`, never from inline `process.env` reads.

## 6. Files are small and single-topic

- A file's name predicts its contents. `delta-sync.ts` contains delta sync
  logic and nothing else.
- Hard cap: 300 lines per file. At 300, split. The split itself is a REFACTOR
  step under a green test suite.
- One exported "main" function per file is the ideal. Helpers for that function
  are private (non-exported) in the same file.

## 7. Comments explain *why*, never *what*

- Delete any comment that describes what the next line does. The code already
  says what; a comment repeating it just rots.
- Keep comments that describe *why* a non-obvious choice was made — especially
  workarounds for external quirks:
  ```ts
  // Graph's /delta endpoint ignores $orderby on initial sync, so we sort
  // client-side here. Confirmed via spike 2026-04-13.
  ```
- Keep TODO comments only if they reference an issue or a specific trigger
  ("TODO: when we add Teams, revisit this ordering"). Bare `TODO: fix` rots.

## 8. Deterministic by default

- No wall-clock reads in business logic. Always `deps.clock.now()`.
- No random reads in business logic. Always `deps.ids.next()` or a seeded RNG.
- No reliance on Map/Set insertion order for correctness. If order matters,
  sort explicitly.
- No reliance on filesystem ordering. Sort directory listings.

Non-determinism is the most expensive bug class because it's intermittent.
Engineer it out at the seam.

## 9. Logs are structured and queryable

- Every log line is `logger.info("event_name", { ...structured })`, never a
  formatted string.
- Events use `snake_case` names that read as past-tense facts:
  `"delta_sync_started"`, `"delta_sync_completed"`, `"graph_rate_limited"`,
  `"token_refresh_failed"`.
- Never log secrets: no tokens, no bearer strings, no raw Graph payloads that
  contain message bodies. Log IDs and counts.

## 10. Tests are documentation

- A new contributor (human or AI) should be able to understand what a module
  does by reading its test file alone.
- Every test has a single clear assertion focus. Multi-assert tests are OK if
  they assert on one cohesive outcome (e.g. "row was inserted AND log line was
  written AND counter was incremented" is one outcome: "sync completed").
- Tests never import from `../../../` chains deeper than 2. If they do, the
  module layout is wrong.

## 11. No dead code, no commented-out code

- Delete unused exports. Git remembers; the file shouldn't.
- Never check in commented-out code "in case we need it". If you need it, it's
  in the git history.
- Unused parameters prefixed with `_` are allowed only in interface
  implementations where the param exists for the contract.

## 12. Migrations and schema changes

- Every schema change is a numbered migration file (`001-initial.sql`,
  `002-add-raw-json.sql`, ...).
- Every migration has a test that: starts from the previous schema, runs the
  migration, asserts the new schema is correct, and asserts existing data
  survived.
- Never edit a committed migration file. Add a new one.

## 13. Read-only invariant is enforced by tests

A test in `src/mcp/__tests__/read-only.test.ts` asserts that **no registered
MCP tool has a handler that performs SQL INSERT/UPDATE/DELETE** (excluding the
sync worker and token cache paths, which are not MCP tools). This test runs in
CI and blocks merges if a write sneaks in.

---

## Review checklist (paste into PR description or commit message)

```
AI-maintainability review:
- [ ] All public functions have explicit types
- [ ] All seams are interfaces with contract tests
- [ ] No magic values, no free-form string discriminators
- [ ] No direct imports of side-effect modules in business logic
- [ ] No wall-clock or random reads outside the composition root
- [ ] All errors carry context identifiers
- [ ] All logs are structured events
- [ ] No dead code, no commented-out code, no orphan fixtures
- [ ] All tests pass, full suite
- [ ] Coverage ≥90% lines + branches on touched files
- [ ] Every acceptance criterion traces to a named test
```
