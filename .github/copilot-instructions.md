# GitHub Copilot instructions — waldo.WTF

GitHub Copilot (Chat, inline suggestions, Copilot Coding Agent, Copilot for
PRs) must follow the **same TDD toolchain** as every other AI contributor in
this repo. Do not reinvent it. Do not suggest code that bypasses it.

**The toolchain is defined in these files — read them before suggesting
anything non-trivial:**

- [../CLAUDE.md](../CLAUDE.md) — the prime directive. The cycle is:
  `FRAME → RED → PROVE RED → SCAFFOLD → GREEN → REFACTOR → COVER → SECURITY SCAN → UPDATE DOCS → REVIEW`.
- [../docs/tdd/methodology.md](../docs/tdd/methodology.md) — full workflow,
  the RED list convention, definition-of-done, and self-review checklist.
- [../docs/tdd/testability-patterns.md](../docs/tdd/testability-patterns.md)
  — composition root + Deps pattern; every seam (Graph, MSAL, SQLite,
  Clock, FS, Logger, HTTP, IdSource) is injected as an interface.
- [../docs/tdd/ai-maintainability.md](../docs/tdd/ai-maintainability.md) —
  code rules (explicit types, no magic values, structured logs, no dead
  code, deterministic-by-default, etc.).
- [../docs/tdd/coverage-policy.md](../docs/tdd/coverage-policy.md) — ≥90%
  per-file lines/branches/functions/statements on touched files.
- [../.claude/skills/tdd-cycle/SKILL.md](../.claude/skills/tdd-cycle/SKILL.md)
  — the stepwise runbook. Copilot sessions follow the same steps.
- [../.claude/skills/security-scan/SKILL.md](../.claude/skills/security-scan/SKILL.md)
  — gates the cycle before docs; blocks on any leak.
- [../.claude/skills/docs-update/SKILL.md](../.claude/skills/docs-update/SKILL.md)
  — gates the cycle before review; updates changelog + user-visible docs.
- [../testing/README.md](../testing/README.md) — drop-in Vitest config, dev
  deps, and example fakes for every seam.

If any of the above conflicts with a Copilot default suggestion, the
toolchain wins.

---

## Rules for Copilot suggestions

1. **Tests before code.** Never suggest an implementation for a function
   that does not yet have a failing test. If the user asks for code
   without a test, reply with a RED test first and explain why.
2. **Inject all seams.** Never suggest `import` of `node:fs`, `fetch`,
   `Date.now()`, `Math.random()`, `better-sqlite3`, or `@azure/msal-node`
   outside the single file that owns that seam
   (see [testability-patterns.md §5](../docs/tdd/testability-patterns.md)).
   Suggest an injected interface instead.
3. **Structured logs only.** Never suggest `console.log` in `src/`. Use
   `logger.info("snake_case_event_name", { ...primitives })`. Never log
   tokens, bearer strings, request bodies, or raw Graph payloads.
4. **No magic values.** Named constants or literal-union types, never
   free-form strings as discriminators.
5. **Explicit types on public functions.** Never rely on inference at
   module boundaries.
6. **No secrets, ever.** Do not suggest hardcoded client IDs, tenant
   IDs, bearer tokens, client secrets, real email addresses, real
   tenant domains (`dynex.be`, `ifacto.be`, etc.) in fixtures,
   snapshots, tests, or comments. Use `example.invalid`,
   `Alice`/`Bob`, placeholder GUIDs. Real identifiers are only allowed
   in the allowlisted docs named in
   [security-scan SKILL.md §3](../.claude/skills/security-scan/SKILL.md).
7. **Read-only invariant.** Never suggest an MCP tool handler that does
   SQL `INSERT`/`UPDATE`/`DELETE`. Writes are allowed only in the sync
   worker and token-cache paths. A meta-test enforces this.
8. **Coverage ≥90% per file.** If a suggestion lands an uncovered
   branch, also suggest the test that covers it.
9. **Changelog entry.** After a non-trivial change, suggest the
   one-line bullet for [../docs/changelog.md](../docs/changelog.md)
   under today's date, and flag any
   [README.md](../README.md) / setup / getting-started / user-guide
   sections that need updating.
10. **Security scan before commit.** Before suggesting a commit or
    push, remind the user to run the `/security-scan` checks from
    [security-scan SKILL.md](../.claude/skills/security-scan/SKILL.md).

## Copilot Chat prompt shortcut

When starting a new Copilot Chat on a coding task, paste this opener:

> Follow the waldo.WTF TDD toolchain defined in
> `.github/copilot-instructions.md` and the files it links to. Start
> with the FRAME step (≤150 words: goal, project position, why, what
> it contributes), then the RED list, then one failing test at a time.
> Never suggest code that bypasses the seams, the coverage policy, or
> the security scan.

## Copilot Coding Agent / Copilot for PRs

When Copilot acts autonomously (Coding Agent, auto-PR), it must:

- open with the FRAME in the PR description
- list the RED tests it added and confirm each was observed failing
  before the implementation
- include the AC-to-test traceability table
  ([methodology.md §2.6](../docs/tdd/methodology.md))
- confirm the `/security-scan` steps pass
- include the changelog diff and any README / user-guide edits

A PR without these is not reviewable and should be closed or sent
back.

---

**Bottom line**: Copilot is welcome here, but it plays by the same
rules as every other contributor. The toolchain lives in the files
linked above; this file is only the pointer.
