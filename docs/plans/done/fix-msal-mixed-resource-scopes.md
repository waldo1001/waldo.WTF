# Plan: fix MSAL mixed-resource scopes

## Task
Remove `YAMMER_SCOPE` from the default `SCOPES` array so that `--add-account` (device-code login) only requests Microsoft Graph scopes, then pass `[YAMMER_SCOPE]` explicitly wherever a Viva Engage token is needed.

## Scope boundary
**IN:** Update `SCOPES` constant, update the two `getTokenSilent` call sites (sync-viva, cli), update the three affected tests that assert the old behaviour.
**OUT:** Incremental-consent flow if the app registration lacks Yammer delegated permissions; that surfaces as a sync error with a clear `silent-failed` message and is a separate story.

## Files to create / touch
- `src/auth/msal-auth-client.ts` — remove `YAMMER_SCOPE` from `SCOPES`
- `src/auth/msal-auth-client.test.ts` — update three test assertions
- `src/sync/sync-viva.ts` — pass `{ scopes: [YAMMER_SCOPE] }` to `getTokenSilent`
- `src/sync/sync-viva.test.ts` — add assertion that scopes option is forwarded
- `src/cli.ts` — pass `{ scopes: [YAMMER_SCOPE] }` to `getTokenSilent` in `discoverForAccount`
- `src/cli.test.ts` — add assertion that `--viva-discover` requests Yammer scope

## Seams involved
`msal`

## RED test list
- **AC1**: `SCOPES` contains only `["Mail.Read", "Chat.Read"]` — no Yammer scope
  - test file: `src/auth/msal-auth-client.test.ts`
  - test name: `"SCOPES contains only the two Graph scopes and does not include Yammer"`
  - seams: msal
  - edge cases: none

- **AC2**: `loginWithDeviceCode` requests only the two Graph scopes
  - test file: `src/auth/msal-auth-client.test.ts`
  - test name: `"loginWithDeviceCode requests only Graph scopes (Mail.Read + Chat.Read) — no Yammer"`
  - seams: msal
  - edge cases: none

- **AC3**: `getTokenSilent` without override still uses only Graph scopes
  - test file: `src/auth/msal-auth-client.test.ts`
  - test name: `"getTokenSilent without scopes override uses only the two Graph scopes"`
  - seams: msal
  - edge cases: none

- **AC4**: `syncViva` acquires a Viva token with the Yammer scope explicitly
  - test file: `src/sync/sync-viva.test.ts`
  - test name: `"syncViva acquires token with YAMMER_SCOPE so the Viva API call uses the correct audience"`
  - seams: msal, store
  - edge cases: none

- **AC5**: `--viva-discover` CLI acquires a Viva token with the Yammer scope
  - test file: `src/cli.test.ts`
  - test name: `"--viva-discover acquires token with the Yammer scope"`
  - seams: msal
  - edge cases: none

## Open questions / assumptions
- **Assumption**: the Azure AD app registration `0fcdd7e7-...` has Yammer delegated permissions already configured (or will be configured separately). If not, `getTokenSilent` will throw `silent-failed` on first Viva sync; that's acceptable and will surface a clear error.
- **Assumption**: separating the Yammer scope from `loginWithDeviceCode` means existing accounts will get a Yammer token on first Viva sync via the multi-resource refresh-token chain. If the refresh token can't cover `api.yammer.com`, a second interactive step will be needed — out of scope here.

## Risks
- Existing tests assert the OLD behaviour (Yammer in SCOPES, device-code requests all three). Updating them is intentional RED→GREEN, not a regression.
- No impact on Graph sync (inbox, teams, sent) — they call `getTokenSilent` with no scope override, which continues to use the Graph-only SCOPES.

## Out-of-scope follow-ups
- Handle `InteractionRequiredAuthError` from `getTokenSilent` for Yammer (needs a dedicated `--add-viva-account` or incremental-consent flow).
- Sync the NAS `docker-compose.yml` with the repo (volume path drift: `./auth` vs `./data/auth`).
