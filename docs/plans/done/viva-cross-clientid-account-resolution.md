# Slice 4b-3 — Cross-clientId account resolution for Viva discover/subscribe

## Task

Make `--viva-discover` and `--viva-subscribe` see accounts that were added
via `--add-account --tenant <guid>`, which are cached under
`YAMMER_PUBLIC_CLIENT_ID` rather than `config.msClientId`.

## Why this exists (the bug in production)

MSAL's token cache is partitioned per clientId. Slice 4b-1 added Yammer
scope support against the project's own `config.msClientId` for home-
tenant accounts. Slice 4b-2 added `--add-account --tenant` which logs in
via `YAMMER_PUBLIC_CLIENT_ID` (Azure CLI's pre-consented first-party app,
required for external tenants). But `buildDefaultVivaAuth` and all
downstream resolve paths still use `config.msClientId` for
`listAccounts()`, so accounts logged in under the Azure CLI clientId are
invisible to discover/subscribe. The symptom in production:

    sudo docker compose run --rm waldo --viva-discover --account eric.wauters@dynex.be
    Found 13 network(s): … (dynex's home-tenant view)
    no viva communities visible to this account

"Found 13 network(s)" printed exactly once — the loop iterated only one
account (the home-tenant one under `msClientId`) because `listAccounts()`
on that PCA instance never returns cache entries from the other clientId
partition. The new Microsoft-tenant account sits in
`token-cache.json` but behind the wrong clientId filter.

The Slice 4b-2 aggregation test was green because `FakeAuthClient.listAccounts`
was fed two accounts directly — the test never exercised the composition-
root seam that picks *which* clientId to ask MSAL about.

## Scope boundary

### IN

- `VivaDeps.auth?: AuthClient` → `VivaDeps.auths?: readonly AuthClient[]`.
- `discoverForAccount` lists accounts across all auth clients in `auths`,
  dedupes by `homeAccountId`, and for each resolved account uses the
  specific auth client that surfaced it to call `getTokenSilent`.
- `subscribe` routes through the same `discoverForAccount`, so the fix
  carries over without separate work.
- Composition root (`buildDefaultVivaAuth`) builds two auth clients —
  one with `config.msClientId`, one with `YAMMER_PUBLIC_CLIENT_ID` —
  and returns them as a tuple for the default `auths`.
- Yammer-scope device-code fallback (the "Yammer scope not yet consented"
  path in `discoverForAccount`) uses the same auth client that owns the
  account, so the re-login writes to the same clientId partition.

### OUT

- No change to `AddAccountOptions.auth` — that's a single-login path.
- No change to `sync-viva.ts` or `sync-scheduler` (those still use one
  `AuthClient`; sync already works because the active subscription's
  account lives in exactly one clientId partition and we never re-enumerate
  there).
- No attempt to migrate existing cache entries across clientIds — users
  who added `eric@dynex` under `msClientId` and then `eric@dynex`
  (Microsoft tenant) under `YAMMER_PUBLIC_CLIENT_ID` will simply have
  both entries visible after this fix.
- No CLI flag changes. No doc changes for end users beyond a changelog
  bullet (the behavior they expected is now the behavior they get).

## Files to create / touch

- [src/cli.ts](../../src/cli.ts) — VivaDeps field rename, dual-auth
  composition root, account-to-authclient mapping in `discoverForAccount`.
- [src/cli.test.ts](../../src/cli.test.ts) — replace existing
  "aggregates listCommunities across all cached tenants" test with one
  that passes **two** auth clients and asserts listAccounts+getTokenSilent
  routing. Add dedupe test and wrong-client-silent-token-fails
  regression.

## Seams involved

- **msal** — `AuthClient.listAccounts()` / `getTokenSilent()` seam. We
  already have `FakeAuthClient` so no new fake needed, just multiple
  instances.

## RED test list

- **AC1**: `discoverForAccount` with `deps.auths = [authA, authB]` where
  authA surfaces `eric@dynex` (home tenant) and authB surfaces
  `eric@dynex` (Microsoft tenant with different `homeAccountId` /
  `tenantId`) calls `listAccounts` on both, calls `getTokenSilent` on
  authA only for the home account and on authB only for the Microsoft
  account, and returns communities from both calls, each stamped with
  the owning account's `tenantId`.
  - test file: `src/cli.test.ts`
  - test name: `"--viva-discover lists accounts across multiple clientId-partitioned auth clients"`
  - edge cases: no cross-talk — authA must never be asked for the authB
    account's token (and vice versa).

- **AC2**: When the same `homeAccountId` appears in both auth client
  caches (shouldn't happen in practice, but defensive), the account is
  iterated exactly once.
  - test name: `"--viva-discover dedupes an account that appears in both auth caches"`

- **AC3**: The existing "triggers loginWithDeviceCode for Yammer scope
  when silent token fails" test stays green — the fallback must target
  the specific auth client that owns the account (not a different one
  in the array).
  - test name: (existing, re-verify with new wiring)

## Open questions / assumptions

- **Assumption**: MSAL-node's cache plugin correctly serializes/deserializes
  account records for multiple clientIds into the same
  `token-cache.json` file without one clientId's PCA clobbering the
  other's entries on save. MSAL's format is per-entry clientId-tagged,
  so this should hold. Flagging it because if it turns out they collide,
  a second-login-wipes-first scenario exists and we'd need separate
  cache files per clientId.

## Risks

- **Silent token acquisition against the wrong auth client throws.** The
  mapping must be 1:1 (account → auth client that listed it). A bug
  here would send a msClientId account's request to the Azure CLI PCA
  and fail with a confusing MSAL error.
- **Order-dependent dedupe.** We dedupe by `homeAccountId`; the auth
  client that wins is whichever is listed first in `auths`. Default
  order puts msClientId first so home-tenant accounts keep the original
  clientId (won't force re-consent). Document this choice.

## Out-of-scope follow-ups

- Eventually surface clientId on the `Account` type so any caller can
  route independently of the discovery step. Not now — keeps the Account
  seam stable for other callers.
- Consider consolidating on `YAMMER_PUBLIC_CLIENT_ID` for all Yammer-
  scope work so there's only one partition to read. Would require a
  re-consent dance for existing home-tenant subs; deferred.
