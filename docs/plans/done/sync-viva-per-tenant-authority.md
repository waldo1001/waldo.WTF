# Plan — sync-viva per-tenant authority

## 1. Task

Make `syncViva` acquire a separate Yammer token per subscription
`tenantId` (with explicit MSAL authority), instead of one shared
`/common`-default token for all subs. Same root cause as the discover
fix of 2026-04-24: MSAL's `/common` resolves to the account's home IDP,
minting a Yammer token scoped to the home network only. Communities
in other Yammer networks return 0 messages silently.

## 2. Scope boundary

**In:** changes to
[../../../src/sync/sync-viva.ts](../../../src/sync/sync-viva.ts) and its
tests.

**Out:** schema changes, subscription-store changes, CLI changes,
discover changes. Subscriptions already carry `tenantId` (nullable,
added in slice 4b-2).

## 3. Design

1. Group `enabled` subs by `sub.tenantId ?? account.tenantId` (null
   tenantId = pre-4b-2 row, falls back to home tenant).
2. Per tenant group, acquire token:
   `auth.getTokenSilent(account, { scopes: [YAMMER_SCOPE], authority:
   vivaAuthorityFor(tenantId) })`. One call per tenant, not per sub.
3. If token acquisition fails for a tenant, record per-community
   errors for all subs in that group (non-hard-stop) and continue.
4. `syncOneCommunity` receives the tenant-scoped token.

`vivaAuthorityFor` is already exported from `src/cli.ts`. To avoid a
cyclic dep between cli and sync, move it to a shared module (e.g.
`src/auth/viva-authority.ts`) and re-export from cli.ts for
back-compat — OR inline the one-liner in sync-viva. Inline is simpler;
two call sites, no need for a module for 2 lines.

Actually: just import from `src/auth/msal-auth-client.ts` where the
matching `YAMMER_SCOPE` lives. New export `vivaAuthorityFor`. Update
cli.ts to import the shared version.

## 4. File map

**Touched:**

- [../../../src/auth/msal-auth-client.ts](../../../src/auth/msal-auth-client.ts) — export `vivaAuthorityFor`.
- [../../../src/cli.ts](../../../src/cli.ts) — re-export `vivaAuthorityFor` from msal-auth-client.
- [../../../src/sync/sync-viva.ts](../../../src/sync/sync-viva.ts) — per-tenant grouping + authority.
- [../../../src/sync/sync-viva.test.ts](../../../src/sync/sync-viva.test.ts) — new tests + token-key updates.

## 5. RED list

- **AC-ST (single tenant, explicit authority)**: one sub with
  `tenantId = account.tenantId`, `getTokenSilent` called once with
  `authority = vivaAuthorityFor(account.tenantId)`.
  - test name: `"syncViva requests token with explicit home-tenant authority"`
- **AC-MT (multi tenant, fan out)**: two subs with different
  tenantIds, `getTokenSilent` called twice (one per tenant, distinct
  authorities); each `listThreads` call uses the token scoped to its
  sub's tenantId.
  - test name: `"syncViva acquires a separate token per subscription tenantId"`
- **AC-FT (null tenantId falls back to home)**: sub with
  `tenantId: undefined`, `getTokenSilent` called with
  `authority = vivaAuthorityFor(account.tenantId)`.
  - test name: `"syncViva falls back to account tenant when subscription tenantId is missing"`
- **AC-TE (token-error isolation)**: `getTokenSilent` for tenant B
  throws `silent-failed`; subs in tenant A still sync normally; subs
  in tenant B appear in `perCommunity` with `error` set.
  - test name: `"syncViva isolates per-tenant token-acquisition failures"`

## 6. Risks

- Existing sync-viva tests use `authWithToken()` which keys the token
  on `homeAccountId` alone. Under the new code, the lookup will
  include an authority suffix. `FakeAuthClient` already falls back to
  the plain `homeAccountId` key when the authority-scoped key misses,
  so existing tests remain green. Verify.

## 7. Out-of-scope follow-ups

- Reject subscriptions whose `tenantId` is null on startup (migration
  to backfill tenantId from discover cache).
