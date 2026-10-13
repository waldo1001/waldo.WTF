# Dependency upgrade — adm-zip 0.5→0.6 and vitest 2→4

Status: **DONE 2026-10-13** (branch `deps/vitest4-admzip06`). Scope grew by decision: vitest 4 coverage exposed 17 untested branches; covered with tests (user chose this over lowering the gate).

## Task
Clear the 3 critical + 2 high `npm audit` findings deferred from the
security-hardening branch: adm-zip (runtime) → 0.6.1, vitest +
@vitest/coverage-v8 (dev) → 4.1.11. Two separate commits.

## Scope
- IN, commit 1: adm-zip 0.6.1. Drop `@types/adm-zip` (0.6 ships its own types).
  Every adm-zip failure in `extractChatTextFromZip` (open, `getEntry`,
  `getData`) surfaces as `WhatsAppParseError` and the file is not archived.
- IN, commit 2: vitest + @vitest/coverage-v8 4.1.11, with whatever config or test
  API changes v4 requires. Coverage thresholds stay enforced, and Stryker 9.6.1
  (vitest-runner peer `vitest >=2`) still runs.
- OUT: vitest 5, Stryker 10, and the other moderate audit findings.

## Files
`package.json`, `package-lock.json`, `src/sync/import-whatsapp.ts`,
`src/sync/import-whatsapp.test.ts`, `vitest.config.ts` (only if v4 requires it),
any test using a removed vitest API, `docs/changelog.md`.

## Seams
fs (InMemoryFileSystem) only.

## RED tests
1. A zip with two `_chat.txt` entries (crafted by renaming a second entry in
   both the local and the central header) → `WhatsAppParseError`, not archived.
   adm-zip 0.5 silently picks one, so a crafted export could smuggle in content.
2. A zip whose `_chat.txt` declares a compressed size past the end of the
   buffer → `WhatsAppParseError`, not a raw RangeError or garbage text.
3. Under vitest 4: the full suite is green; `npm test -- --coverage` passes
   thresholds; a Stryker run on `src/sync/import-whatsapp.ts` completes.

## Assumptions
- Target vitest 4.1.11 (the audit fix version), not the newer 5.x. The task
  said "2→4".
- The adm-zip API we use (`new AdmZip(buffer)`, `getEntry`, `getData`) is
  unchanged in 0.6 per the release notes.

## Risks
- vitest 4 config or API breaks (coverage options, `vi` typings, pool
  defaults). Mitigation: a separate commit, revertible on its own.
- The pre-existing Stryker/better-sqlite3 SIGSEGV may change under vitest 4's
  pool. Run per-file, as in S4.
- Runtime: WhatsApp exports from the laptop push agent. Smoke-test a real
  export shape (the existing fixtures) before deploy.

## Out of scope / follow-ups
- vitest 5 / Stryker 10 major bumps.
- Remaining moderate audit findings.
