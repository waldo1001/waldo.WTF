# Weekend 2 — Slice 3: Graph seam + scripted fake

**Status:** DRAFT — awaiting user approval before FRAME/RED.

## Task

Land the `GraphClient` seam (`src/sources/graph.ts`) and its scripted
test double (`src/testing/fake-graph-client.ts`), proven by
failing-then-passing contract tests. No real HTTP impl yet — the seam is
introduced ahead of the first module that will consume it (the delta
sync loop).

## Why this slice next

- PROGRESS.md Weekend 2: "Port example fakes from testing/examples/ into
  `src/testing/` (clock + fs done; graph pending)".
- Slice 2's out-of-scope list explicitly names this as the next
  candidate.
- Every future module that talks to Microsoft Graph (delta sync,
  token-refresh-on-401, rate-limit backoff, tombstone handling) will
  depend on this interface. Landing it now keeps those slices narrow and
  lets them be written test-first without dragging the real HTTP impl
  along.
- Low risk: pure types + an in-memory scripted fake. No network, no
  native deps, no secrets.

## Scope boundary

**IN this slice:**
- `src/sources/graph.ts` — types + interface matching
  [testing/examples/fake-graph-client.example.ts](../../testing/examples/fake-graph-client.example.ts):
  - `GraphMessage`, `GraphDeltaResponse` types
  - `GraphClient` interface with `getDelta(url, token)`
  - Error classes: `TokenExpiredError`, `GraphRateLimitedError`
    (carrying `retryAfterSeconds`), `DeltaTokenInvalidError`
- `src/testing/fake-graph-client.ts` — `FakeGraphClient` implementing
  `GraphClient`, driven by a `Script` of scripted step responses/errors,
  with a `calls` log and a `remainingSteps` getter.
- `src/testing/fake-graph-client.test.ts` — contract tests (RED list
  below).
- `npm test` green, `npm run typecheck` clean, coverage ≥90% on touched
  files.

**OUT of scope (deferred):**
- Real HTTP impl (`src/sources/graph-http.ts`) — the only place `fetch`
  against `graph.microsoft.com` will be allowed. Lands with the first
  consumer that needs real traffic.
- Any sync-loop / delta-state consumer of `GraphClient`.
- MSAL / token refresh logic. The fake just records tokens passed in;
  it does not refresh.
- Non-delta Graph endpoints (`/me`, `/users`, attachments, etc.).
- Logger seam.

## Files to create / touch

| Path | New? | Purpose |
|---|---|---|
| `src/sources/graph.ts` | new | types, interface, error classes |
| `src/testing/fake-graph-client.ts` | new | scripted fake |
| `src/testing/fake-graph-client.test.ts` | new | RED contract tests |

## Seams involved

- `graph` (introduced this slice)
- none other

## RED test list

```
- AC1: getDelta returns the scripted ok response and records the call
  - test file: src/testing/fake-graph-client.test.ts
  - test name: "getDelta returns the scripted response and records url + token"
  - seams touched: graph
  - edge cases: calls log preserves order; response object is returned by reference

- AC2: successive calls walk the script in order
  - test file: src/testing/fake-graph-client.test.ts
  - test name: "successive getDelta calls consume scripted steps in order"
  - seams touched: graph
  - edge cases: remainingSteps decrements each call; two ok steps → two distinct responses

- AC3: a scripted error step is thrown on the matching call
  - test file: src/testing/fake-graph-client.test.ts
  - test name: "getDelta throws the scripted error for that step"
  - seams touched: graph
  - edge cases: TokenExpiredError, GraphRateLimitedError(retryAfterSeconds),
    DeltaTokenInvalidError are all instanceof-checkable by callers

- AC4: calling past the end of the script throws an explanatory error
  - test file: src/testing/fake-graph-client.test.ts
  - test name: "getDelta throws when no scripted step remains"
  - seams touched: graph
  - edge cases: error message names the call index and the offending url so
    test failures are self-diagnosing

- AC5: GraphRateLimitedError carries retryAfterSeconds on the instance
  - test file: src/testing/fake-graph-client.test.ts
  - test name: "GraphRateLimitedError exposes retryAfterSeconds"
  - seams touched: graph
  - edge cases: value survives through throw/catch; message includes the seconds
```

Five ACs. Each RED → GREEN individually, per the skill.

## Open questions / assumptions

1. **Assumption:** Interface matches the example file verbatim — only
   `getDelta(url, token)`. No `get(url)`, no `post(...)`, no batching,
   until a real consumer demands one. → **Confirm or override.**
2. **Assumption:** `GraphMessage` stays a structural type (optional
   `from`, `body`, `@removed`) exactly as drafted in the example. The
   store module will define its own persisted shape later; this type is
   only the wire contract. → **Confirm.**
3. **Assumption:** The fake does not validate `url` or `token` (doesn't
   care whether the url is a nextLink vs deltaLink vs initial endpoint).
   Tests that want to assert on URL flow inspect `calls` themselves. →
   **Confirm.**
4. **Assumption:** Error classes extend `Error` directly (no shared base
   class, no discriminant `code` field). Consumers branch via
   `instanceof`. → **Confirm or override** (alternative: a `GraphError`
   base + `.code` like the fs ENOENT pattern).
5. **Assumption:** `src/sources/graph.ts` is the right home (the
   `src/sources/` folder does not yet exist — this slice creates it).
   Alternative: `src/graph.ts` flat, move later. → **Confirm.**
6. **Assumption:** No barrel file (`src/testing/index.ts`); tests keep
   importing fakes by direct path, matching the convention set by Slices
   1 and 2. → **Confirm.**
7. **Question:** The example file annotates HTTP 410 → `DeltaTokenInvalidError`.
   Since this slice ships no real HTTP mapping, do you want that mapping
   documented in a JSDoc on the interface (as the example does), or
   deferred to the real impl slice?

## Risks

- **Scope creep into a mini-Graph-SDK.** Temptation to add
  `getUsers()`, batching, attachments, retry helpers. Mitigation: stick
  to the five ACs; extend only when a failing consumer test demands it.
- **Error-shape drift.** If the real impl later reshapes errors (e.g.
  adds `.status`), consumers written against the fake's current shape
  will need updates. Mitigation: keep the shape minimal now; one AC
  pins `retryAfterSeconds` so it can't silently drift.
- **Folder-layout bikeshed.** Creating `src/sources/` commits to the
  brief's architecture before any source actually exists. Mitigation:
  it's the layout the brief already prescribes, and moving a
  two-file folder later is cheap.
- **Script ergonomics.** The `{ kind: "ok" | "error" }` tagged union is
  verbose in tests. Mitigation: acceptable for now; add helper factories
  (`ok(response)`, `err(e)`) only if a second consumer repeats the
  boilerplate.

## Out-of-scope follow-ups (track for later slices)

- Slice 4 candidate: real `GraphClient` impl (`src/sources/graph-http.ts`)
  wrapping `fetch`, landed with its first consumer (delta sync).
- Slice 5 candidate: `Logger` seam + silent fake.
- Slice 6 candidate: real `FileSystem` impl (`src/support/fs-node.ts`)
  wrapping `node:fs/promises` + `chokidar`.
- Slice 7+: token cache, delta-state persistence, SQLite store, sync
  loop, MCP skeleton.

## Definition of done for this slice

- [ ] Plan file approved by user.
- [ ] FRAME posted in chat (≤150 words).
- [ ] `npm test` reports existing clock + fs tests still green, plus
      5 new graph tests passing.
- [ ] `npm run typecheck` passes with zero errors.
- [ ] Coverage on `src/sources/graph.ts` and
      `src/testing/fake-graph-client.ts` ≥ 90% lines + branches.
- [ ] `/security-scan` passes.
- [ ] `/docs-update` run — changelog entry added.
- [ ] PROGRESS.md Weekend 2 updated: graph portion of the "Port example
      fakes" line ticked.
