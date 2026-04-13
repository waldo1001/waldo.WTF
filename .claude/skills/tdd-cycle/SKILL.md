---
name: tdd-cycle
description: Run the waldo.WTF TDD cycle for a coding task. Use at the start of ANY code change (feature, bug fix, refactor) to produce the RED test list, confirm failing tests, scaffold testable seams, implement to GREEN, refactor, and verify ≥90% coverage + requirement traceability. Invoke proactively — never write production code without running this first.
---

# /tdd-cycle — waldo.WTF TDD enforcer

You are about to make a code change in the waldo.WTF workspace. This skill
forces you through the TDD cycle defined in
[docs/tdd/methodology.md](../../../docs/tdd/methodology.md). **Do not skip
steps. Do not merge steps.**

## Step 0 — Load the rules

Re-read these before you write anything:

1. [docs/tdd/methodology.md](../../../docs/tdd/methodology.md)
2. [docs/tdd/testability-patterns.md](../../../docs/tdd/testability-patterns.md)
3. [docs/tdd/ai-maintainability.md](../../../docs/tdd/ai-maintainability.md)
4. [docs/tdd/coverage-policy.md](../../../docs/tdd/coverage-policy.md)

If the task is a bug fix, also read §7 of methodology.md.
If the task is a refactor, also read §8 of methodology.md.

## Step 1 — Situate the step in the project (≤150 words)

Before anything else, post in chat a short framing that answers all four
questions. Hard cap: **150 words total**.

1. **Goal of this step** — what are we creating, in one sentence.
2. **Where it stands in the project** — which weekend from
   [../../../PROGRESS.md](../../../PROGRESS.md), which prior steps it
   builds on, what comes after it.
3. **Why it is needed** — what breaks or is missing without it.
4. **What it contributes** — which piece of the architecture in
   [../../../waldo.WTF-project-brief.md §3](../../../waldo.WTF-project-brief.md)
   this advances, or which MCP tool / seam / workflow it unlocks.

This framing is for the user's benefit — it keeps the session grounded
in the bigger picture and catches "wait, why are we doing this?"
moments before the RED list locks the work in.

Only after posting this framing, proceed.

## Step 2 — State the task in one sentence

Write in chat: "Task: <one sentence describing the intended behavior change>".
If you can't state it in one sentence, the task is too big — split it.

## Step 3 — Produce the RED list

Post in chat a bulleted list. For each acceptance criterion derived from the
task:

```
- AC<n>: <behavior in one sentence>
  - test file: src/<path>.test.ts
  - test name: "<reads like a spec line>"
  - seams touched: <graph | store | clock | fs | msal | logger | http | none>
  - edge cases: <empty | pagination | @removed | 429 | token-expired | unicode | ...>
```

Do not write any code — production or test — before this list is posted.

## Step 4 — Write the FIRST failing test

Pick the simplest RED from the list. Write *only that one test*.

Run only that test file. Observe the failure.

- If the failure is about plumbing (`Cannot find module`, `is not a
  function`), go to Step 5 to scaffold, then come back here.
- If the failure is about behavior (`expected X received Y`, `expected
  function to throw`), you have a true RED. Go to Step 6.

Post in chat: `RED confirmed: <failure message>`.

## Step 5 — Scaffold the seam

Minimum shape so the test can reach its assertion:
- files + module exports
- explicit type signatures
- stub implementation throwing `new Error("not implemented: <name>")`
- fakes for any untouched seams the test needs (use existing ones in
  `src/testing/` when possible, add new ones following
  [testability-patterns.md](../../../docs/tdd/testability-patterns.md))

The scaffold is testable code structure — not behavior. Go back to Step 4
and re-run.

## Step 6 — GREEN: simplest code that passes

Write the *minimum* implementation that turns this one test green. Not the
prettiest, not the most general. Resist writing the next test's
implementation "while you're here".

Run the touched test file. Confirm it's green.
Run the full suite. Confirm nothing else went red.

Post in chat: `GREEN: <test name>`.

## Step 7 — Next RED

Repeat Steps 4–6 for every item on the RED list. Each cycle is one test, one
GREEN. When the list is empty, go to Step 8.

## Step 8 — REFACTOR

With all tests green, clean up:
- rename for clarity
- extract helpers where duplication is *real* (not speculative)
- tighten types
- delete dead code, dead comments, orphan fixtures

After each meaningful change, run the full suite. If it goes red, revert.

## Step 9 — COVER

Run `npm test -- --coverage` (once the TS project exists; before Weekend 2,
this step reduces to "manual check the RED list is fully implemented").

- Lines ≥90% on touched files? If no, add tests for the uncovered lines or
  justify an exclusion in `vitest.config.ts` with a comment.
- Branches ≥90%? Same rule.
- Every AC on the list has at least one named test? Write the traceability
  mapping now.

## Step 10 — SECURITY SCAN

Run the `/security-scan` skill
([.claude/skills/security-scan/SKILL.md](../security-scan/SKILL.md)).

It enforces: no tracked secrets, no secrets in source / logs / error
messages / fixtures / snapshots, no real tenant or account identifiers
outside allowlisted docs, gitignore baseline intact, and (once the TS
project exists) no high/critical `npm audit` findings.

A finding **blocks** the cycle. Never "note and continue". On a real
secret hit, follow the rotation protocol in the skill before doing
anything else.

**Only on PASS** continue to Step 11.

## Step 11 — UPDATE DOCS

Run the `/docs-update` skill
([.claude/skills/docs-update/SKILL.md](../docs-update/SKILL.md)).

At minimum this appends a bullet to [docs/changelog.md](../../../docs/changelog.md).
User-visible changes also touch [setup.md](../../../docs/setup.md),
[getting-started.md](../../../docs/getting-started.md), and/or
[user-guide.md](../../../docs/user-guide.md).

Docs that are not updated at the moment of the change will never be
updated. This step is non-optional.

## Step 12 — REVIEW

Answer each question from [methodology.md §2.7](../../../docs/tdd/methodology.md)
and each box from [ai-maintainability.md §Review checklist](../../../docs/tdd/ai-maintainability.md).
"Yes" to every one, or go back.

## Step 13 — Report

Post a short summary in chat:

```
TDD cycle complete.
- Task: <one sentence>
- Tests added: <N>
- Files touched: <list>
- Coverage: <lines>% / <branches>%
- AC traceability:
  - AC1 <...> → <test file>: "<test name>"
  - AC2 <...> → <test file>: "<test name>"
- Notes: <any surprises, new seams added, fakes written>
```

---

**If at any step the test is hard to write, the code is wrong — not the test.
Stop, fix the seam, continue. Never skip a test "just this once".**
