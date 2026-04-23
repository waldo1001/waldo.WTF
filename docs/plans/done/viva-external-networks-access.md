# Plan: Viva Engage external network access (redesign after Slice 3)

**Status**: in-flight, not started. Created 2026-04-23.
**Predecessor**: [viva-external-networks-via-yammer.md](done/viva-external-networks-via-yammer.md) (Slice 3 shipped; this plan is the follow-up after discovering the Slice 3 approach doesn't work for external/guest networks).

## 0. How to use this file

Paste this whole file into a fresh agent session. It contains everything needed
to build the fix without re-running the live-API investigation we already did.
Start with Slice 4a — it's small, ships independently, and improves discovery
for home networks too. Slice 4b is the bigger one and depends on 4a.

The investigation section (§1) is non-optional reading. Skipping it will cause
an agent to re-derive facts we already paid for with hours of probing.

---

## 1. Investigation findings (confirmed against the live Yammer API)

### 1.1 The problem Slice 3 didn't solve

After Slice 3 shipped, `--viva-discover --account eric.wauters@dynex.be` returned
`no viva communities visible to this account`. The user *can* see 11 "BC Partners | …"
communities in the Viva Engage web UI (microsoft.com network). The Yammer REST
client we shipped returned 0.

### 1.2 What we proved

Four live probes against `www.yammer.com/api/v1/*` using the production MSAL
token cache on the NAS, then a fresh tenant-specific token obtained via POC.
Full details in git history of this file if archaeology is needed — the facts
that matter:

1. **Yammer REST is tenant-scoped at the token level.** A token issued via MSAL
   `authority=common` for `eric.wauters@dynex.be` has Yammer access only in the
   Dynex bv network. `/groups.json?mine=1` returns `[]`. Adding
   `&network_id=<externalId>` does not help — still `[]`.
2. **`/api/v1/oauth/tokens.json` does NOT give multi-network tokens** in the
   M365 Viva Engage world. With a home-tenant token it returns exactly one
   token (for Dynex). Classic Yammer multi-network OAuth is dead here.
3. **Per-tenant MSAL auth works.** Using
   `authority=https://login.microsoftonline.com/<tenantId>/` with the device-code
   flow and signing in as the same Dynex user produces a Yammer token scoped to
   that external tenant. `/users/current.json` in that context shows
   `network_id=107 network_name=Microsoft guest=true aad_guest=true`.
4. **Our own Entra app registration is blocked by Microsoft's tenant.** It
   shows "Admin consent required". You being a Dynex admin doesn't help — the
   required admin is a Microsoft Corp admin. Dead end with our own client ID.
5. **The Azure CLI client ID (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) bypasses
   admin consent entirely.** It's a first-party Microsoft public client,
   pre-consented globally. Device-code completes with no consent screen.
6. **B2B guests in Yammer hit a server-side restriction:**
   - `/api/v1/groups.json?mine=1` → HTTP 403 `NOT_ALLOWED_FOR_AAD_GUEST`
   - `/api/v1/groups.json?network_id=<id>` → HTTP 403 (same)
   - This is Yammer business logic, not Entra. Non-guest home-tenant calls are
     not affected, but we should switch anyway — see 1.3.
7. **These endpoints DO work for guests** (Microsoft-tenant token + Azure CLI
   clientId + `eric.wauters@dynex.be` signed in):
   - `GET /api/v1/users/current.json?include_group_memberships=true`
     → object; `group_memberships` is an array with id/full_name/network_id of
     every community the user has joined. **This is the new discovery endpoint.**
   - `GET /api/v1/users/{id}/groups.json` → `{"groups":[<id>,<id>,…]}` (just
     the ids, less useful)
   - `GET /api/v1/search.json?search=<term>` → returns matching groups, threads,
     users across the network. Works for discovery-by-keyword, not needed here.
   - `GET /api/v1/messages/in_group/{id}.json` and `/messages/in_thread/{id}.json`
     (unchanged — these already power sync)

### 1.3 Why we switch discovery endpoints even for home tenant

`/users/current.json?include_group_memberships=true` is strictly better than
`/groups.json?mine=1` for our use case:
- Works for home-tenant users (we've tested both).
- Works for B2B guests (where `/groups.json` returns 403).
- One call returns all memberships (no pagination loop).
- No `mine=1` footgun — membership is the only thing returned, not
  suggested/popular groups.

The only downside is response size (user profile includes mugshot URLs etc.),
~20–50 KB per call. Discover is a rare operation; acceptable.

### 1.4 Concrete test data (use in fixtures)

Copy-paste-able for test fixtures. Keep these out of production code — they're
real identifiers. Fixtures under `src/**/__fixtures__/**` should still use
`example.invalid` placeholders; these IDs are for reading probes, plan context,
and manually verifying deployed behavior.

- **Microsoft tenant ID**: `72f988bf-86f1-41af-91ab-2d7cd011db47`
- **Azure CLI public client ID**: `04b07795-8ddb-461a-bbee-02f9e1bf7b46`
- **Eric's user id in Dynex Yammer**: `5468389377`
- **Eric's user id in Microsoft Yammer (guest)**: `6487586127872`
- **Dynex bv network id**: `240148481`
- **Microsoft Yammer network id**: `107` (permalink `microsoft.com`)
- **BC Partners Development network id (inside Microsoft tenant)**: `987267`
  (this is the Yammer "primary network" Eric's guest identity belongs to)
- **11 BC Partners group ids (all in network 107)**:
  - `238051221504` — BC Partners | MVPs
  - `251257815040` — BC Partners | Performance
  - `248182374400` — BC Partners | Development
  - `250127032320` — BC Partners | Governance, Administration and Security
  - `238051573760` — BC Partners | Localizations
  - `238049591296` — BC Partners | AI, Agents, and Copilot
  - `238049124352` — BC Partners | Microsoft Announcements
  - `238046830592` — BC Partners | Integrations
  - `248454381568` — BC Partners | Test Automation
  - `238064648192` — BC Partners | Application Functionality
  - `238058758144` — BC Partners | Cloud Migration

### 1.5 Sample response shapes

`GET /api/v1/users/current.json?include_group_memberships=true` (trimmed):

```json
{
  "type": "user",
  "id": 6487586127872,
  "network_id": 107,
  "network_name": "Microsoft",
  "full_name": "Eric Wauters",
  "email": "eric.wauters@dynex.be",
  "guest": true,
  "aad_guest": true,
  "group_memberships": [
    {
      "id": 238051221504,
      "full_name": "BC Partners | MVPs",
      "network_id": 107,
      "description": "A private Viva Engage group for Business Central MVPs..."
    }
    // … 10 more …
  ],
  "pending_group_memberships": [],
  "invited_group_memberships": []
}
```

The `group_memberships` entries have the same shape as the elements of the old
`/groups.json` response, modulo extra fields we don't care about. Parsing code
can be nearly identical.

---

## 2. Two slices

| Slice | What | Blocks home-network fix? | Blocks external-network fix? |
|-------|------|--------------------------|------------------------------|
| **4a** | Switch discovery endpoint from `/groups.json?mine=1` to `/users/current.json?include_group_memberships=true` | No — fixes it | Partial (guest 403 gone, but still can't reach external tenants) |
| **4b** | Per-tenant MSAL auth + Azure CLI client ID + token cache keyed by `(user, tenantId)` | N/A | Yes — the full fix |
| 4c (deferred) | Sync loop tenant awareness for subscribed external-network communities | N/A | Only matters once user subscribes to an external community |

**Order**: 4a → 4b → 4c. Each slice is one TDD cycle (4b may split into two; see
§4 Open Questions).

---

## 3. Slice 4a — user-memberships discovery endpoint

**Status**: shipped 2026-04-23. Left in this file for context; Slice 4b is the next open slice.

### 3.1 Task

Replace Yammer REST community discovery from `/groups.json?mine=1` (list-style,
blocked for AAD guests) to `/users/current.json?include_group_memberships=true`
(user-scoped, works for everyone).

### 3.2 Scope boundary

**IN:**
- `HttpYammerClient.listCommunities(token)` hits the new endpoint.
- Response parsing: extract `group_memberships` array, map to `VivaCommunity[]`
  using the same shape rules as today.
- `http-yammer-client.test.ts` updates reflecting new URL + response shape.
- Changelog bullet.

**OUT** (explicitly deferred to 4b or later):
- Auth changes (authority, client ID, per-tenant cache) — 4b.
- `discoverAllCommunities` structure changes — none needed; it already calls
  `listCommunities(token)` once and builds network-name map.
- Graph API fallback — not needed; Yammer REST works for guests via the new
  endpoint.
- Migration of already-stored `viva_subscriptions` — nothing to migrate; schema
  unchanged.
- Displaying `pending_group_memberships` / `invited_group_memberships` in
  `--viva-discover` output — see §3.6.

### 3.3 Files to touch

- `src/sources/http-yammer-client.ts` — `listCommunities` body: new URL, parse
  `group_memberships` nested array.
- `src/sources/http-yammer-client.test.ts` — update URL expectations and
  response fixtures.
- `docs/changelog.md` — one bullet: "Community discovery now uses
  `/users/current.json?include_group_memberships=true` instead of
  `/groups.json?mine=1` — works for AAD guests in external tenants and avoids
  the suggested-groups footgun."

Do **not** touch `VivaClient` interface, `FakeVivaClient`, or `discoverAllCommunities`
— the contract is unchanged.

### 3.4 Seams

- `http` (via `FetchLike` on `HttpYammerClient`).
- No fs, no msal, no store. Tests stay unit-level against the existing
  `scriptFetch` helper in the test file.

### 3.5 RED test list

Each bullet becomes one RED test. Write them in order, make each one green
before moving to the next.

- **AC1**: `listCommunities("tok")` calls
  `GET https://www.yammer.com/api/v1/users/current.json?include_group_memberships=true`
  with `Authorization: Bearer tok`.
  - file: `src/sources/http-yammer-client.test.ts`
  - test name: `"listCommunities hits /users/current.json?include_group_memberships=true with bearer"`
  - edges: baseline happy path; one group in the response
- **AC2**: Maps each `group_memberships[i]` → `VivaCommunity` with
  `id = String(group_memberships[i].id)`,
  `displayName = group_memberships[i].full_name`,
  `networkId = String(group_memberships[i].network_id)`,
  `description = group_memberships[i].description` (if present).
  - test name: `"maps group_memberships entries to VivaCommunity with string ids"`
  - edges: description present, description absent, multi-network (ids from
    multiple `network_id`s — Eric's real case)
- **AC3**: Empty `group_memberships` array returns empty `VivaCommunity[]`.
  - test name: `"returns empty array when group_memberships is empty"`
- **AC4**: Missing `group_memberships` key (defensive) returns empty.
  - test name: `"returns empty array when group_memberships key is absent"`
- **AC5**: `pending_group_memberships` and `invited_group_memberships` are
  **ignored** — they are not communities the user can read.
  - test name: `"ignores pending_group_memberships and invited_group_memberships"`
  - Reason: see §3.6.
- **AC6** (regression port): 401 → `TokenExpiredError`.
  - test name: `"maps 401 to TokenExpiredError"`
- **AC7** (regression port): 429 → `GraphRateLimitedError` with `Retry-After`
  header honored, default 6s when missing.
  - two tests, same names as existing.
- **AC8** (regression port): Bearer token never appears in thrown error
  messages (existing test, adapt to new endpoint).
  - test name: `"does not leak bearer token in error messages"`
- **AC9**: Numeric ids larger than 2^53 round-trip as exact decimal strings.
  - test name: `"community and network ids above 2^53 round-trip losslessly as strings"`
  - Reason: the existing `parseYammer` helper already does this for posts; we
    must keep it for community/network ids too. BC Partners group ids hover
    around 2.4 × 10¹¹ — well below 2^53 — but Microsoft tenant IDs and future
    ids could hit the boundary. One test, same mechanism as the existing
    `numeric message id >2^53 round-trips losslessly as string` in
    `http-yammer-client.test.ts`.

### 3.6 Open questions / assumptions

- **Q: Should `--viva-discover` also surface pending/invited memberships?**
  Assumption: **no**. Discover must list only communities the user can actually
  sync from. Pending/invited = no read access. If the user wants to see pending
  invites, that's a separate surface (`--viva-pending` maybe), out of scope.
  Flag this in chat; if confirmed, it stays out.
- **Q: Does the endpoint paginate?**
  Assumption: **no**. `group_memberships` is a single embedded array in the
  user object. Eric has 11; a Microsoft employee with hundreds would be a
  stress case but the array is returned in one shot. If we see truncation or
  a `more_available: true` marker in the real response, add pagination
  (documented as follow-up, not in 4a scope).
- **Q: Response size.** 36 KB for Eric's Microsoft-tenant user record. Mostly
  mugshot URL templates. No action needed; if it balloons past 500 KB for
  large tenants, add a follow-up to request a leaner projection.

### 3.7 Risks

- **Schema stability**: `group_memberships` has been a stable Yammer field for
  years. Low risk.
- **Response shape drift**: The `id` field in `group_memberships[]` entries may
  come through as a number (JSON double) rather than a digit-string. The
  existing `parseYammer` helper converts integer-valued JSON numbers to exact
  strings via the TC39 source-access reviver. Verify (AC9) — not a change in
  code, just a test.
- **One less call in the 404-handling matrix**: the existing pagination loop
  disappears. If the endpoint ever rate-limits on a cold call we now fail the
  whole discover. Acceptable — one call is simpler.

### 3.8 Out-of-scope follow-ups

- Pending/invited membership display.
- Paginated `group_memberships` fallback for large tenants.

---

## 4. Slice 4b — per-tenant auth with Azure CLI client ID

### 4.1 Task

Enable `--viva-discover`, `--viva-subscribe`, and `--viva-list` to work against
external Viva Engage tenants (where the user is a B2B guest) by:
1. Parameterizing MSAL `authority` per-tenant on the Viva auth path.
2. Using the Azure CLI first-party client ID for all Viva-scoped auth (avoids
   admin-consent walls in external tenants).
3. Keying the Viva token cache by `(username, tenantId)` so multiple tenants
   per account can coexist.
4. A new CLI flag: `--add-account --tenant <guid>` (runs device-code against
   that tenant's authority).
5. `--viva-discover` iterates across all authenticated tenants for the account
   and aggregates memberships.

### 4.2 Scope boundary

**IN:**
- `MsalAuthClient` accepts `authority` in its constructor options
  (`https://login.microsoftonline.com/<tenantId>/`), default unchanged
  (`/common/` or whatever it is today).
- Separate MSAL client instance (`MsalAuthClient`) used for Viva commands,
  constructed with the Azure CLI client ID. Outlook/Teams/WhatsApp paths keep
  the existing app registration — don't mix.
- Token cache: use MSAL's built-in home-account-id keying, which already
  includes tenant. Verify with a test; if MSAL collapses same-username-different-tenant,
  we add explicit disambiguation.
- New `--add-account --tenant <guid>` flag. GUID validation: must match
  `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`. Case-insensitive.
- `--viva-discover` enumerates all cached Viva accounts matching the
  `--account` username (one per tenant), calls `listCommunities` for each,
  merges results. The existing `discoverAllCommunities` helper becomes the
  per-tenant inner loop.
- Output columns: `community_id  network_id  network_name  tenant_id  display_name`
  (new `tenant_id` column for disambiguation when subscribing).
- `--viva-subscribe <communityId>` resolves across all tenants the same way
  Slice 3 resolves across networks. Colon form stays: `tenantId:networkId:communityId`
  (or `networkId:communityId` if unambiguous within a single tenant).
- `viva_subscriptions` schema gains a nullable `tenant_id TEXT` column.
  Migration adds it with `DEFAULT NULL`; existing rows backfill on next
  `--viva-subscribe` refresh, or stay NULL (treated as home tenant at read time).
- Docs: `docs/user-guide.md` adds an "External Viva Engage networks" section
  with the `--add-account --tenant <guid>` walkthrough.

**OUT** (explicitly deferred):
- Auto-discovery of tenant IDs from network permalinks. User supplies the GUID
  manually. A follow-up could parse `permalink` → DNS → tenant via
  `https://login.microsoftonline.com/<domain>/.well-known/openid-configuration`
  but that's polish.
- Sync loop tenant awareness (Slice 4c).
- Cross-tenant `--viva-list` output currently only knows one tenant — teach it
  to show all. (Small, could bundle; see Q below.)
- Changing the Outlook/Teams/WhatsApp client ID. They stay on the existing
  app registration.
- Deprecating the existing Dynex-tenant Yammer auth. Existing tokens keep
  working until they expire; new Viva auth flows use the Azure CLI client ID.
- Verified publisher / own-app-registration path. Relying on the Azure CLI
  client ID is acceptable for a personal tool; document the dependency.

### 4.3 Files to touch

- `src/auth/msal-auth-client.ts` — accept `authority` option; export
  `YAMMER_PUBLIC_CLIENT_ID` constant.
- `src/auth/msal-auth-client.test.ts` — new ACs for authority override.
- `src/auth/token-cache-store.ts` — probable no change, but verify MSAL keys
  by `(username, tenantId)` under the hood. If it collapses, we add a
  per-tenant cache file path.
- `src/auth/token-cache-store.test.ts` — new AC for multi-tenant coexistence.
- `src/auth/types.ts` — `Account` should already carry `tenantId` via MSAL's
  `AccountInfo`. Add it to our `Account` type if not already present.
- `src/cli.ts` — parse `--tenant <guid>` on `--add-account`; in viva command
  handling, resolve all cached accounts for the username and iterate.
- `src/cli.test.ts` — ACs for `--add-account --tenant`, `--viva-discover`
  aggregation, `--viva-subscribe` colon-with-tenant resolution.
- `src/store/viva-subscription-store.ts` — add `tenantId` column to insert/read
  paths (nullable).
- `src/store/viva-subscription-store.test.ts`.
- `src/store/schema.ts` (or wherever migrations live) — new migration:
  `ALTER TABLE viva_subscriptions ADD COLUMN tenant_id TEXT`.
- `docs/user-guide.md` — external-network auth walkthrough.
- `docs/setup.md` — if adding env var for Azure CLI client ID override, mention.
- `docs/changelog.md` — bullets for 4b.

### 4.4 Seams

- `msal` (primary): authority override, cache behavior.
- `store`: schema migration + insert path.
- `clock`, `fs`: unchanged.
- `http`: unchanged — `HttpYammerClient` already takes a token; we're just
  feeding it a tenant-specific token.

### 4.5 RED test list

Split into three blocks — auth, CLI integration, store. Roughly the order to
tackle them.

**Auth block** (`msal-auth-client.test.ts`, `token-cache-store.test.ts`):
- **AC1**: `new MsalAuthClient({ clientId, cacheStore, authority: "https://login.microsoftonline.com/<guid>/" })`
  passes the authority through to MSAL's `PublicClientApplication` constructor.
  - test name: `"constructs MSAL with the provided authority"`
- **AC2**: Default authority when not provided matches the existing value
  (don't break Outlook/Teams flow).
  - test name: `"defaults authority to <current-default> when not provided"`
- **AC3**: After `loginWithDeviceCode` against a tenant-scoped authority, the
  returned `Account` has `tenantId` equal to the authority's tenant GUID.
  - test name: `"returned Account carries the authority's tenantId"`
- **AC4**: `getTokenSilent(account, { scopes })` for a `(username, tenantA)`
  account does NOT return a token for `(username, tenantB)` cached separately.
  - test name: `"getTokenSilent isolates tokens by tenantId, not just username"`
  - If this test reveals MSAL does collapse identities: file follow-up to
    split cache files per tenant. For the first pass, assume MSAL keys
    correctly (home account id embeds tenant).
- **AC5**: Token cache survives adding a second tenant without evicting the
  first tenant's entries.
  - test name: `"adding a tenant-scoped account preserves existing home-tenant entries"`

**CLI block** (`cli.test.ts`):
- **AC6**: `--add-account --tenant <guid>` constructs the MsalAuthClient with
  `authority=https://login.microsoftonline.com/<guid>/` and runs device code.
  - test name: `"--add-account --tenant <guid> routes device-code to that tenant"`
- **AC7**: `--add-account --tenant bad-not-a-guid` rejects with `CliUsageError`.
  - test name: `"--tenant must be a valid GUID or CliUsageError is thrown"`
- **AC8**: `--add-account` without `--tenant` behaves identically to today
  (default authority).
  - test name: `"--add-account without --tenant uses default authority"`
- **AC9**: `--viva-discover --account <u>` enumerates all cached accounts
  matching `<u>` (one per tenant), calls `listCommunities` once per tenant,
  merges results.
  - test name: `"--viva-discover aggregates listCommunities across all cached tenants for the username"`
  - Fake: `FakeAuthClient` now returns multiple accounts for the same
    username (with different `tenantId`), `FakeVivaClient` scripted with one
    `listCommunitiesOk` per expected call.
- **AC10**: Output includes `tenant_id` as a column for disambiguation.
  - test name: `"reportVivaResult discover output prints tenant_id column"`
- **AC11**: `--viva-subscribe <tenantId>:<networkId>:<communityId>` resolves
  unambiguously.
  - test name: `"--viva-subscribe with tenantId:networkId:communityId resolves across tenants"`
- **AC12**: `--viva-subscribe <communityId>` without tenant prefix and the
  community exists in exactly one tenant: resolves.
  - test name: `"--viva-subscribe unambiguous community id resolves without tenant prefix"`
- **AC13**: `--viva-subscribe <communityId>` ambiguous across tenants: rejects
  with `CliUsageError` naming all candidate tenant:network pairs.
  - test name: `"--viva-subscribe ambiguous community across tenants throws CliUsageError"`
- **AC14**: Uses the Azure CLI public client ID (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`)
  for all `--viva-*` auth flows, distinct from the existing Outlook/Teams
  client ID.
  - test name: `"--viva-* commands use the Azure CLI public client ID for MSAL"`

**Store block** (`viva-subscription-store.test.ts`):
- **AC15**: Schema migration adds `tenant_id TEXT` nullable column. Existing
  rows get `tenant_id = NULL`.
  - test name: `"migration adds tenant_id column defaulting to NULL for existing rows"`
- **AC16**: `subscribe({ account, tenantId, networkId, communityId, … })`
  persists `tenantId`.
  - test name: `"subscribe persists tenantId"`
- **AC17**: `listForAccount(username)` returns subscriptions across all
  tenants (no filter).
  - test name: `"listForAccount returns subscriptions from all tenants for the username"`
- **AC18**: `unsubscribe(username, communityId)` with only a community id
  scopes by all tenants (existing behavior). With
  `unsubscribe(username, communityId, tenantId)` scopes by tenant too.
  - test name: `"unsubscribe accepts optional tenantId scope"`

### 4.6 Open questions / assumptions

- **Q: Does MSAL's default cache key scheme already disambiguate by tenant?**
  Assumption: **yes**. `homeAccountId` = `<oid>.<tenantId>`. Verify with
  AC4/AC5. If wrong, add an explicit tenant-specific cache file (each
  `TokenCacheStore` takes a path; call the viva cache `viva-<tenantId>-token-cache.json`).
- **Q: Should `--add-account --tenant` default to creating a Viva-scoped
  account (Azure CLI client ID) or respect the existing client?** Assumption:
  `--add-account` with `--tenant` is viva-only. Without `--tenant`, it's the
  original Outlook/Teams flow. Document this clearly — don't mix scopes.
  Alternative: split into `--viva-add-tenant <guid>` for clarity. Bundle
  vs. split is a judgment call; the flag name should make the scope obvious.
- **Q: Should `--viva-list` also show all tenants?** Yes, trivially — the
  store `listForAccount` returns all subscriptions regardless of tenant.
  Only the output column layout changes. Bundle into 4b (AC15–AC17 cover the
  store; CLI output is one more AC, not a separate slice).
- **Q: Azure CLI client ID dependency.** If Microsoft ever revokes it for
  third-party tools, we break. Mitigation: document the dependency in
  `user-guide.md` and in a code comment above the constant. Follow-up is
  verified-publisher registration for waldo.WTF itself.
- **Q: `viva_subscriptions.tenant_id NULL` semantics.** Read-side: treat NULL
  as "home tenant — use default authority". This lets pre-migration rows
  keep syncing without forcing re-subscribe. Document in the migration file.
- **Q: What happens to Slice 3's `--viva-subscribe networkId:communityId`
  colon form?** Still works when there's exactly one tenant with that network
  id (common case). Three-segment form `tenantId:networkId:communityId` is
  the escape hatch for ambiguity. Backward compatible.

### 4.7 Risks

- **MSAL cache corruption** if we get the tenant keying wrong. Mitigate with
  AC4/AC5; if fails, fall back to per-tenant cache files.
- **User confusion** about which client ID is in play for which command.
  Mitigate with a single clear code comment at each MsalAuthClient
  construction site citing *why* that client ID is chosen.
- **Existing subscriptions (if any)** break after migration if we accidentally
  filter out NULL `tenant_id` rows. Schema migration test covers this (AC15);
  listForAccount test covers the read side (AC17).
- **Azure CLI client ID consent pattern** is an open grey area. Not
  Microsoft-supported for third-party tools in writing, but widely used by
  CLI tools (e.g. `az`, various community tools). For a personal tool, fine.
  Document the caveat.
- **Stale external-tenant memberships**: user leaves a community on
  microsoft.com side, next `--viva-discover` simply drops it. No special
  handling needed — the current sync code already 404-handles gracefully.

### 4.8 Out-of-scope follow-ups

- Slice 4c: sync loop passes the tenant-specific token when fetching threads
  and posts for externally-subscribed communities.
- Tenant auto-discovery from `/networks/current.json` permalinks.
- `--viva-pending` to show invited/pending memberships.
- Verified publisher registration to run our own client ID.
- `--viva-remove-tenant <guid>` for users who want to stop syncing an external
  network without removing individual subscriptions.

---

## 5. Slice 4c (deferred; notes only)

Subscribed communities from external tenants need the sync loop to call
`listThreads` and `listPosts` with a tenant-specific token. Store already
carries `tenantId`; auth layer already resolves per-tenant tokens. The sync
loop currently takes one token per account. Two options:
1. **Per-subscription token resolution**: fetch token at iteration time based
   on `subscription.tenantId`. Simple, adds a silent-token call per community
   per sync tick; fine given current tick frequency.
2. **Pre-compute a tenant→token map at start of sync tick**: one silent-token
   call per tenant in use, reused for all subscriptions in that tenant.

Pick at implementation time. Option 2 is kinder to MSAL's cache but slightly
more plumbing.

Neither option is in 4a or 4b scope. Revisit after 4b ships.

---

## 6. What the fresh agent should do

1. Read §1 top to bottom.
2. Start the `/tdd-cycle` skill with `Slice 4a from docs/plans/done/viva-external-networks-access.md`
   as the argument. Post the FRAME, RED test list (copy from §3.5), get
   approval per the project's TDD discipline, then implement.
3. Ship 4a (security scan + docs update + commit).
4. Start `/tdd-cycle` for Slice 4b. 4b may feel too big for one cycle — if so,
   split into `4b-1 Auth block (§4.5 AC1–5)` and `4b-2 CLI+Store block
   (§4.5 AC6–18)`. Each sub-slice is then one cycle. Don't skip the RED list
   approval step.
5. Deploy via `/deploy-nas` after 4b ships. First post-deploy test:
   ```
   sudo docker compose run --rm waldo --add-account --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47
   ```
   (Sign in as `eric.wauters@dynex.be` — this registers Eric's guest identity
   in the Microsoft Viva Engage tenant.) Then:
   ```
   sudo docker compose run --rm waldo --viva-discover --account eric.wauters@dynex.be
   ```
   Expected: the 11 BC Partners communities from §1.4 appear alongside any
   home-tenant ones.
6. Eric subscribes:
   ```
   sudo docker compose run --rm waldo --viva-subscribe 238049591296 --account eric.wauters@dynex.be
   ```
   (or `107:238049591296` if disambiguation is needed). Slice 4c then needs
   to land before those subscriptions actually sync messages. If 4c isn't
   done yet, subscriptions are stored but idle — fine, user knows.

---

## 7. Security scan reminders specific to this slice

- **Never commit** the Azure CLI client ID as a secret. It's a public
  well-known identifier (documented in Microsoft CLI source). Treat as a
  normal constant, not a secret. Put a comment citing its provenance.
- **Never log** tenant-scoped bearer tokens. Existing log-hygiene rules
  cover this.
- **Never embed** real tenant IDs, user ids, or group ids from §1.4 in
  fixtures under `src/**/__fixtures__/**`. Use `example.invalid` and
  synthetic digits (`111111111111`). The §1.4 numbers are for plan context
  and live-probe verification only.
- After Slice 4b, the user will have a new cache file or new entries in
  the existing cache containing Microsoft-tenant Yammer tokens. Same
  rotation/revocation protocol applies.

---

End of plan. If this leaves anything ambiguous for a fresh agent, it's a bug
in this file — update before starting.
