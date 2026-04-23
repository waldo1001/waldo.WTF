# Plan: Viva external-tenant token acquisition (real fix)

**Status:** not started. Written as a fresh-agent handoff after
Slice 4b-3 ("cross-clientId listAccounts merge") shipped to production
and failed to make Microsoft-network communities visible. That fix was
based on a wrong mental model of MSAL's cache. This plan replaces it.

**Do not start coding until the Investigation section below makes sense
to you, then get explicit user approval of the plan.** The previous
agent session burned two deploys chasing the wrong model.

## 0. Read first (non-negotiable)

- [docs/plans/done/viva-external-networks-via-yammer.md](done/viva-external-networks-via-yammer.md) — Slice 4b-2, the path that proved Yammer REST works when the token is Microsoft-tenant-scoped.
- [docs/plans/done/viva-cross-clientid-account-resolution.md](done/viva-cross-clientid-account-resolution.md) — Slice 4b-3. This is the **wrong** approach this plan replaces. Read it so you understand what is being reverted and why.
- [src/auth/msal-auth-client.ts](../../src/auth/msal-auth-client.ts) — MSAL adapter. `MsalLikePca.acquireTokenSilent` currently has no authority override.
- [src/auth/auth-client.ts](../../src/auth/auth-client.ts) — public `AuthClient` interface. `GetTokenOptions` takes `scopes?` only.
- [src/cli.ts](../../src/cli.ts) — look at `buildRealVivaAuth` (line ~911), `vivaAuthorityFor` (line 183), `addAccount` (line 925), `buildDefaultVivaAuths` (line 623), `discoverForAccount` (line 696), and `resolveVivaAccountPairs` (line 657). These are the touch points.

## 1. Investigation: ground truth from production

Pasted from the live NAS token cache after `--add-account --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47` succeeded for `eric.wauters@dynex.be`:

```
Account records: 4
  - home_account_id=<eric-oid>.d61c0367-…   realm=d61c0367-…   username=eric.wauters@dynex.be
  - home_account_id=<waldo-oid>.d61c0367-…  realm=d61c0367-…   username=waldo@dynex.be
  - …two others, all realm = the account's HOME tenant…

Refresh tokens: 5
  - client_id=<config.msClientId>  home_account_id=<eric-oid>.d61c0367-…   (Graph)
  - client_id=04b07795-8ddb-…      home_account_id=<eric-oid>.d61c0367-…   (Azure CLI — the one we need)
  - …three others…
```

**The load-bearing facts:**

1. MSAL creates Account records **keyed by home tenant only**. `--add-account --tenant 72f988bf-…` does NOT produce a new Account record with `realm=72f988bf-…`. It produces an additional **refresh token** under the Azure CLI client_id, keyed to the user's existing home-tenant homeAccountId.
2. Refresh tokens are **tenant-agnostic** in MSAL's storage. The authority used at silent-acquisition time determines which tenant the refresh token is redeemed against.
3. Therefore: to get a Microsoft-tenant-scoped Yammer token silently, the shape is
   ```
   pca.acquireTokenSilent({
     account: <eric's HOME-tenant account>,
     scopes: [YAMMER_SCOPE],
     authority: "https://login.microsoftonline.com/72f988bf-…/",
   })
   ```
   We own the home account (it's in the cache). We own the refresh token (it's in the cache under Azure CLI client_id). We are missing only the authority override at read time.

**POC proof (from user's earlier smoke chat, verbatim recipe that works):**

- `clientId = 04b07795-8ddb-461a-bbee-02f9e1bf7b46` (Azure CLI public first-party)
- `authority = https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/`
- `scopes = ["https://api.yammer.com/user_impersonation"]`
- Call `GET https://www.yammer.com/api/v1/users/current.json?include_group_memberships=true` with the resulting bearer.
- Response: **11 BC Partners groups in network_id=107**, all the ones Eric cares about.

The HTTP client already does this; the Yammer endpoint already works. The gap is purely in the **auth layer**: nothing today calls `acquireTokenSilent` with a per-request authority, so silent-acquisition always resolves to the home tenant and the returned token can only see home-tenant networks.

## 2. Why Slice 4b-3 was wrong

Slice 4b-3 assumed the cache was **partitioned by clientId** such that `--add-account --tenant` created a separate Account record under the Azure CLI clientId's partition, and that `listAccounts()` on the Graph-clientId `PublicClientApplication` therefore couldn't see it. The fix merged results across two `MsalAuthClient` instances (Graph clientId + Azure CLI clientId).

That premise does not match the cache dump. **Every Account record has `realm = home tenant`** — Azure CLI clientId or not. There is no separate per-external-tenant Account record to find. Merging `listAccounts()` across clientIds deduplicates to exactly the same home-tenant account it started with. The discover path then silent-acquires against the default authority (`common`), which resolves to the home tenant, which is why Eric sees his Dynex networks only — the Microsoft token never enters the picture.

Slice 4b-3's code is dead weight dressed as a fix. It must be removed, not built on.

## 3. Scope boundary

**In scope (this plan):**

1. Sidecar store for external-tenant registrations, written at `--add-account --tenant <guid>` time and read at `--viva-discover` time.
2. Extending `AuthClient.getTokenSilent` with an optional `authority` in `GetTokenOptions`, plumbed through `MsalAuthClient` to `pca.acquireTokenSilent`.
3. Rewiring `--viva-discover` to iterate (home account, plus each registered external tenant) for the target username, silent-acquiring with the per-tenant authority and stamping discovered communities with `tenantId`.
4. Reverting Slice 4b-3's `buildDefaultVivaAuths` cross-clientId merge and the `auths?: readonly AuthClient[]` field on `VivaDeps`. The Viva path collapses back to a **single** `MsalAuthClient(clientId=YAMMER_PUBLIC_CLIENT_ID)` whose cache contains both the home-tenant refresh token (created if the user ever logs in under Azure CLI clientId) and the external-tenant refresh token (created by `--add-account --tenant`). **If** the cache only has the Graph-clientId refresh token for the home account — i.e. the user never added their home tenant under Azure CLI clientId — the Viva path cannot silent-acquire. That case is handled in Slice C below.
5. Rewriting the misleading changelog bullet from Slice 4b-3 (the "hotfix" bullet described a fix that does not fix anything). Keep the Slice 4b-2 bullet intact.
6. Tests, ≥90% coverage on touched files, `/security-scan` clean, `/docs-update`. Per [CLAUDE.md](../../CLAUDE.md).

**Out of scope (do not expand):**

- Writing our own token exchange. MSAL handles it; we just call it with the right authority.
- Multi-user-per-refresh-token cases. Each registration is `(username, homeAccountId, externalTenantId)`; we do not try to cross-match.
- Removing external-tenant registrations. `--remove-account` stays as it is; if it becomes relevant, it is a follow-up slice.
- Supporting networks for tenants where the user is **not** a guest. The POC proved guest-in-external works; the home-tenant case already works via Yammer REST once the home-tenant Yammer scope is on the refresh token.
- Changing the schema. The sidecar is a JSON file next to `token-cache.json`. Promoting it to SQLite is a future slice if we ever need queries over it.
- Touching Graph/Teams/Outlook. This is Viva-only.

## 4. File map

**Files added:**

- `src/auth/viva-external-tenants-store.ts` — tiny reader/writer for `auth/viva-external-tenants.json`.
  - Shape: `{ registrations: ReadonlyArray<{ username: string; homeAccountId: string; externalTenantId: string }> }`.
  - Methods: `list()`, `add(reg)` (idempotent on `(homeAccountId, externalTenantId)`), constructor takes `{ fs, path }` — same seam pattern as [src/auth/token-cache-store.ts](../../src/auth/token-cache-store.ts).
- `src/auth/viva-external-tenants-store.test.ts` — unit tests against `FakeFileSystem` ([src/testing/fake-file-system.ts](../../src/testing/fake-file-system.ts)).

**Files modified:**

- [src/auth/auth-client.ts](../../src/auth/auth-client.ts) — add `authority?: string` to `GetTokenOptions`.
- [src/auth/msal-auth-client.ts](../../src/auth/msal-auth-client.ts):
  - Add `authority?: string` to the `MsalLikePca.acquireTokenSilent` request type.
  - In the real adapter, forward it to `real.acquireTokenSilent({ ..., authority })`.
  - In `getTokenSilent`, forward `options?.authority` into the call.
- [src/testing/fake-auth-client.ts](../../src/testing/fake-auth-client.ts) — record `authority` on the `getTokenSilent` call so tests can assert on it. Scripted token map becomes keyed by `(homeAccountId, authority ?? "__default__")` so a test can script different tokens for different authorities.
- [src/cli.ts](../../src/cli.ts):
  - `addAccount`: after a successful `--tenant` login, write a registration to the new store.
  - `buildDefaultVivaAuths`: delete. Replace with a single `buildDefaultVivaAuth(config)` that returns one `MsalAuthClient(clientId=YAMMER_PUBLIC_CLIENT_ID)` over the shared token cache.
  - `VivaDeps.auths`: delete. Restore `auth?: AuthClient`. Add `externalTenantsStore?` for test injection.
  - `resolveVivaAccountPairs`: delete. Replace with `resolveVivaAccount` (single account) — the per-tenant loop lives in `discoverForAccount` instead and is driven by the external-tenants store, not by merging `listAccounts` across clients.
  - `discoverForAccount`:
    1. Resolve the single home-tenant `Account` for the target username via `auth.listAccounts()`.
    2. Call `auth.getTokenSilent(account, { scopes: [YAMMER_SCOPE] })` for the home tenant; discover; stamp with `tenantId = account.tenantId`.
    3. Read `externalTenantsStore.list()`, filter by `homeAccountId === account.homeAccountId`.
    4. For each registration, call `auth.getTokenSilent(account, { scopes: [YAMMER_SCOPE], authority: vivaAuthorityFor(reg.externalTenantId) })`; discover; stamp with `tenantId = reg.externalTenantId`.
    5. Union & dedupe by `(tenantId, communityId)`.
- [src/cli.test.ts](../../src/cli.test.ts):
  - Delete the two Slice 4b-3 tests ("aggregates listCommunities across multiple clientId-partitioned auth clients" and "dedupes an account that appears in both auth caches") — they encode the wrong model.
  - Add the tests in Slice C below.
- [docs/changelog.md](../changelog.md) — see §7 below.

**Files unchanged:**

- `src/sources/yammer.ts`, `src/sources/http-yammer-client.ts`, `src/sources/viva.ts` — they already take a bearer and call the right endpoint. No change.
- `src/sync/sync-viva.ts`, `viva_subscriptions` schema — `tenant_id` column exists, sync picks it up from subscription rows.

## 5. Slices (three RED→GREEN cycles)

### Slice A — External-tenants store (seam + I/O)

RED list:

- AC1: empty store returns `[]`.
  - test file: `src/auth/viva-external-tenants-store.test.ts`
  - test name: `"list() on an uninitialized path returns empty"`
- AC2: `add()` persists through a round-trip.
  - test name: `"add() writes the registration; a fresh instance reads it back"`
- AC3: `add()` is idempotent on `(homeAccountId, externalTenantId)`.
  - test name: `"adding the same (homeAccountId, tenantId) twice stores one record"`
- AC4: the on-disk JSON is stable-sorted so `git diff` is clean.
  - test name: `"registrations serialize in a stable order"`

Seam: `fs`. No Graph, no MSAL. Use `FakeFileSystem` from `src/testing/`.

Edge case — malformed JSON: treat as empty + log a warning. Write a test that seeds the file with `"{"` and asserts `list()` returns `[]` and a warning was logged. Do NOT throw — this file sits next to the token cache and a parse blowup here would brick `--viva-discover` forever.

### Slice B — `AuthClient.getTokenSilent` authority override

RED list:

- AC5: `FakeAuthClient.getTokenSilent` records `authority` on the call log.
  - test file: `src/testing/fake-auth-client.test.ts`
  - test name: `"records authority on the call log when provided"`
- AC6: `FakeAuthClient` can script different tokens for different authorities on the same account.
  - test name: `"returns a different scripted token per authority"`
- AC7: `MsalAuthClient.getTokenSilent` forwards `authority` to the PCA.
  - test file: `src/auth/msal-auth-client.test.ts` (already exists)
  - test name: `"forwards authority option to acquireTokenSilent"` — uses a fake `MsalLikePca` and asserts the arg.
- AC8: No regression: calls without `authority` still work (default-authority path).
  - test name: `"omits authority when option is absent"`

Seam: MSAL (already faked via `MsalLikePca`). No network.

### Slice C — Wire `--viva-discover` to external tenants

RED list:

- AC9: `--viva-discover --account <user>` with a single external-tenant registration yields the home communities **and** the external-tenant communities, each stamped with the correct `tenantId`.
  - test file: `src/cli.test.ts`
  - test name: `"--viva-discover fans out across registered external tenants with per-tenant authority"`
  - Fake setup: `FakeAuthClient` scripts two tokens for Eric's home account — one under default authority ("home-token"), one under `vivaAuthorityFor("72f988bf-...")` ("ms-token"). `FakeVivaClient` returns `[communityHome]` for "home-token" and `[communityMs]` for "ms-token". Assert the output contains both, with `tenantId` values of `d61c0367-...` and `72f988bf-...` respectively.
- AC10: No external-tenant registrations → discover behaves exactly as Slice 4b-1 (home-only).
  - test name: `"--viva-discover without external-tenant registrations only discovers home networks"`
- AC11: `--add-account --tenant <guid>` appends a registration to the store.
  - test name: `"--add-account --tenant records an external-tenant registration"`
  - Inject a fake store via `opts`; assert `store.list()` contains the new record after the call.
- AC12: Silent fails for an external-tenant authority → discover continues with the other tenants and surfaces a warning (single bad tenant doesn't break the whole discover).
  - test name: `"a failing external-tenant silent acquisition is logged and skipped"`

Edge cases to cover with named tests:
- `homeAccountId` mismatch between store and listAccounts (user removed the account without calling `--remove-account`): the registration is ignored with a warning.
- The same `(username, externalTenantId)` appearing across multiple users (not today, but the store is keyed by `homeAccountId` not `username` for exactly this reason).

## 6. Step-by-step implementation order (for the fresh agent)

1. `/tdd-cycle` Step 0.5 — **re-read this plan in full**, then post FRAME + RED list before any code.
2. Slice A end-to-end (RED → GREEN → REFACTOR → COVER) on the store.
3. Slice B on the auth layer. Run full suite after each GREEN; no ship yet.
4. Slice C on the CLI. This is where the Slice 4b-3 tests get deleted and the `buildDefaultVivaAuths`/`auths?` fields go away.
5. After all three are green: `npm test -- --coverage` on touched files, confirm ≥90% lines and branches.
6. `/security-scan`. The fake fixtures must use `example.invalid`, NOT real tenant GUIDs. The real GUIDs (`72f988bf-...`, `d61c0367-...`) can appear in *docs* and *this plan* but **never in `src/**/__fixtures__/`, snapshots, or production logs**.
7. `/docs-update` — changelog + plan archive (this plan moves to `docs/plans/done/viva-external-tenant-token-acquisition.md`).
8. `/local-smoke` before deploy.
9. `/deploy-nas` (routine, no `--migrate`).
10. Post-deploy smoke: `sudo docker compose run --rm waldo --viva-discover --account eric.wauters@dynex.be`. Expected: both Dynex networks AND the 11 BC Partners communities in network_id=107, each with the correct `tenant_id` column in the output.

## 7. Changelog revert guidance

The Slice 4b-3 changelog bullet currently describes a fix that does not
fix anything. When this plan ships, don't add a third "Slice 4b-x" bullet
next to the broken one — rewrite the Slice 4b-3 bullet so history doesn't
lie:

- Grep [docs/changelog.md](../changelog.md) for the 2026-04-22/23 Slice 4b-3 bullet.
- Replace it with a single line along the lines of:
  `Identified external-tenant token-acquisition gap; see [viva-external-tenant-token-acquisition.md](plans/viva-external-tenant-token-acquisition.md) for the real fix.`
- Then add today's Slice 4b-4 bullet describing the three-slice landing.

The git history of the wrong fix stays (we don't force-push to rewrite), but the changelog — which is what readers trust — tells the truth.

## 8. Risks

- **MSAL silent-acquisition against an authority the refresh token has never seen.** If `--add-account --tenant 72f988bf-…` was run with Azure CLI clientId + Microsoft authority, MSAL stored a refresh token that has already been redeemed against that authority once. Silent-acquisition with the same authority should succeed. But if the sequence is unusual (e.g. cache corruption, expired refresh token, consent revoked in Entra), silent will fail and AC12's warn-and-skip path kicks in. Test it.
- **Home-tenant refresh token under Azure CLI clientId may not exist.** Eric's cache has one because the `--add-account --tenant` path happens to use Azure CLI clientId + an authority *derived from* `--tenant`. If a user only ever ran `--add-account` (no `--tenant`), their home account exists under `config.msClientId` only, and the Viva `MsalAuthClient(YAMMER_PUBLIC_CLIENT_ID)` cannot find it. Slice C must surface a clear error in this case: "account X has no Yammer-scope refresh token, run `--add-account --tenant <home-tenant-guid>` to grant it." Do not silently fall through.
- **Regression on Slice 4b-2 smoke.** The Slice 4b-2 deploy proved home-tenant Yammer discovery works via the current cross-clientId merge. When we remove the merge, the home-tenant path still has to work — via the single Azure-CLI-clientId `MsalAuthClient`. Write AC10 explicitly; don't just assume.
- **Wrong authority format.** `login.microsoftonline.com/<guid>/` (trailing slash) is what MSAL wants; without it, MSAL sometimes silently re-resolves to `common`. `vivaAuthorityFor` already has the trailing slash — don't "clean it up" during refactor.

## 9. Out-of-scope follow-ups (so they don't get lost)

- `--remove-account` should also remove external-tenant registrations for that account.
- An MCP tool to list external-tenant registrations (so users can see which tenants they've opted into via Claude).
- Promote `viva-external-tenants.json` to a SQLite table if we ever need queries over it.
- Dedupe `buildRealVivaAuth` and the new `buildDefaultVivaAuth` — they construct nearly the same thing with/without an authority override.

## 10. Acceptance for "this plan is done"

- `--viva-discover --account eric.wauters@dynex.be` on the live NAS lists the Microsoft network's 11 BC Partners communities, each row showing `tenant_id=72f988bf-86f1-41af-91ab-2d7cd011db47`, alongside Eric's existing Dynex networks.
- `npm test` is green, `npm test -- --coverage` is ≥90% lines and branches on every touched file.
- `/security-scan` passes with no real GUIDs in `src/`.
- The changelog's 2026-04-22/23 bullet for Slice 4b-3 has been rewritten to reflect reality; a fresh bullet for this slice is added.
- This plan file lives at `docs/plans/done/viva-external-tenant-token-acquisition.md` with every inbound link updated.
