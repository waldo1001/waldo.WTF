# Weekend 2 — Slice 11: Real HTTP GraphClient adapter

**Status:** DRAFT — awaiting user approval before FRAME/RED.

## Task

Land `HttpGraphClient` — the real `fetch`-backed implementation of the
`GraphClient` seam defined in [src/sources/graph.ts](../../src/sources/graph.ts)
— proven by failing-then-passing contract tests that inject a scripted
`fetch` fake. This replaces `notImplementedGraph` in
[src/index.ts:34-40](../../src/index.ts#L34-L40) so the sync scheduler can
talk to real `graph.microsoft.com` in `main()`.

## Why this slice next

- PROGRESS.md Weekend 2: the 5-minute sync loop is landed
  ([src/sync/](../../src/sync/)) but still wired to `NotImplementedGraph`
  in [src/index.ts:84](../../src/index.ts#L84). Without this slice, `main()`
  cannot actually sync.
- Every other consumer seam (auth, store, scheduler, MCP transport) is
  already real. Graph HTTP is the last stub blocking an end-to-end run.
- Slice 3's out-of-scope list explicitly named this as the follow-up
  ([slice 3 plan §Out-of-scope follow-ups](./weekend-2-slice-3-fake-graph-client.md)).
- Low blast radius: the seam, error classes, and `FakeGraphClient`
  contract already exist — this slice only adds one new file + wires it
  into the composition root.

## Scope boundary

**IN this slice:**
- `src/sources/http-graph-client.ts` — `HttpGraphClient` class implementing
  `GraphClient` from [src/sources/graph.ts](../../src/sources/graph.ts).
  - Constructor takes an injectable `FetchLike` (typed subset of global
    `fetch`) and an optional `baseUrl` (default
    `https://graph.microsoft.com/v1.0`) and optional `preferMaxPageSize`
    (default `50`, matching the spike).
  - `getDelta(url, token)`:
    - resolves `url` against `baseUrl` if relative, uses as-is if
      absolute (nextLink / deltaLink come back absolute from Graph).
    - sends `Authorization: Bearer <token>`, `Accept: application/json`,
      and `Prefer: odata.maxpagesize=<n>` on the initial-endpoint path
      only (nextLink/deltaLink responses already carry the preference
      through the token, so re-sending is harmless but unnecessary —
      we send it every request for simplicity; confirm in Q1).
    - on 2xx: parses JSON, returns as `GraphDeltaResponse` (structural,
      no runtime validation beyond "is an object").
    - on 401 → throws `TokenExpiredError`.
    - on 429 → reads `Retry-After` header (seconds; falls back to `60`
      if missing or unparseable) and throws
      `GraphRateLimitedError(seconds)`.
    - on 410 → throws `DeltaTokenInvalidError`.
    - on any other non-2xx → throws a generic `Error` whose message
      includes status + a truncated body excerpt (≤200 chars, never
      logs the bearer token).
- `src/sources/http-graph-client.test.ts` — contract tests driven by a
  scripted fake `fetch` (plain function, not a library). Uses the
  existing `FakeGraphClient` *only* as a reference; this file tests the
  real HTTP impl against a fake transport.
- `src/index.ts` — replace `notImplementedGraph` with
  `new HttpGraphClient({ fetch: globalThis.fetch.bind(globalThis) })`.
- `docs/changelog.md` — entry via `/docs-update`.
- `PROGRESS.md` — tick the "Real HTTP `GraphClient`" follow-up on the
  "5-minute sync loop" line.

**OUT of scope (deferred):**
- Retry/backoff *policy*. The adapter throws `GraphRateLimitedError`;
  whatever sits above it (scheduler, or a future retry wrapper) decides
  whether and how to wait. Keeps this slice a pure transport.
- Token refresh on 401. Same reason — caller's job.
- Batching (`$batch`), non-delta endpoints, attachments, users, drive, etc.
- Telemetry / logging seam. Errors carry their own messages; no logger
  is wired through yet (out-of-scope for all slices so far).
- Live smoke test against real `graph.microsoft.com`. Manual step,
  documented in the changelog entry the way the MSAL adapter did it
  ([src/auth/msal-auth-client.ts](../../src/auth/msal-auth-client.ts)).

## Files to create / touch

| Path | New? | Purpose |
|---|---|---|
| [src/sources/http-graph-client.ts](../../src/sources/http-graph-client.ts) | new | real `fetch`-backed `GraphClient` impl |
| [src/sources/http-graph-client.test.ts](../../src/sources/http-graph-client.test.ts) | new | RED contract tests with scripted `fetch` fake |
| [src/index.ts](../../src/index.ts) | edit | remove `notImplementedGraph`, construct `HttpGraphClient` |
| [docs/changelog.md](../../docs/changelog.md) | edit | changelog entry (via `/docs-update`) |
| [PROGRESS.md](../../PROGRESS.md) | edit | tick real-HTTP follow-up |

## Seams involved

- `graph` — realizing the existing seam
- `fetch` — new *local* seam inside `HttpGraphClient` (constructor-injected
  `FetchLike`). Not exposed to the rest of the app; other modules do not
  talk to `fetch` directly.

## RED test list

```
- AC1: getDelta resolves a relative url against baseUrl and sends auth + prefer headers
  - test file: src/sources/http-graph-client.test.ts
  - test name: "getDelta hits baseUrl + relative path with bearer token and Prefer header"
  - seams touched: graph, fetch
  - edge cases: initial endpoint `/me/mailFolders/inbox/messages/delta`;
    asserts Authorization: Bearer <token>, Accept: application/json,
    Prefer: odata.maxpagesize=50; no body, method GET

- AC2: getDelta passes an absolute nextLink through unchanged
  - test file: src/sources/http-graph-client.test.ts
  - test name: "getDelta uses absolute nextLink url as-is"
  - seams touched: graph, fetch
  - edge cases: url starts with https://graph.microsoft.com/v1.0/...;
    adapter does not double-prefix baseUrl; query string preserved verbatim

- AC3: 2xx JSON response is returned as GraphDeltaResponse
  - test file: src/sources/http-graph-client.test.ts
  - test name: "getDelta returns parsed JSON with value/@odata.nextLink/@odata.deltaLink"
  - seams touched: graph, fetch
  - edge cases: value array preserved; nextLink-only response; deltaLink-only
    response; empty value array

- AC4: HTTP 401 maps to TokenExpiredError
  - test file: src/sources/http-graph-client.test.ts
  - test name: "getDelta throws TokenExpiredError on HTTP 401"
  - seams touched: graph, fetch
  - edge cases: body is not parsed / not logged; instanceof check holds

- AC5: HTTP 429 maps to GraphRateLimitedError with Retry-After seconds
  - test file: src/sources/http-graph-client.test.ts
  - test name: "getDelta throws GraphRateLimitedError carrying Retry-After seconds"
  - seams touched: graph, fetch
  - edge cases: header present (integer seconds); header missing → defaults to 60;
    header malformed ("abc") → defaults to 60

- AC6: HTTP 410 maps to DeltaTokenInvalidError
  - test file: src/sources/http-graph-client.test.ts
  - test name: "getDelta throws DeltaTokenInvalidError on HTTP 410"
  - seams touched: graph, fetch
  - edge cases: instanceof check holds; message does not include the bearer token

- AC7: Other non-2xx statuses throw a generic Error with status + truncated body
  - test file: src/sources/http-graph-client.test.ts
  - test name: "getDelta throws a descriptive Error on HTTP 500"
  - seams touched: graph, fetch
  - edge cases: body excerpt ≤200 chars; bearer token never appears in message;
    500 and 403 both covered

- AC8: bearer token is never logged or embedded in thrown error messages
  - test file: src/sources/http-graph-client.test.ts
  - test name: "thrown errors do not leak the bearer token"
  - seams touched: graph, fetch
  - edge cases: a sentinel token string ("tok-SECRET-do-not-leak") is passed;
    every thrown error's message is asserted not to contain it
```

Eight ACs. Each RED → GREEN individually, per the `/tdd-cycle` skill.

## Open questions / assumptions

1. **Prefer header on every request, or only on the initial endpoint?**
   Assumption: send it every request — harmless, simpler, and matches
   what the spike did. → **Confirm or override.**
2. **`preferMaxPageSize` default = 50**, matching the spike's
   observation that it "keeps pages reasonable"
   ([PROGRESS.md Delta queries notes](../../PROGRESS.md#L29)). Overridable
   via constructor for tests. → **Confirm.**
3. **`FetchLike` shape** — a narrow structural type:
   `(input: string, init?: { method?: string; headers?: Record<string,string> }) => Promise<FetchLikeResponse>`
   where `FetchLikeResponse = { status: number; headers: { get(name): string | null }; text(): Promise<string> }`.
   Narrower than the DOM `fetch` type so tests don't need to fabricate
   `Request`/`Headers` objects. Production wiring adapts `globalThis.fetch`. → **Confirm.**
4. **No response-body runtime validation.** If Graph returns something
   structurally unexpected (e.g. `value` missing), we return whatever
   JSON.parse produced and let the caller break on use. Rationale:
   matches how `FakeGraphClient` already behaves; adding schema
   validation is scope creep. → **Confirm or override.**
5. **`main()` wires `globalThis.fetch.bind(globalThis)`.** Node 22 has
   global `fetch`; no `undici` import needed. → **Confirm.**
6. **File location:** `src/sources/http-graph-client.ts` alongside
   `graph.ts`, matching the `src/auth/msal-auth-client.ts` convention
   (real impl lives next to the seam, test double lives under
   `src/testing/`). → **Confirm.**
7. **No new dependencies.** `fetch` is global; no `node-fetch`, no
   `undici`, no `@microsoft/microsoft-graph-client`. → **Confirm.**
8. **`HttpGraphClient` constructor takes an options object**
   (`{ fetch, baseUrl?, preferMaxPageSize? }`) not positional args —
   matches the project's house style (`SqliteMessageStore`,
   `MsalAuthClient`, `SyncScheduler` all use options objects). → **Confirm.**

## Risks

- **Error-mapping drift between fake and real impl.** Slice 3's fake
  throws the same three error classes but from scripted steps. If the
  real impl maps a status that the fake never produces (or vice versa),
  sync-inbox tests written against the fake may not catch a regression
  in the real mapping. Mitigation: this slice's contract tests cover
  every mapped status directly; sync-inbox tests stay fake-driven.
- **Bearer token leaking into error messages.** High-impact if it
  happens; caught by AC8, which uses a sentinel string. Mitigation:
  the adapter never interpolates `token` into any thrown message, and
  a test pins that invariant.
- **Retry-After parsing.** Graph sometimes sends an HTTP-date instead
  of integer seconds. Assumption: integer seconds only; HTTP-date falls
  back to 60. Mitigation: AC5 pins the "malformed → 60" behavior;
  revisit only if a real smoke run shows Graph using dates.
- **Global `fetch` type drift.** Typing against DOM `fetch` drags in
  `lib.dom.d.ts`. Mitigation: the `FetchLike` narrow type avoids
  importing DOM lib; `main()` adapts the real global at the
  composition root with a single `as` cast or thin wrapper.
- **Network in tests.** Anyone writing a future test could accidentally
  call the real `fetch`. Mitigation: constructor requires `fetch` —
  there is no default — so forgetting to inject fails loudly.
- **Live smoke still pending.** This slice lands unit tests only. The
  first real run against `graph.microsoft.com` is a manual follow-up,
  same pattern as the MSAL adapter.

## Out-of-scope follow-ups (track for later slices)

- Retry/backoff wrapper around `GraphClient` (honors
  `GraphRateLimitedError.retryAfterSeconds`), lands with the first
  real rate-limit incident.
- 401-refresh wrapper composing `AuthClient` + `GraphClient`.
- Logger seam so adapters can emit structured events instead of
  relying on thrown-error messages.
- Manual live smoke against `graph.microsoft.com` (document in
  changelog once performed, same pattern as `MsalAuthClient`).

## Definition of done for this slice

- [ ] Plan file approved by user.
- [ ] FRAME posted in chat (≤150 words).
- [ ] 8 new RED tests in `src/sources/http-graph-client.test.ts`,
      each observed failing for the right reason, then green.
- [ ] `npm test` green across the whole suite.
- [ ] `npm run typecheck` passes with zero errors.
- [ ] Coverage on `src/sources/http-graph-client.ts` ≥ 90% lines + branches.
- [ ] `notImplementedGraph` removed from `src/index.ts`; `main()`
      constructs `HttpGraphClient` with the global `fetch`.
- [ ] `/security-scan` passes (special attention: no token in logs /
      errors / fixtures).
- [ ] `/docs-update` run — changelog entry added, PROGRESS.md ticked.
