# Plan — Teams channels multi-tenant fan-out

**Status**: open. Created 2026-04-25.
**Predecessors**:
- [done/teams-channels-overview.md](done/teams-channels-overview.md) — Phases 1-5 shipped 2026-04-25 (commit 6a57610), deployed 13:44Z.
- [done/viva-external-networks-access.md](done/viva-external-networks-access.md) — Slices 4b-2 + 4b-4 (Viva per-tenant fan-out + tenantId on subscriptions). Closest precedent.
- [done/sync-viva-per-tenant-authority.md](done/sync-viva-per-tenant-authority.md) — sync-side per-tenant token acquisition.

## 1. Background

Live test on the NAS at 13:44Z showed:

```
sudo docker compose run --rm waldo --account eric.wauters@dynex.be --teams-discover
→ AADSTS65001 admin consent required (tenant 72f988bf-86f1-41af-91ab-2d7cd011db47)
```

Root cause: `resolveCliAccount` in [src/cli.ts:1089](../../src/cli.ts) picks the
**first** cached `Account` whose `username` equals
`eric.wauters@dynex.be`. The MSAL cache contains entries for that username
under both the dynex.be tenant and the Microsoft tenant (the latter from
earlier Viva guest sign-ins under the Azure CLI public client ID, which
shares the same MSAL token-cache file). MSAL `listAccounts()` returns the
Microsoft-tenant entry first; `getTokenSilent` (with no authority override)
resolves to that account's home IDP and asks Microsoft tenant for
`ChannelMessage.Read.All`, which Microsoft Corp's tenant rightly refuses
without admin consent.

User wants `--teams-discover` to surface channels from tenants where the
admin consent IS granted (dynex.be) and gracefully skip tenants where it
isn't (microsoft.com), with one skip line per skipped tenant.

This is the same pattern Viva shipped in 4b-4: walk all cached accounts
matching the username, fan out per-tenant, isolate failures.

## 2. Task

Make `--teams-discover` and `--teams-subscribe` walk every cached MSAL
account matching the requested username, acquire one Teams token per
tenant with explicit `vivaAuthorityFor`-style authority, aggregate
discovered channels across tenants, isolate per-tenant errors, and
persist `tenant_id` on each subscription so the sync loop can keep
using the right token.

## 3. Scope boundary

**IN:**

- New helper `teamsAuthorityFor(tenantId)` (parallels `vivaAuthorityFor` —
  exact same body; export from `msal-auth-client.ts`).
- `discoverTeamsChannels` (currently in `cli.ts`) becomes a fan-out:
  `auth.listAccounts()` filtered by username, one
  `getTokenSilent(account, { scopes: TEAMS_CHANNEL_SCOPES, authority: teamsAuthorityFor(account.tenantId) })`
  call per matched account. Per-tenant errors don't bubble; they print one
  `skipped tenant <tenantId>: <reason>` line and the loop continues. If
  the failure looks like consent-required (`isConsentRequiredError`), the
  reason becomes `admin-consent required`.
- `DiscoveredChannel` gains `readonly tenantId: string` (always set —
  every channel is discovered under exactly one tenant).
- `realTeams` `subscribe` action uses the fan-out discover, accepts a
  three-segment `<tenantId>:<teamId>:<channelId>` form alongside the
  existing two-segment `<teamId>:<channelId>`. Ambiguity (same
  `teamId:channelId` in two tenants) → `CliUsageError` listing the
  candidate tenants.
- `teams_channel_subscriptions` schema gains nullable `tenant_id TEXT`
  column. NEW migration v15. NULL = legacy / pre-fix row.
- `TeamsChannelSubscription` and `AddTeamsChannelSubscriptionInput` gain
  optional `tenantId?: string`.
- `SqliteTeamsChannelSubscriptionStore.subscribe` persists `tenantId`.
- `reportTeamsResult` discover output adds a `tenant_id` column at the
  start of each row.
- `syncTeamsChannels` acquires a per-tenant token before calling
  `client.getChannelMessagesDelta`. Uses `sub.tenantId ?? account.tenantId`
  (NULL = treat as the running account's home tenant, matching how
  sync-viva handles legacy NULL rows). One `getTokenSilent` per tenant per
  sync tick (cached in a `Map<string, AccessToken | Error>`), errors
  isolated per-subscription via `perSubscription[].error`.
- Live re-verification on NAS: see §7.

**OUT** (deferred):

- A `--teams-add-tenant` flag analogous to `--viva-add-tenant`. Not
  needed: Teams users sign in to the project's app registration via
  `--add-account` once per tenant; the existing flow already populates
  the MSAL cache correctly. (Viva needed it because it switched
  client IDs to the public Azure CLI one.)
- Surfacing per-tenant `tenantId` in MCP tool responses
  (`get_recent_activity`, `search`). The store carries it; the read
  surface stays unchanged for now.
- Auto-backfill of `tenant_id` for existing subscription rows. The fix
  ships before any rows have ever stored a non-NULL value, so legacy
  treatment (NULL = home tenant) is a no-op for the user's current state.

## 4. Files to touch

**Touched:**

- [../../src/auth/msal-auth-client.ts](../../src/auth/msal-auth-client.ts) — export `teamsAuthorityFor`. Aliases `vivaAuthorityFor` body — they construct the same `https://login.microsoftonline.com/<id>/` URL — but a separate name keeps the call sites self-documenting and lets us evolve them independently. (Could also export a single `tenantAuthorityFor`; named separately for grep-ability.)
- [../../src/cli.ts](../../src/cli.ts) — `discoverTeamsChannels` becomes fan-out; `DiscoveredChannel` gains `tenantId`; `reportTeamsResult` adds column; `realTeams.subscribe` accepts 3-segment form; `parseTeamChannelKey` accepts an optional leading tenant segment.
- [../../src/cli.test.ts](../../src/cli.test.ts) — new tests, see §5.
- [../../src/store/types.ts](../../src/store/types.ts) — add `tenantId?: string` to `TeamsChannelSubscription` and `AddTeamsChannelSubscriptionInput`.
- [../../src/store/schema.ts](../../src/store/schema.ts) — `CURRENT_SCHEMA_VERSION = 15`; new `migrateV15(db)` that adds `tenant_id TEXT` if absent.
- [../../src/store/schema.test.ts](../../src/store/schema.test.ts) — new test for v15.
- [../../src/store/teams-channel-subscription-store.ts](../../src/store/teams-channel-subscription-store.ts) — insert/read paths handle `tenant_id`.
- [../../src/store/teams-channel-subscription-store.test.ts](../../src/store/teams-channel-subscription-store.test.ts) — new test for tenantId persistence.
- [../../src/sync/sync-teams-channels.ts](../../src/sync/sync-teams-channels.ts) — per-tenant token acquisition (mirrors `sync-viva` token cache map).
- [../../src/sync/sync-teams-channels.test.ts](../../src/sync/sync-teams-channels.test.ts) — new fan-out test.
- [../../docs/changelog.md](../../docs/changelog.md) — bullet.
- [../../docs/user-guide.md](../../docs/user-guide.md) — note on §5c about multi-tenant accounts.

## 5. RED test list (10 tests → ~1274 total)

Tackle in order. Each one fails before any production code is written.

### Block A — store + schema (3 tests)

- **AC1**: Schema migration v15 adds `tenant_id TEXT` column to
  `teams_channel_subscriptions`; existing v14 rows get `NULL`.
  - file: `src/store/schema.test.ts`
  - test name: `"migration 15 adds tenant_id column to teams_channel_subscriptions defaulting to NULL for existing rows"`
  - seam: store
  - edges: pre-existing v14 row keeps its other columns intact

- **AC2**: `SqliteTeamsChannelSubscriptionStore.subscribe({ tenantId, ... })`
  persists the `tenantId`; `listForAccount` and `listEnabledForAccount`
  return rows with the `tenantId` set. Subscribing without `tenantId`
  yields a row whose `tenantId` is `undefined`.
  - file: `src/store/teams-channel-subscription-store.test.ts`
  - test name: `"subscribe persists tenantId and reads it back; absent tenantId stays undefined"`
  - seam: store
  - edges: `tenantId` set / unset; round-trip via list

### Block B — discover fan-out (4 tests)

- **AC3**: `--teams-discover` calls `getTokenSilent` once per **distinct
  tenantId** among MSAL accounts whose `username` matches the requested
  account (case-insensitive), each with
  `authority = teamsAuthorityFor(<that tenantId>)`. Returned channels
  carry their tenant's `tenantId`.
  - file: `src/cli.test.ts`
  - test name: `"realTeams --teams-discover fans out across cached tenants and tags channels with tenantId"`
  - seam: msal + http
  - edges: two tenants, one channel each; verify two getTokenSilent calls
    with two distinct authorities; verify channels[].tenantId

- **AC4**: `--teams-discover` isolates per-tenant `silent-failed` /
  consent-required errors. Tenants that fail produce a single
  `skipped tenant <tenantId>: <reason>` print line; tenants that succeed
  return their channels. Reason for `isConsentRequiredError(err) === true`
  is `admin-consent required`; otherwise `err.message`.
  - file: `src/cli.test.ts`
  - test name: `"realTeams --teams-discover isolates per-tenant consent-required errors and surfaces them as skip lines"`
  - seam: msal
  - edges: one good tenant, one consent-required tenant; assert
    `prints` includes `skipped tenant <bad>: admin-consent required` and
    that the good tenant's channels still come through

- **AC5**: `--teams-discover` output (via `reportTeamsResult`) includes
  `tenant_id` as the first column in the discover table header and rows.
  - file: `src/cli.test.ts`
  - test name: `"reportTeamsResult discover output prints tenant_id as first column"`
  - seam: none (pure function over result shape)

- **AC6**: `--teams-discover` does NOT throw when ALL tenants fail; it
  returns an empty channels list and prints one skip line per tenant.
  (Today, a single-tenant failure throws `CliUsageError` — change is to
  isolate.)
  - file: `src/cli.test.ts`
  - test name: `"realTeams --teams-discover with every tenant failing returns no channels and prints one skip line per tenant"`
  - seam: msal
  - edges: two tenants, both fail; result.channels.length === 0; two skip lines

### Block C — subscribe + sync (3 tests)

- **AC7**: `--teams-subscribe <tenantId>:<teamId>:<channelId>` resolves
  unambiguously, persists `tenantId` on the row.
  - file: `src/cli.test.ts`
  - test name: `"realTeams --teams-subscribe with tenantId:teamId:channelId resolves the right tenant and persists tenantId"`
  - seam: store
  - edges: same `teamId:channelId` exists in two tenants; the colon-
    prefix picks the correct one

- **AC8**: `--teams-subscribe <teamId>:<channelId>` (two-segment) is
  rejected with `CliUsageError` when the same `teamId:channelId` appears
  in more than one tenant. Error message names the candidate tenants.
  - file: `src/cli.test.ts`
  - test name: `"realTeams --teams-subscribe ambiguous teamId:channelId across tenants throws CliUsageError naming candidates"`
  - seam: none

- **AC9**: `syncTeamsChannels` acquires a Teams token via
  `auth.getTokenSilent(account, { scopes: TEAMS_CHANNEL_SCOPES, authority:
  teamsAuthorityFor(sub.tenantId ?? account.tenantId) })` once per
  distinct tenant; each subscription's
  `client.getChannelMessagesDelta` call uses the matching tenant's token.
  Token-acquisition errors are isolated to the subscriptions in that
  tenant (`perSubscription[].error` set, other tenants sync normally).
  - file: `src/sync/sync-teams-channels.test.ts`
  - test name: `"syncTeamsChannels fans out across tenants and isolates per-tenant token failures"`
  - seam: msal + store + http
  - edges: 2 subs in tenant A (succeeds), 1 sub in tenant B (token
    silent-failed); A subs sync, B sub appears in perSubscription with
    error set; getTokenSilent called twice with two distinct authorities

### Block D — back-compat (1 test)

- **AC10**: `syncTeamsChannels` falls back to `account.tenantId` when a
  subscription row's `tenantId` is `undefined` (legacy / pre-v15 row).
  - file: `src/sync/sync-teams-channels.test.ts`
  - test name: `"syncTeamsChannels falls back to account.tenantId when subscription tenantId is missing"`
  - seam: msal
  - edges: one sub with `tenantId: undefined`; verify `getTokenSilent`
    called with `authority = teamsAuthorityFor(account.tenantId)`

## 6. Open questions / assumptions

- **Q: Where does the Microsoft-tenant cached entry come from in the
  Teams MSAL cache?** Likely a previous interactive sign-in. The fan-out
  doesn't care — it iterates whatever's in the cache. If the
  Microsoft-tenant entry vanishes after a cache shuffle, the user sees
  one fewer skip line. Acceptable.
- **Q: Should we deduplicate cached accounts that share `homeAccountId`
  but appear twice in `listAccounts()`?** MSAL doesn't return dupes in
  practice. Use a `Set<string>` keyed by `tenantId` to be safe.
- **Q: Is `tenantId` on `DiscoveredChannel` always present?** Yes — every
  channel is discovered through one tenant's token. No ambiguity, no
  optional. Existing tests must be updated to expect the new field.
- **Q: Does the existing single-tenant consent-required test
  ([cli.test.ts:2649](../../src/cli.test.ts:2649)) need updating?** Yes
  — the new behavior is "skip and continue", not "throw CliUsageError".
  Replace the assertion with the AC4 / AC6 expectations. The single-
  tenant-with-only-consent-failures case is exactly AC6.
- **Q: Migration order — should `tenant_id` precede or follow other
  columns?** SQLite ALTER TABLE always appends. No reorder; clients
  read by name (rowToSub).
- **Q: Token-cache map across sync ticks?** Per-tick, like sync-viva.
  Different tick = re-acquire silently from MSAL's cache. No cross-tick
  sharing.

## 7. Risks

- **Cache coherence**: if the user adds a Teams account to a new tenant
  mid-flight, the discover during the same process won't see it (we
  call `auth.listAccounts()` once per CLI invocation). Acceptable —
  CLI commands are short-lived.
- **Output column drift**: existing terminal/log scrapes will see a new
  first column. There's nothing in the test suite or live tooling that
  parses the discover output beyond eyeballs; low impact.
- **Migration test**: forgetting to bump `CURRENT_SCHEMA_VERSION` in the
  test file would be silent. Schema test for AC1 explicitly asserts
  v15.
- **Sync regression**: existing single-tenant sync tests must continue
  to pass. They use `FakeAuthClient.tokens` keyed by plain
  `homeAccountId`; the fake's authority-fallback already handles that
  (verified in `sync-viva` per the precedent plan).
- **Live verification**: deploy + run on the NAS. If dynex.be also
  rejects (unlikely — the user is admin there), the discover returns
  empty and the bug is real. Re-running with `--teams-discover` is
  read-only; safe to retry.

## 8. Out-of-scope follow-ups

- Backfill `tenant_id` on existing rows from the MSAL cache (one-shot
  CLI migration) — only useful if any rows ever shipped with NULL.
- MCP-surface `tenantId` for Teams messages (search/get_recent_activity).
- `--teams-add-tenant` flag for the symmetric "add this tenant for Teams"
  workflow if the user starts hitting cases where their cache doesn't
  contain a needed tenant.

## 9. Live re-verification

After `/security-scan` PASS, `/local-smoke` PASS, `/docs-update`, commit,
and `/deploy-nas`:

```
sudo docker compose run --rm waldo --account eric.wauters@dynex.be --teams-discover
```

Expected output:

```
... (header) tenant_id  team_id  team_name  channel_id  channel_name  membership
... (rows for dynex.be channels)
skipped tenant 72f988bf-86f1-41af-91ab-2d7cd011db47: admin-consent required
```

End of plan.
