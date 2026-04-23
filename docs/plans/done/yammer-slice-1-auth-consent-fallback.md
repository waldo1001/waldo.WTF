# Plan: Yammer auth consent fallback (Slice 1 of 3)

## Task
When `--viva-discover` calls `getTokenSilent` for the Yammer scope and MSAL has no cached Yammer token, automatically trigger a device-code flow for the Yammer scope so the user can consent without having to re-add their account.

## Scope boundary

**In scope:**
- Add `options?: { scopes?: readonly string[] }` to `AuthClient.loginWithDeviceCode`
- Implement the override in `MsalAuthClient`
- Update `FakeAuthClient` to record scopes on `loginWithDeviceCode` calls
- In `discoverForAccount` (cli.ts): catch `AuthError("silent-failed")` on Yammer scope, call `loginWithDeviceCode` with `[YAMMER_SCOPE]`, retry `getTokenSilent`
- Add `print?: PrintFn` to `VivaDeps` so the device-code prompt can surface in tests and production

**Out of scope (deferred to Slices 2–3):**
- Pivot from Graph `/employeeExperience` to Yammer REST — external networks still won't appear after this slice; that needs the REST pivot
- Any change to `VivaClient` interface or `HttpVivaClient`
- Any change to sync-viva

## Files to create / touch

- `src/auth/auth-client.ts` — add `options?: LoginWithDeviceCodeOptions` to `loginWithDeviceCode`
- `src/auth/msal-auth-client.ts` — use `options.scopes ?? SCOPES` in `loginWithDeviceCode`
- `src/auth/msal-auth-client.test.ts` — add test: scopes override forwarded; no-scopes uses Graph default
- `src/testing/fake-auth-client.ts` — record scopes on `loginWithDeviceCode` call
- `src/testing/fake-auth-client.test.ts` — add test: scopes recorded
- `src/cli.ts` — add `print?` to `VivaDeps`; add Yammer fallback in `discoverForAccount`
- `src/cli.test.ts` — add tests for fallback path and failure propagation

## Seams involved

`msal` (auth), none for the CLI fallback logic (pure coordination of injected fakes)

## RED test list

- AC1: `loginWithDeviceCode` forwards a scopes override to MSAL
  - test file: `src/auth/msal-auth-client.test.ts`
  - test name: `"loginWithDeviceCode with scopes override forwards those scopes to acquireTokenByDeviceCode"`
  - seams: msal (FakePca)
  - edge cases: empty scopes array, single-element array

- AC2: `loginWithDeviceCode` without override still uses Graph SCOPES (regression guard)
  - test file: `src/auth/msal-auth-client.test.ts`
  - test name: `"loginWithDeviceCode without scopes option uses default Graph scopes"`
  - seams: msal (FakePca)

- AC3: `FakeAuthClient.loginWithDeviceCode` records the scopes it was called with
  - test file: `src/testing/fake-auth-client.test.ts`
  - test name: `"loginWithDeviceCode call records scopes when provided"`
  - seams: none

- AC4: `discoverForAccount` / `realViva discover` falls back to device-code when Yammer silent-token fails, then succeeds
  - test file: `src/cli.test.ts`
  - test name: `"realViva --viva-discover triggers loginWithDeviceCode for Yammer scope when silent token fails"`
  - seams: FakeAuthClient (scripted to throw silent-failed on first call, succeed on second), FakeVivaClient
  - edge cases: second `getTokenSilent` also fails → error propagates

- AC5: error from second `getTokenSilent` after the device-code consent propagates to caller
  - test file: `src/cli.test.ts`
  - test name: `"realViva --viva-discover propagates error when Yammer token still fails after device-code consent"`
  - seams: FakeAuthClient (always fails silent)

## Open questions / assumptions

- **Assumption**: Any `AuthError("silent-failed")` from `getTokenSilent(account, { scopes: [YAMMER_SCOPE] })` is treated as "Yammer not yet consented". This is safe because this code path only runs for Yammer discovery; Graph errors surface elsewhere with different handling.
- **Assumption**: After `loginWithDeviceCode({ scopes: [YAMMER_SCOPE] })`, MSAL caches the Yammer token and the second `getTokenSilent` succeeds. Tests verify via FakeAuthClient scripting.
- **Assumption**: The device-code prompt for Yammer will display the same URL as any other MSAL device-code flow — no special message needed.

## Risks

- If MSAL returns a `null` account from the Yammer device-code flow (e.g. user canceled), `loginWithDeviceCode` already throws `AuthError("device-code-failed")` — this propagates naturally without extra handling.
- Two consecutive device-code prompts (Graph + Yammer) may confuse users. The CLI will print a clear message before the Yammer prompt to explain why.

## Out-of-scope follow-ups

- Slice 2: Yammer REST HTTP client + updated VivaClient interface + FakeVivaClient
- Slice 3: sync-viva pivot + CLI discover/subscribe updates for network-grouped output
