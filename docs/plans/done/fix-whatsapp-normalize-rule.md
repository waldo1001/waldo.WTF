# Fix: correct WhatsApp chat-name normalization rule

## Task

Replace the overly-broad "strip any trailing ` (…)` suffix" rule in
`normalizeWhatsAppChatName` with a rule that (a) only strips a trailing
numeric counter like ` (2)`, and (b) when the name matches WhatsApp's
placeholder pattern `"General chat (<real group name>)"`, returns the
real group name from inside the parens. The existing uncommitted slice
2 rule does the opposite of what the data needs.

## Why this is a correction, not a new feature

WhatsApp semantics I got wrong in the original slice 2:

- `"General chat"` is not a real chat name — it's WhatsApp's
  **placeholder label** for an unnamed group. When the group DOES have
  a user-assigned name, WhatsApp exports to a filename of the form
  `WhatsApp Chat - General chat (<real name>).zip`. So the paren
  content is the canonical identity, not a disambiguator to discard.
- The parenthetical suffix on non-`General chat` names (e.g.
  `"BC Dev Talk (2)"`) is a macOS-style re-download counter. THAT one
  should be stripped.

Consequence of the current (wrong) rule:

- `"General chat"` and `"General chat (BC Dev Talk)"` merge — they're
  **different chats**.
- `"BC Dev Talk"` and `"General chat (BC Dev Talk)"` stay apart —
  they're **the same chat**.

Exactly the opposite of what the migration was supposed to achieve.

Nothing from slices 1–3 is committed or deployed yet (verified via
`git status`), so no production data has been corrupted. This slice
fixes the rule before anything ships.

## Scope boundary

**IN:**

- New `normalizeWhatsAppChatName` algorithm (see below).
- Updated unit tests for `normalizeWhatsAppChatName`, `hashWhatsAppId`
  (normalization coverage), and `toWhatsAppMessage` (threadId/threadName
  split).
- Updated fixtures in `src/store/rethread-whatsapp.test.ts` so the
  merge-scenario tests use a *real* bifurcation pattern (e.g. whitespace
  variants, or `"BC Dev Talk"` ↔ `"BC Dev Talk (2)"`) instead of the
  now-wrong `"General chat"` ↔ `"General chat (BC Dev Talk)"` fixture.
- Updated examples/prose in `docs/migrations/whatsapp-rethread.md` —
  the illustrative bifurcation example in the runbook is wrong under
  the corrected rule and must be replaced.
- Updated `docs/plans/done/fix-whatsapp-thread-bifurcation.md` Slice 2
  description (corrective note at the top — the plan is already
  archived, but its description contradicts the new rule).
- Changelog entry for today noting the correction.

**OUT:**

- The `list_threads` tool (slice 1) — already correct, unchanged.
- The migration engine in `rethread-whatsapp.ts` — its algorithm is
  fine; only the normalization function it calls was wrong. Source
  file needs no edits; only its test fixtures.
- Multi-locale placeholder handling (e.g. Dutch/French WhatsApp might
  emit a different placeholder than `"General chat"`). Defer — the
  user exports in English. Note in out-of-scope follow-ups.
- Anything about WhatsApp locale detection.

## Files to create / touch

- `src/sync/whatsapp-map.ts` — rewrite `normalizeWhatsAppChatName`.
- `src/sync/whatsapp-map.test.ts` — flip expected values on existing
  tests that encoded the wrong rule; add tests for the new rule.
- `src/store/rethread-whatsapp.test.ts` — replace fixtures that used
  `"General chat (BC Dev Talk)"` as a bifurcation example. Use a
  counter-suffix pattern (`"BC Dev Talk"` ↔ `"BC Dev Talk (2)"`) and
  a whitespace variant pattern to cover both legs of the rule.
- `docs/migrations/whatsapp-rethread.md` — replace the "General chat
  (BC Dev Talk)" example prose with a counter-suffix example.
- `docs/plans/done/fix-whatsapp-thread-bifurcation.md` — prepend a
  "Correction (2026-04-21)" note clarifying the Slice 2 rule.
- `docs/changelog.md` — one bullet under today.

## Seams involved

`none` — pure function + test fixtures + docs. No I/O, no clock, no
store. All existing seams (sqlite, fs, clock) are untouched.

## RED test list

### AC1 — strips trailing numeric counter

```
- test file: src/sync/whatsapp-map.test.ts
- test name: "strips a trailing numeric counter suffix"
  normalize("BC Dev Talk (2)") → "BC Dev Talk"
- edge cases:
  - multiple counters: "BC Dev Talk (2) (3)" → "BC Dev Talk"
  - leading whitespace + counter: "  BC Dev Talk (2)  " → "BC Dev Talk"
```

### AC2 — preserves non-numeric parenthetical on non-placeholder names

```
- test file: src/sync/whatsapp-map.test.ts
- test name: "preserves a non-numeric parenthetical suffix on a normal name"
  normalize("BC Dev Talk (Belgium)") → "BC Dev Talk (Belgium)"
```

### AC3 — unwraps placeholder-prefix group name

```
- test file: src/sync/whatsapp-map.test.ts
- test name: "unwraps 'General chat (<name>)' to the inner group name"
  normalize("General chat (BC Dev Talk)") → "BC Dev Talk"
- edge cases:
  - counter after placeholder: "General chat (BC Dev Talk) (2)" → "BC Dev Talk"
  - whitespace inside parens is collapsed: "General chat (  BC  Dev  Talk  )" → "BC Dev Talk"
```

### AC4 — bare placeholder remains

```
- test file: src/sync/whatsapp-map.test.ts
- test name: "leaves bare 'General chat' (unnamed group) unchanged"
  normalize("General chat") → "General chat"
  normalize("General chat (2)") → "General chat"  // counter stripped, placeholder stays
```

### AC5 — whole-parenthetical name untouched

```
- test file: src/sync/whatsapp-map.test.ts
- test name: "leaves a whole-parenthetical name untouched" (existing test,
  verify still holds)
  normalize("(Family)") → "(Family)"
```

### AC6 — idempotent, case-preserving, empty-safe

```
- test file: src/sync/whatsapp-map.test.ts
- existing tests for idempotence / case / empty input must still pass.
```

### AC7 — `hashWhatsAppId` normalizes input

```
- test file: src/sync/whatsapp-map.test.ts
- test name: "hashWhatsAppId hashes on the normalized chat name"
  Flip the existing test's expectation: now
    "BC Dev Talk" and "BC Dev Talk (2)" hash to the same id
  (the previous test used "General chat" / "General chat (BC Dev Talk)"
  which under the corrected rule must hash DIFFERENTLY).
- add: "General chat (BC Dev Talk)" and "BC Dev Talk" hash to the same id.
- add: "General chat" and "General chat (BC Dev Talk)" hash DIFFERENTLY.
```

### AC8 — `toWhatsAppMessage` threadId/threadName split

```
- test file: src/sync/whatsapp-map.test.ts
- test name: "re-imports of the same logical chat converge on id and threadId"
  Input A: chat "BC Dev Talk"            → threadId "BC Dev Talk"
  Input B: chat "BC Dev Talk (2)"        → threadId "BC Dev Talk"
  Input C: chat "General chat (BC Dev Talk)" → threadId "BC Dev Talk"
  All three ids equal. threadName preserves the raw chat.
```

### AC9 — rethread migration tests use a real bifurcation fixture

```
- test file: src/store/rethread-whatsapp.test.ts
- Any fixture currently using "General chat" / "General chat (BC Dev Talk)"
  as a bifurcation pair must be rewritten. Canonical replacement:
    raw A: thread_id = "BC Dev Talk",      thread_name = "BC Dev Talk"
    raw B: thread_id = "BC Dev Talk (2)",  thread_name = "BC Dev Talk (2)"
  Merges to thread_id = "BC Dev Talk", thread_name = canonical (latest import wins).
- Coverage for the placeholder-prefix case:
    raw C: thread_id = "General chat (BC Dev Talk)" merges in alongside.
- All existing merge / collision / idempotence / dry-run tests must
  still green after the fixture swap.
```

## Algorithm (pseudocode for the Green phase)

```
normalizeWhatsAppChatName(raw):
  s = raw.trim()
  s = s.replace(/\s+/g, " ")
  // Peel off any number of trailing numeric counters like " (2)"
  while s matches /^(.+?)\s*\((\d+)\)$/:
    s = $1.trimEnd()
  // Unwrap WhatsApp placeholder prefix
  if s matches /^General chat\s*\((.+)\)$/:
    inner = $1.trim().replace(/\s+/g, " ")
    if inner is non-empty and not purely numeric:
      s = inner
  return s
```

Two passes: counters first (so `"General chat (BC Dev Talk) (2)"`
becomes `"General chat (BC Dev Talk)"` then `"BC Dev Talk"`).

## Open questions / assumptions

- **A1 (assumption)**: WhatsApp's placeholder string for unnamed groups
  is exactly `"General chat"` in English exports and the user only
  exports in English. If Dutch/French exports ever land in the lake,
  they'll bucket under their own placeholder — not wrong, just not
  merged with the English ones. Out-of-scope follow-up.
- **A2 (assumption)**: `(N)` with N purely numeric is always a
  re-export counter, never a real chat name. Seems safe — no one names
  a WhatsApp group `"Chat (3)"`.
- **A3 (assumption)**: nested parens inside a real group name don't
  occur in practice, e.g. `"Friends (Amsterdam (2024))"`. The rule
  above doesn't handle that gracefully — the outer paren would match
  the placeholder regex if prefixed by `"General chat"`, otherwise
  stay untouched. Acceptable.

## Risks

- **R1**: an existing slice-2 test is currently encoding the wrong
  rule and will need its expectation flipped, not just a new test
  added. Risk of forgetting one. Mitigation: grep
  `"General chat (BC Dev Talk)"` repo-wide after the fix to catch all
  stale references.
- **R2**: the rethread migration test file uses the wrong fixture
  pattern as its canonical merge case. If the fixture swap is done
  carelessly, we could lose test coverage on the merge path. Mitigation:
  keep the same number of merge / collision / dry-run tests, just
  change the string fixtures — don't delete scenarios.
- **R3**: real WhatsApp exports might emit something slightly
  different from `"General chat (<name>)"` — e.g.
  `"General Chat (<name>)"` (capital C) or a locale variant. If so,
  the rule misses. Mitigation: case-sensitive match for now; if the
  user surfaces a counterexample, relax to case-insensitive with a
  follow-up test.

## Out-of-scope follow-ups

- Locale-aware placeholder detection (Dutch, French, etc.).
- Generalized "strip re-export counter on any paren-wrapped content"
  if we observe `(Family) (2)` in the wild.
- Automated backfill of `threadName` capitalization from the
  canonical-group-name source of truth (Graph has nothing for this;
  would require operator input).
