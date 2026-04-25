# Teams channels admin-consent URL CLI flag

## Task

Add a `--teams-admin-consent --account <username>` CLI flag that prints
one admin-consent URL per cached tenant for the given account, so a
tenant admin can grant consent for `Team.ReadBasic.All`,
`Channel.ReadBasic.All`, and `ChannelMessage.Read.All` once.

## Why

Today's discovery: `--add-account` only requests `SCOPES =
["Mail.Read", "Chat.Read"]` at consent time. `TEAMS_CHANNEL_SCOPES`
were never part of any consent ask, so all cached refresh tokens lack
channels-scope authorization. Re-running `--add-account` does not show
any new scopes (consent is already granted for what was asked) and
silent acquisition for channels scopes correctly returns
`AADSTS65001 / interaction_required`.

The cheapest fix is the admin-consent endpoint: a tenant admin opens
the URL in a browser, signs in, clicks "Accept" once, and AAD records
tenant-wide consent. The next silent acquisition then succeeds against
the existing refresh token without any re-login. This is the standard
AAD pattern for granting admin scopes.

## Scope boundary

**IN:**
- New CLI boolean flag `--teams-admin-consent`, requires `--account`
- Walks `auth.listAccounts()` filtered by username (case-insensitive),
  dedupes by `tenantId` — same pattern as `resolveCliAccounts`
- Prints one line per tenant: `<tenantId>\t<URL>`
- URL format: `https://login.microsoftonline.com/<tenantId>/adminconsent?client_id=<MS_CLIENT_ID>`
- Documents the workflow in `docs/user-guide.md` §5c

**OUT:**
- No device-code flow (admin-consent endpoint handles its own browser flow)
- No status check to confirm consent was actually granted (user re-runs
  `--teams-discover` to verify)
- No support for `--tenant <id>` filter (the value-add is precisely
  showing all cached tenants at once — filtering is a future tweak)
- No cross-account batch (one `--account` per invocation, parallel to
  every other teams flag)

## Files to create / touch

- `src/cli.ts`
  - Add `--teams-admin-consent` to `BOOLEAN_FLAGS`
  - Extend `TeamsCommand` union with `{ action: "admin-consent"; account }`
  - Extend `TeamsCliResult` union with `{ action: "admin-consent"; urls }`
  - Update `resolveTeamsCommand` to handle the new flag
  - Update `reportTeamsResult` to print URLs
  - Update `realTeams` to handle the new action — it does NOT need a
    Graph client or store, just `auth.listAccounts()` + `config.clientId`
- `src/cli.test.ts` — new tests for parser, handler, error paths
- `docs/user-guide.md` §5c — note the new flag in the consent-recovery
  workflow
- `docs/changelog.md` — one bullet for today (2026-04-25)

## Seams involved

- `auth` — use existing `AuthClient.listAccounts()` (no new auth seam)
- `print` — already plumbed through `TeamsDeps`
- No graph, no store, no clock, no fs

## RED test list

Each test goes in `src/cli.test.ts` alongside the existing teams CLI
tests.

- AC1: `--teams-admin-consent without --account throws CliUsageError`
  - test name: `"--teams-admin-consent without --account is a CliUsageError"`
  - seams: none (parser-level)
  - edge: parser-level, no auth needed
- AC2: `--teams-admin-consent with unknown account throws CliUsageError`
  - test name: `"--teams-admin-consent with unknown account is a CliUsageError"`
  - seams: auth (FakeAuthClient with no matching accounts)
  - edge: empty listAccounts result for that username
- AC3: `--teams-admin-consent prints one URL per cached tenant`
  - test name: `"--teams-admin-consent prints one admin-consent URL per cached tenant"`
  - seams: auth (FakeAuthClient with 2 cached accounts for same username
    in different tenants)
  - edge: dedupe two MSAL entries with same tenantId
- AC4: `URL format includes tenantId and clientId from config`
  - test name: `"--teams-admin-consent URLs use the configured MS_CLIENT_ID and tenantId"`
  - seams: auth, config
  - edge: validates literal URL string
- AC5: `output is tab-separated tenantId\tURL header + rows`
  - test name: `"--teams-admin-consent output is tab-separated with header"`
  - seams: print
  - edge: header line + data row format

## Open questions / assumptions

- **Assumption**: `config.clientId` is available — yes, it's loaded from
  `MS_CLIENT_ID` env in `loadConfig`. Verified before writing tests.
- **Assumption**: `auth.listAccounts()` returns Account objects with
  `tenantId` populated — yes, the multi-tenant fan-out work today
  established this contract.
- **Assumption**: User wants the URL printed, not auto-opened. Yes — auto-
  opening browsers from a docker container is a non-starter; the user
  copies the URL and opens it on their workstation.

## Risks

- **Low**: Wrong URL format → consent fails silently. Mitigation: AC4
  asserts the literal URL.
- **Low**: User pastes the URL while signed into a non-admin account →
  AAD will show "Approval required" UI rather than fail. That's the
  user's UX problem, not ours; the CLI's job is just to print the URL.
- **None**: No data plane changes, no schema changes, no Graph calls.

## Out-of-scope follow-ups

- A separate `--add-teams-consent --tenant <id>` device-code flow that
  *does* perform interactive login with `TEAMS_CHANNEL_SCOPES` — useful
  for non-admin guest users in tenants that allow user consent. Defer
  until someone needs it.
- A status check (`--teams-check-consent --account`) that probes Graph
  to verify consent landed. Defer.
- Folding the channels scopes into the default `--add-account` flow.
  Risky: would break add-account in tenants where the user is not an
  admin. Not pursuing.
