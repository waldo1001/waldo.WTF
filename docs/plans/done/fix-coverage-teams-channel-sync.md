# Plan: Restore 90% coverage thresholds on Teams-channel sync files

## Task

Add focused tests so `src/sources/http-teams-client.ts` (functions ≥90%)
and `src/sync/sync-teams-channels.ts` (branches ≥90%) cross the policy
thresholds defined in [docs/tdd/coverage-policy.md](../tdd/coverage-policy.md),
without weakening behavior or lowering thresholds.

## Scope boundary

**IN**

- New tests in [src/sources/http-teams-client.test.ts](../../src/sources/http-teams-client.test.ts)
  covering the default `sleep` arrow (line 39 of the source) so the
  function-coverage metric crosses 90%.
- New tests in [src/sync/sync-teams-channels.test.ts](../../src/sync/sync-teams-channels.test.ts)
  covering uncovered branches:
  - `truncateThreadName` — `length > max` truncation path.
  - `stripHtml` — entire function (only ever invoked from html bodies).
  - `snippetFromBody` — `body === undefined` early return, html branch,
    `length > 40` truncation.
  - `mentionToString` — displayName-without-UPN path; mentionText-only
    path; the all-empty fall-through to `return undefined`.
  - `buildThreadName` — both team and channel undefined + empty snippet
    → returns `undefined`.
  - `flattenPage` — reply with `messageType !== "message"` skipped.
  - `channelMessageToMessage` — html body produces `bodyHtml`.

**OUT**

- The two `err instanceof Error ? ... : new Error(String(err))` defensive
  branches (lines 314, 364) — only reachable if a fake throws a
  non-Error, which our existing fakes do not. Adding a test would
  require an ad-hoc client that throws strings — not worth the
  surface area, since the branch is guarded defensive code that
  cannot fire in practice. Left uncovered; branches still cross
  90% without these.
- Any change to production behavior. This slice is test-only.
- Coverage thresholds in `vitest.config.ts` — policy is hard 90%.

## Files to create / touch

- Edit `src/sources/http-teams-client.test.ts` — add ≥1 test.
- Edit `src/sync/sync-teams-channels.test.ts` — add ~7 tests.
- No production source edits.

## Seams involved

- `http` (FetchLike), `clock` (FakeClock), `store` (InMemoryMessageStore),
  fake auth + fake teams-channel client. All existing seams; no new
  fakes needed.

## RED test list

### `src/sources/http-teams-client.test.ts`

- AC1: when constructed without an injected `sleep`, retry uses real
  `setTimeout` (proves the default arrow is reachable).
  - file: `src/sources/http-teams-client.test.ts`
  - test: `"default sleep arrow waits via real setTimeout when not injected"`
  - seams: http, fake timers
  - edges: 502 → 200 with `vi.useFakeTimers` driving the wait

### `src/sync/sync-teams-channels.test.ts`

- AC2: html body content is stored as `bodyHtml`, and the snippet is
  derived from the stripped text.
  - test: `"html body produces bodyHtml and stripped-text thread name"`
  - seams: store, fake teams-channel client
  - edges: `body.contentType === "html"`

- AC3: snippet is truncated to 40 chars when body content is longer.
  - test: `"rootSnippet is truncated to 40 chars for long bodies"`

- AC4: when subscription has no team/channel names AND root has no
  body, `threadName` is omitted.
  - test: `"threadName is undefined when sub names are absent and body is empty"`

- AC5: replies with `messageType !== "message"` are skipped.
  - test: `"skips system-event replies (messageType !== 'message')"`

- AC6: `mentionToString` falls back to `displayName` when UPN is
  missing, and to `mentionText` when no user is given; mentions with
  no resolvable identity are dropped.
  - test: `"mentions: prefer displayName when UPN missing; drop mentions with no identity"`

- AC7: thread name composed of team + channel + snippet is truncated
  to 200 chars.
  - test: `"thread name is truncated to 200 chars"`

## Open questions / assumptions

- **Assumption**: the two defensive `err instanceof Error` branches are
  acceptable as residual uncovered branches because they cannot fire
  with the existing fakes. Branch coverage will exceed 90% even
  without them (current 85.41% gap is 5+ branches; we add ~10).
- **Assumption**: introducing fake-timer-based waits in the http-teams
  test is fine; the suite already uses `vi.useFakeTimers()` for the
  fetch-with-timeout test.

## Risks

- A test that exercises real `setTimeout` could become flaky under
  load. Mitigation: use `vi.useFakeTimers()` and `advanceTimersByTimeAsync`,
  matching the existing pattern at the bottom of the file.
- Adding a test that assumes the snippet truncation point silently
  documents the 40-char cap. If the cap ever changes, the test
  must change with it. Acceptable: the cap is part of observable
  behavior (UI display).

## Out-of-scope follow-ups

- Eliminating the defensive `err instanceof Error` branches in
  `sync-teams-channels.ts` if/when we tighten the seam types so
  thrown values are always `Error`.
- Audit of other files near the 90% line (`http-yammer-client.ts` at
  97.12% / 96.92%, `sync-sent.ts` at 92.10%, etc.) — separate slice.
