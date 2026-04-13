# Weekend 4 — Slice 4: `HttpTeamsClient` (fetch-backed)

## Goal

Real HTTP adapter for `TeamsClient` paralleling `HttpGraphClient`.
Parses delta pages, maps 401/410/429 to the shared transport errors,
redacts the bearer token from thrown error messages.

## Scope

**IN:**
- `src/sources/http-teams-client.ts`: near-clone of
  `HttpGraphClient`, but typed as `TeamsClient`. Default base URL
  `https://graph.microsoft.com/v1.0`. Default Prefer header
  `odata.maxpagesize=50`.
- `src/sources/http-teams-client.test.ts`: mirror the
  `HttpGraphClient` test cases — base url composition, absolute
  nextLink passthrough, JSON roundtrip, 401/410/429/non-2xx, token
  redaction.

**OUT:**
- Wiring into `main()` / sync loop — slice 5.
- Live smoke against real Graph — manual follow-up.

## RED list

1. Hits baseUrl + relative path with `Authorization: Bearer <token>`,
   `Accept: application/json`, `Prefer: odata.maxpagesize=50`.
2. Absolute URLs passed through untouched.
3. Parses `{value, @odata.nextLink, @odata.deltaLink}` JSON.
4. 401 → `TokenExpiredError`.
5. 429 → `GraphRateLimitedError` with parsed / defaulted
   `retryAfterSeconds`.
6. 410 → `DeltaTokenInvalidError`.
7. Non-2xx (500, 403) throws with body excerpt ≤200 chars.
8. Bearer token never leaks into the error message.

## DoD

All green, ≥90% coverage on touched files, security clean, committed +
pushed.

**Auto-approved.**
