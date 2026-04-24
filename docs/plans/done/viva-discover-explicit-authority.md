# Plan — fix --viva-discover against external tenants (for real this time)

## 1. Task

Make `--viva-discover --account <u>` list external-tenant Yammer
communities that a live POC script (see 2026-04-24 user paste)
demonstrates are reachable.

## 2. Scope boundary

**In:** three surgical changes to `discoverForAccount` in
[../../src/cli.ts](../../src/cli.ts):

1. Home discover passes `authority = vivaAuthorityFor(account.tenantId)`
   explicitly instead of relying on MsalAuthClient's `/common` default.
2. External-tenant registrations are matched by **username**
   (case-insensitive) instead of `homeAccountId`.
3. If a registration's `externalTenantId` equals the home account's
   `tenantId`, the registration is skipped (we already covered it under
   home discover).

**Out:** clientId partitioning, separate auth clients, home-tenant
account discovery. The POC proves: given one `YAMMER_PUBLIC_CLIENT_ID`
account per tenant in the cache, one token per authority lists its
communities. Nothing else.

## 3. Why each fix

1. **Explicit authority**: POC token (authority=`/72f988bf/`) places user
   in `network_id=107` (Microsoft) and `/users/current.json?include_group_memberships=true`
   returns 11 BC Partners groups. App token (authority=`/common`, account
   tenantId=72f988bf) apparently resolves to the user's Azure AD home
   (Dynex), so `/users/current.json` returns 0 memberships in the wrong
   network. The POC's working pattern is *explicit tenant authority*.

2. **Username keying**: `--add-account --tenant X` stores the
   newly-logged-in guest's `homeAccountId`. `resolveVivaAccount` may
   return a different account. Comparing `reg.homeAccountId ===
   account.homeAccountId` therefore fails. Username is the stable key
   across MSAL's cache shuffles.

3. **Dedupe**: avoids listing the same communities twice when the
   account's home tenant coincides with a registered external tenant
   (e.g. user ran `--add-account --tenant <their-own-home>` by mistake).

## 4. File map

**Touched:**

- [../../src/cli.ts](../../src/cli.ts) — `discoverForAccount` body.
- [../../src/cli.test.ts](../../src/cli.test.ts) — update the three
  existing Slice 4b-4 tests to reflect new matching + authority, add
  one regression test.

**Unchanged:**

- [../../src/auth/viva-external-tenants-store.ts](../../src/auth/viva-external-tenants-store.ts) — shape stays.
- [../../src/auth/msal-auth-client.ts](../../src/auth/msal-auth-client.ts) — authority override already works.
- [../../src/sources/http-yammer-client.ts](../../src/sources/http-yammer-client.ts) — endpoint is already correct.

## 5. RED list

- **AC-HA (home authority)**: `discoverForAccount` calls
  `auth.getTokenSilent(account, { scopes: [YAMMER_SCOPE], authority:
  vivaAuthorityFor(account.tenantId) })` for the home fetch.
  - test name: `"--viva-discover passes explicit account-tenant authority on home fetch"`
- **AC-MU (match by username)**: a registration whose `homeAccountId`
  differs from the resolved account's `homeAccountId` but whose
  `username` matches is still used for fan-out.
  - test name: `"--viva-discover matches registrations by username, not homeAccountId"`
- **AC-DD (dedupe)**: a registration with `externalTenantId ===
  account.tenantId` does NOT cause a second call (no duplicate "Found N
  network(s)" line).
  - test name: `"--viva-discover skips registrations that duplicate the home tenant"`

## 6. Risks

- MSAL may still return an unexpected token even with explicit authority
  if the account's refresh token was minted under `/common`. If AC-HA
  doesn't change live behavior, the fallback is: force a fresh
  device-code flow on first `--viva-discover` per tenant. Not doing
  that in this slice — try the cheap fix first.

## 7. Out-of-scope follow-ups

- `--add-account` (no tenant) into YAMMER_PUBLIC_CLIENT_ID cache so
  home-tenant Yammer discovery also works. Currently out of scope
  because the POC doesn't care about this path.
- `--remove-account` cleanup of stale registrations.
