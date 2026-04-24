# Plan — sync-viva uses Yammer public clientId auth

## 1. Task

Wire a Yammer-scoped `AuthClient` (using `YAMMER_PUBLIC_CLIENT_ID`)
into the `SyncScheduler` and pass it to `syncViva` so per-tenant
`getTokenSilent` calls succeed against the same MSAL cache partition
that `--add-account --tenant` and `--viva-discover` already write to.

## 2. Why now (failure observed)

Post-deploy of [sync-viva-per-tenant-authority](done/sync-viva-per-tenant-authority.md),
the viva-engage tick still logs `status=ok, messages_added=0` across
7 BC Partners subscriptions even though:

- `viva_subscriptions.tenant_id = 72f988bf-86f1-41af-91ab-2d7cd011db47`
  (correct Microsoft tenant) for all 7 rows.
- `--viva-discover` against the same account returns 11 Microsoft-network
  communities (proves the token path works under YAMMER_PUBLIC_CLIENT_ID).

Root cause: the scheduler uses the **main** `MsalAuthClient { clientId:
config.msClientId }` built in [src/index.ts:110-115](../../../src/index.ts),
while discover uses `buildDefaultVivaAuth` →
`MsalAuthClient { clientId: YAMMER_PUBLIC_CLIENT_ID }`
([src/cli.ts:613-622](../../../src/cli.ts)). MSAL's on-disk cache is
partitioned by clientId; the external-tenant refresh token only
exists under YAMMER_PUBLIC_CLIENT_ID.

`syncViva`'s `getTokenSilent` with `authority: vivaAuthorityFor(tenantId)`
under the main clientId therefore fails with `silent-failed`, the
per-tenant isolation swallows it as a per-community error with
`added: 0`, and the scheduler sees `r.added === 0` → writes
`status=ok, messages_added=0`.

## 3. Scope boundary

**In:**

- `SyncSchedulerDeps` gains optional `vivaAuth?: AuthClient`.
- `sync-scheduler.ts` passes `vivaAuth ?? auth` as the `auth` arg to
  `syncViva`.
- [src/index.ts](../../../src/index.ts) constructs the Yammer-clientId
  `MsalAuthClient` (shared `cacheStore`) and injects it as `vivaAuth`.
- Tests: new RED on sync-scheduler.test.ts asserting that when
  `vivaAuth` is provided, `syncViva` receives it; existing tests
  unchanged (fall back to `auth`).

**Out:**

- Outlook/Teams/inbox/sent auth — stays on main clientId.
- No schema change, no CLI change, no new migration.
- Error surfacing for per-tenant silent-failed is still "record as
  per-community error, continue." A follow-up slice could promote
  silent-failed to `status=error` in sync_log if the failure rate
  per-tenant exceeds a threshold, but that's out of scope here.

## 4. Design

1. Extract a small helper `buildVivaAuth(config)` (or inline
   equivalent) that mirrors [`buildDefaultVivaAuth`](../../../src/cli.ts)
   — `MsalAuthClient { clientId: YAMMER_PUBLIC_CLIENT_ID, cacheStore }`
   using the **same** `TokenCacheStore` instance the main `auth` uses.
   Single serialized cache file on disk, partitioned internally by
   clientId; both auth clients see writes from each other.
2. `SyncSchedulerDeps.vivaAuth?: AuthClient`. When present, the viva
   branch of the tick calls `syncViva({ ..., auth: vivaAuth, ... })`.
   When absent, falls back to `this.deps.auth` — keeps the tests
   that don't care about clientId partitioning green.
3. No change to `syncViva` itself — it already uses the passed auth
   correctly post yesterday's fix.

## 5. File map

**Touched:**

- [../../../src/sync/sync-scheduler.ts](../../../src/sync/sync-scheduler.ts)
  — add `vivaAuth?` to deps, use it for `syncViva`.
- [../../../src/sync/sync-scheduler.test.ts](../../../src/sync/sync-scheduler.test.ts)
  — RED test: when `vivaAuth` is provided, `syncViva` receives it.
- [../../../src/index.ts](../../../src/index.ts) — build Yammer-clientId
  `MsalAuthClient` sharing the existing `cacheStore`, inject as
  `vivaAuth`.

No change to [src/cli.ts](../../../src/cli.ts) (still uses its own
`buildDefaultVivaAuth`), [src/sync/sync-viva.ts](../../../src/sync/sync-viva.ts),
or tests of `syncViva` — those are correct as-is.

## 6. RED list

- **AC-VA (vivaAuth is honored)**: when `SyncSchedulerDeps.vivaAuth`
  is set, the viva branch of the tick calls `syncViva` with that
  AuthClient, not the main `auth`.
  - test name: `"SyncScheduler passes vivaAuth to syncViva when provided"`
  - fake strategy: two `FakeAuthClient` instances `mainAuth` and
    `vivaAuth`. Main auth scripted with a Graph token; viva auth
    scripted with a Yammer token + the per-tenant authority key.
    After `tick()`, assert `vivaAuth.calls` contains a `getTokenSilent`
    with the Yammer authority, and `mainAuth.calls` does NOT include
    a Yammer-scope call.

- **AC-FB (fallback to main auth)**: when `vivaAuth` is omitted, the
  viva branch still uses `this.deps.auth` (current behavior).
  - test name: `"SyncScheduler falls back to main auth for viva when vivaAuth not set"`
  - regression guard for existing scheduler callers/tests.

## 7. Risks

- **Double-login risk**: users who did `--add-account` before 4b-2
  have tokens only under main clientId, not YAMMER_PUBLIC_CLIENT_ID.
  Their viva sync will silent-fail per-tenant forever unless they
  re-run `--add-account --tenant <their-home-tenant>`. Mitigation:
  document in the changelog; this matches the 4b-2 upgrade note.
- **Cache file write-race**: two `MsalAuthClient` instances hitting
  the same `token-cache.json` concurrently. MSAL's cache plugin
  serializes via lockfile or atomic rename (check
  `TokenCacheStore`); verify no regression on write.
- **Startup cost**: constructing a second PCA adds one `new
  PublicClientApplication` call at boot. Negligible.

## 8. Out-of-scope follow-ups

- Promote repeated per-tenant silent-failed to `status=error` in
  sync_log so the operator sees the re-login hint instead of
  silent zeros.
- CLI command to list which `(username, tenantId)` pairs have a
  valid Yammer token cached, for diagnostics.
