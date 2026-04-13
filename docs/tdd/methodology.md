# TDD Methodology — waldo.WTF

This is the workflow. Every code change follows it. No exceptions for "trivial"
changes — trivial changes are exactly where skipped tests accumulate into
untested surface area.

---

## 1. Why TDD here specifically

waldo.WTF is a personal tool that silently reads mail and chats from four
production Microsoft tenants. A regression isn't "a failing button" — it's
"missed a message from a customer" or "token cache corrupted and all four
accounts logged out at once". The cost of a bug is asymmetric: data loss,
silent staleness, or a compliance-spicy incident. Tests are cheaper than the
first time one of those bites.

Secondary reason: this codebase will be maintained partly by Claude across
sessions with no shared memory. Tests are the contract Claude-next reads to
understand what Claude-now intended. If a behavior isn't in a test, it
effectively does not exist.

---

## 2. The cycle

```
FRAME → RED list → PROVE RED → SCAFFOLD → GREEN → REFACTOR → COVER → SECURITY SCAN → UPDATE DOCS → REVIEW
```

### 2.0 FRAME — situate the step in the project (≤150 words)

Before the RED list, before any code, post a short framing in chat that
answers all four questions. **Hard cap: 150 words total.** No more.

1. **Goal of this step** — what we are creating, one sentence.
2. **Where it stands in the project** — which weekend from
   [../../PROGRESS.md](../../PROGRESS.md), which prior steps it builds
   on, what comes after.
3. **Why it is needed** — what breaks or is missing without it.
4. **What it contributes** — which piece of the architecture in
   [../../waldo.WTF-project-brief.md §3](../../waldo.WTF-project-brief.md)
   it advances, or which MCP tool / seam / workflow it unlocks.

The framing exists to keep both the user and Claude grounded in the
bigger picture, and to catch "wait, why are we doing this?" moments
before the RED list locks the work in. It is not optional — the
`/tdd-cycle` skill gates on it.

### 2.1 RED list — enumerate tests before touching code

Before *any* production code or even test code, write the RED list in chat or
in the task description. For each requirement derived from the task:

- name the behavior in one sentence
- name the test file it will live in
- name the seams it touches (Graph? SQLite? clock? fs?)
- call out edge cases explicitly (empty input, pagination boundary, `@removed`,
  token-expired, network 429, SQLite busy, clock-skew, unicode in message body)

The list is the contract. If a requirement isn't on the list, it won't get
tested, and if it doesn't get tested it doesn't get built.

### 2.2 PROVE RED — make the failure meaningful

After writing the first failing test:

1. Run *only that test file* — never start by running the whole suite.
2. Read the failure message. It must be about the behavior under test
   (`expected 3 received undefined`), not plumbing (`Cannot find module`,
   `is not a function`, `ReferenceError`).
3. If the failure is plumbing, go to **SCAFFOLD** and come back.
4. If the failure is meaningful, you have a true RED. Only now may you write
   implementation.

A test that has *never* been observed to fail for the right reason is not a
test. It's a placeholder that will silently pass on a bug some day.

### 2.3 SCAFFOLD — make the code testable before making it work

Minimum shape so the test reaches the assertion:

- files, module exports, type signatures, DI parameters
- a stub implementation that throws `new Error("not implemented: <name>")` or
  returns a typed zero value
- fakes/mocks for the seams the test touches (see
  [testability-patterns.md](testability-patterns.md))

Scaffold is not implementation. Scaffold is "the shape of the implementation".
The test should now fail with an assertion error, not a structural error.

**Rule of thumb**: if scaffolding feels hard, the design is wrong. A unit that's
hard to stand up in a test is hard to reason about in production. Stop and
redesign the seams before continuing.

### 2.4 GREEN — minimum code to pass

Write the *simplest* implementation that makes the test pass. Not the
prettiest, not the most general. Resist the urge to implement the next test
case "while you're here" — that's how you end up with untested code that
accidentally works.

If the simplest implementation is `return 3`, that's fine. The next RED test
will force you to generalize. This is the triangulation pattern and it is
correct even when it feels stupid.

### 2.5 REFACTOR — clean up under the safety net

Only with all tests green:

- rename for clarity
- extract helpers where duplication is real (not speculative)
- tighten types
- delete dead code and dead comments
- run the full suite after each meaningful change; revert if it goes red

Refactoring is the step where the safety net *pays for itself*. Use it.

### 2.6 COVER — enforce 90% + requirement traceability

See [coverage-policy.md](coverage-policy.md) for the policy.

Two checks, both required:

1. **Mechanical**: Vitest coverage reports ≥90% lines *and* ≥90% branches on
   every file you touched. Below threshold = keep writing tests.
2. **Semantic**: every acceptance criterion on the task maps to at least one
   named test. Write the mapping as a bullet list in the PR / commit message:

   ```
   - AC1 "delta sync ignores @removed duplicates" → sync/delta.test.ts: "skips @removed records already absent from the lake"
   - AC2 "second run produces 0 new rows" → sync/delta.test.ts: "second run against same fixture inserts zero rows"
   ```

   Mechanical coverage without semantic coverage is how you end up 95%-covered
   on the wrong thing.

### 2.65 SECURITY SCAN — no leak, no exception

Before docs, before review, run the `/security-scan` skill
([.claude/skills/security-scan/SKILL.md](../../.claude/skills/security-scan/SKILL.md)).

It scans for: tracked sensitive files, secrets in source, real
tenant/account identifiers outside allowlisted docs, secrets in logs,
secrets in error messages, secrets in fixtures/snapshots, and (when
applicable) high/critical `npm audit` findings.

A finding **blocks** the cycle. Never "note and continue". If a real
secret is found, stop, rotate the credential, scrub history, add a
regression guard, and log the incident in the changelog. See the skill
for the full rotation protocol.

### 2.7 UPDATE DOCS — the changelog is not optional

Before REVIEW, run the `/docs-update` skill
([.claude/skills/docs-update/SKILL.md](../../.claude/skills/docs-update/SKILL.md)).
Every task — feature, bug fix, refactor — updates at least
[docs/changelog.md](../changelog.md). User-visible changes also update
[setup.md](../setup.md), [getting-started.md](../getting-started.md),
and/or [user-guide.md](../user-guide.md) as the skill determines.

Documentation that is not updated at the moment of the change is never
updated. A task is not complete until the docs reflect reality.

### 2.8 REVIEW — the self-review checklist

Before marking a task done, answer all of these out loud (in chat or commit
message). "Yes" to every one, or go back:

- [ ] Did I post the FRAME (≤150 words, all four questions) before anything
      else in this cycle?
- [ ] Did I run `/security-scan` with a PASS result?
- [ ] Did I run `/docs-update` and update the changelog (plus any user-visible
      sections) as the last step before this review?
- [ ] Did I write the RED list before production code?
- [ ] Did I observe every new test fail with a *meaningful* error before making
      it green?
- [ ] Is every seam (Graph, SQLite, MSAL cache, clock, fs) injected rather
      than imported, so the unit under test is isolatable?
- [ ] Are all new public functions documented by a test name that reads like
      a spec line?
- [ ] Is coverage ≥90% lines + branches on touched files?
- [ ] Does every acceptance criterion trace to a named test?
- [ ] Did I run the *full* suite, not just the touched file, to catch
      cross-module regressions?
- [ ] Are there any `.only`, `.skip`, `xit`, or commented-out tests? (None
      allowed on main.)
- [ ] Do the tests follow the [AI-maintainability rules](ai-maintainability.md)
      so future Claude can read and extend them?
- [ ] Are there any secrets, real tokens, real account emails, or real message
      bodies in fixtures or snapshots? (None allowed.)

---

## 3. What is a unit, what is an integration test

- **Unit test** — one module, all seams faked. Fast (<10ms). Lives beside the
  source file as `<name>.test.ts`. This is where the 90% coverage comes from.
- **Integration test** — multiple real modules wired together with a real
  in-memory SQLite and fake external services. Lives in `src/**/__integration__/`.
  Slower but still no network. Used to catch wiring bugs that unit tests miss
  (e.g. "sync worker writes to DB but MCP tool can't read it because of
  transaction isolation").
- **Contract test** — runs a fake Graph server against the same assertions as
  the real Graph client would, so the fake can't drift. Lives in
  `src/sources/__contract__/`.
- **Smoke test** (manual, not automated) — once per weekend milestone, run the
  real thing against one real account and eyeball the rows. Not part of CI.

Unit tests are mandatory. Integration and contract tests are added at the
moment they would have caught a real bug.

---

## 4. Test naming

Test names are specs. They read left-to-right as English.

```ts
describe("deltaSync", () => {
  it("on first run, performs a full fetch and stores a deltaLink", ...);
  it("on second run, uses the stored deltaLink and inserts zero rows when nothing changed", ...);
  it("on @removed entries, deletes matching rows from the lake", ...);
  it("on HTTP 429, surfaces the error to sync_log and leaves the deltaLink unchanged", ...);
});
```

Bad names: `"works"`, `"test1"`, `"handles errors"`. These tell future-Claude
nothing and will be deleted or rewritten on the next pass.

---

## 5. Fixtures

- Fixtures live in `src/**/__fixtures__/`.
- Fixtures are *synthetic*. Never a real Graph payload from a real inbox —
  anonymize aggressively. Real-looking names, zero real data.
- A fixture is committed only if a test references it. Orphan fixtures are
  deleted in REFACTOR.
- Fixtures are plain JSON or TypeScript factory functions. Factories preferred
  when tests need parameterization:

  ```ts
  export const makeGraphMessage = (overrides: Partial<GraphMessage> = {}): GraphMessage => ({
    id: "AAMkADk...",
    receivedDateTime: "2026-04-13T10:00:00Z",
    subject: "test subject",
    from: { emailAddress: { name: "Test", address: "test@example.invalid" } },
    body: { contentType: "text", content: "test body" },
    ...overrides,
  });
  ```

---

## 6. Speed budget

- Unit suite: must run in <5s total on waldo's Mac. Slower = broken; find the
  slow test and fix it (usually a missing fake).
- Integration suite: must run in <30s total.
- Every test must be independently runnable in any order. No shared mutable
  state, no test depending on the previous test's side effects.

---

## 7. Bug fixes

A bug fix is a TDD cycle like any other, but with a specific RED:

1. Write a test that *reproduces the bug*. It must fail on the current code.
2. Confirm it fails for the right reason (the bug itself, not a typo).
3. Fix the code. The new test goes green. No other tests go red.
4. Leave the test in place forever. It is now the regression guard.

A bug fix without a regression test is not a fix — it's a retry waiting to
happen.

---

## 8. Refactors

Refactors must not change behavior, therefore must not need new tests. If a
refactor needs a new test, it's not a refactor — it's a feature change in
disguise, and it needs its own RED list.

The rule: before refactoring, run the full suite and confirm it's green. After
refactoring, run the full suite and confirm it's *still* green. If coverage on
touched files drops, the refactor exposed untested code that was previously
hidden — add tests for it before merging.

---

## 9. When TDD slows you down

It will, occasionally. Almost always the cause is one of:

- **The seam is wrong.** You're trying to test something that has hardcoded
  dependencies. Fix the seam, the test becomes easy. See
  [testability-patterns.md](testability-patterns.md).
- **The unit is too big.** You're testing three behaviors at once. Split the
  unit, split the tests.
- **You're testing the mock, not the behavior.** If a test only asserts "the
  mock was called with X", delete it — it's testing the implementation, not
  the outcome. Assert on the observable effect instead (row in DB, return
  value, log line).

The answer is never "skip the test this time". The answer is "fix the thing
that made the test hard".

---

*This methodology is enforced by the repo-local `/tdd-cycle` skill. Run it at
the start of any coding task.*
