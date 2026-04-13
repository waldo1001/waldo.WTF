# Weekend 4 — Slice 3: `TeamsClient` seam + `FakeTeamsClient`

## Goal

Introduce a `TeamsClient` interface mirroring `GraphClient` so Teams
delta paging can be orchestrated from `syncTeams` (slice 5) against a
fake. No real HTTP yet — that's slice 4.

## Scope

**IN:**
- `src/sources/teams.ts` — `TeamsClient` interface, `TeamsMessage` /
  `TeamsDeltaResponse` DTOs, re-export of shared transport errors
  (`TokenExpiredError`, `GraphRateLimitedError`,
  `DeltaTokenInvalidError` — imported from `graph.js`; no Teams-
  specific classes yet).
- `src/testing/fake-teams-client.ts` — `FakeTeamsClient` with scripted
  `{kind:'ok'|'error'}` steps, `calls` recorder, `remainingSteps`
  counter.
- Unit tests for the fake.

**OUT:**
- Real HTTP — slice 4.
- sync orchestration — slice 5.
- Mapping `TeamsMessage` → `Message` — deferred to slice 5 in the
  `syncTeams` function.

## RED list

1. `FakeTeamsClient.getDelta` returns scripted ok response, records
   url + token.
2. Successive calls consume steps in order; `remainingSteps` decrements.
3. Scripted error is thrown for that step.
4. Throws informative error when no scripted step remains.
5. `TeamsClient` type surface compiles (`TeamsMessage`,
   `TeamsDeltaResponse`, `@removed`, `channelIdentity`, `mentions`).

## DoD

All tests green, coverage ≥90%, security clean, committed + pushed.

**Auto-approved.**
