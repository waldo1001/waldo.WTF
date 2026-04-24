# Investigation — viva-engage sync 401 after clientId-partition fix

Date: 2026-04-24
Status: **closed** — self-healed; see Outcome below

## Symptom

After deploying commit b309967 (scheduler uses `YAMMER_PUBLIC_CLIENT_ID`
`MsalAuthClient` for viva token acquisition), `sync_log` for
`eric.wauters@dynex.be` / `viva-engage` flipped from:

- **Before** — `status=ok, messages_added=0` (silent swallow).
- **After**  — `status=error, error_message="Yammer 401"`.

Example post-deploy row (09:04:18):

```
2026-04-24 09:04:18 | eric.wauters@dynex.be | viva-engage | error | | Yammer 401
```

`--viva-discover --account eric.wauters@dynex.be` continues to return 11
Microsoft-tenant communities from the same NAS. So:

- Yammer cache under `YAMMER_PUBLIC_CLIENT_ID` **does** hold valid
  refresh tokens for this username.
- A token acquired through `discoverForAccount` **is** accepted by
  `www.yammer.com/api/v1`.
- A token acquired through `SyncScheduler → syncViva` is **rejected**
  by Yammer with 401.

So we are acquiring *a* token from the Yammer cache — but it's the
wrong token.

## Known non-cause

Prior hypothesis "main clientId has no external-tenant refresh token"
is confirmed fixed: Slice B (b309967) routes viva sync through the
Yammer-clientId `MsalAuthClient`, and the error surface changed from
`silent-failed` → `Yammer 401`. If the token acquisition were still
silent-failing under the wrong clientId, we'd see `status=ok,
messages_added=0` per prior behavior, not a 401. So the clientId
partition is no longer the issue.

## Hypothesis

`syncViva` receives the `Account` object from
`SyncScheduler.runOnce()`, which calls `this.deps.auth.listAccounts()`
— the **main** `MsalAuthClient { clientId: config.msClientId }`.
The returned `Account` has:

- `username` = `eric.wauters@dynex.be`
- `tenantId` = `<home-tenant-guid>`
- `homeAccountId` = `X` — set by MSAL from the main-clientId cache's
  ID token.

That `Account` is then passed to `vivaAuth.getTokenSilent(account,
{ authority: vivaAuthorityFor(sub.tenantId) })`. MSAL's
`acquireTokenSilent` uses `account.homeAccountId` to locate a cached
refresh token in the target clientId's partition.

The Yammer-clientId cache for `eric.wauters@dynex.be` was populated
only by `--add-account --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47`
(Slice 4b-2's flow). That device-code login created an MSAL `Account`
entry with a **different** `homeAccountId` — let's call it `Y` —
because MSAL derives `homeAccountId` from the ID token's `oid.tid`,
and the external-tenant login returns a guest-tenant-scoped ID token.

So:

- Main clientId cache has `Account { homeAccountId: X, tenantId: home }`.
- Yammer clientId cache has `Account { homeAccountId: Y, tenantId: 72f988bf }`.
- `X ≠ Y`.

When scheduler calls `vivaAuth.getTokenSilent({ homeAccountId: X, ... },
{ authority: vivaAuthorityFor(72f988bf) })`, MSAL searches the Yammer
cache for `homeAccountId: X`. It may:

- Find nothing → throws `silent-failed`. **But we see 401, not
  silent-failed.** So this branch is ruled out, unless MSAL is
  "fuzzy-matching" by username across accounts.
- Find a partial hit by username → returns a token minted under some
  other cached session (possibly the home-tenant session if Yammer
  clientId cache also carries that, or the external-tenant session
  with wrong scopes). Yammer rejects as 401.

`discoverForAccount` avoids this by calling
`buildDefaultVivaAuth(config).listAccounts()` — i.e. resolving the
username against the **Yammer clientId's** account cache. That returns
`Account { homeAccountId: Y, tenantId: 72f988bf }`. When it later
calls `getTokenSilent` with the same account and any authority, MSAL
has a matching cache entry to redeem against.

**Prediction**: replacing `account` in `syncViva`'s `getTokenSilent`
call with a Yammer-cache-resolved account (for each sub's `tenantId`)
will succeed; the sync_log row will flip from `Yammer 401` →
`ok, messages_added > 0`.

## Experiments to run

Each is a one-liner invoked inside the NAS (operator paste), designed
to produce ground truth without code changes. Order matters — later
experiments depend on facts established by earlier ones.

### E1 — Enumerate MSAL accounts in each clientId partition

Purpose: confirm that the Yammer clientId cache holds an `Account`
for eric.wauters, and that its `homeAccountId` differs from the main
clientId's entry.

`token-cache.json` under `data/auth/` is the on-disk MSAL serialized
cache. Inspect it directly — it's a JSON blob with clientId-keyed
sections.

```sh
sudo cat /volume1/docker/waldo-wtf/auth/token-cache.json \
  | python3 -m json.tool \
  | grep -E '"(home_account_id|tenant_id|client_id|username|realm|environment)"' \
  | head -80
```

Expected: two `Account` entries for `eric.wauters@dynex.be`,
differing in `realm` (tenant) and `home_account_id`. One under
`client_id = <config.msClientId>`, one under
`client_id = 04b07795-8ddb-461a-bbee-02f9e1bf7b46`
(`YAMMER_PUBLIC_CLIENT_ID`).

If we see **only one** entry (main clientId) and none for Yammer
clientId, the real problem is that `--add-account --tenant` never
actually wrote to the Yammer cache on this box — and discover
somehow works anyway via a different path. Would need a full rethink.

### E2 — Confirm discover-path token acquisition inside the
running container

Purpose: reproduce the known-working path, using the **same** container
image and cache file, to establish a baseline.

```sh
sudo docker exec waldo-wtf \
  node --experimental-strip-types /app/src/cli.ts \
  --viva-discover --account eric.wauters@dynex.be \
  2>&1 | head -30
```

Expected: list of ~11 Microsoft-tenant communities. If this fails in
the container but works when the operator runs it locally, there's a
container-env divergence we didn't know about.

### E3 — Reproduce the syncViva token-acquisition path in isolation

Purpose: take the exact `auth.listAccounts()` path the scheduler
uses, pair it with the `vivaAuth.getTokenSilent(account, { authority:
<microsoft> })` call, and observe whether we get 401 from Yammer.

The cleanest way to do this is a one-off `tsx` script that:

1. Loads `Config`.
2. Constructs the main `MsalAuthClient { clientId: config.msClientId, cacheStore }`.
3. Constructs the viva `MsalAuthClient { clientId: YAMMER_PUBLIC_CLIENT_ID, cacheStore }`.
4. `const accounts = await mainAuth.listAccounts();`
5. For the eric account, call
   `vivaAuth.getTokenSilent(account, { scopes: [YAMMER_SCOPE], authority: vivaAuthorityFor("72f988bf-86f1-41af-91ab-2d7cd011db47") })`.
6. Use the returned token to `GET www.yammer.com/api/v1/users/current.json`
   and print `status + (first 200 bytes of body)`.
7. Then repeat (5)-(6) with the **viva-cache-resolved** account
   (`vivaAuth.listAccounts()` picking the one with `tenantId=72f988bf`).

Expected:

- Step 6 → 401 (reproduces the bug).
- Step 7 → 200 with `{"id":..., "network":{"id":...}}`.

If Step 7 also 401s, hypothesis is wrong and we need to look
elsewhere (e.g. Yammer scope mint, not identity).

### E4 — One-off smoke: does the hypothesized fix work?

If E3 proves the prediction, the next concrete question is whether the
fix pattern plugs cleanly into `syncViva`. Build a second one-off
script that:

1. Instantiates `HttpYammerClient`.
2. Resolves the correct account from `vivaAuth.listAccounts()` for
   one sub's `tenantId`.
3. Acquires the token (Step 7 pattern from E3).
4. Calls `yammer.listThreads(token, <BC Partners community id>, { olderThan: undefined })`
   and prints thread count + first 3 topics.

Expected: non-zero threads. This is the bar — if we can list threads
from a BC Partners community, the scheduler fix will work in-prod.

If this fails, the fix is more involved than the account-resolution
change.

## Decision points driven by experiment output

- **E1 shows only main-clientId account** → new investigation: why
  did `--add-account --tenant` not persist? Slice B is then
  insufficient; the root fix is upstream.
- **E3 Step 6 succeeds** → hypothesis is wrong; token acquisition
  isn't the identity-mismatch issue. Investigate Yammer scope or
  audience instead.
- **E3 Step 7 succeeds + E4 succeeds** → write the plan. The fix is
  "resolve sub's tenant to an account via `vivaAuth.listAccounts()`,
  fall back gracefully if missing".
- **E4 fails with a new error** → record and re-enter investigation.

## Out of scope for this investigation

- Fix design, coverage strategy, error-surface improvements. Those
  belong in the plan that comes AFTER this investigation reaches a
  green E4.
- Changes to `discoverForAccount` — it works today; don't touch.
- Whether `homeAccountId` partitioning is the "right" model
  long-term. Accept MSAL's behavior; adapt to it.

## Follow-on: whatever we learn here gets recorded

When the investigation closes (either fix verified or hypothesis
invalidated), append a `## Outcome` section at the bottom summarising
what was proven, and link to the plan file that turns the finding
into a shipped change.

---

## Update 2026-04-24 — E1 results and revised hypothesis

### E1 outcome

Running the cache dump on the NAS produced exactly **one** `Account`
record for `eric.wauters@dynex.be`:

```
home_account_id: af7fc1c6-870c-4dbb-9b96-19b38a061750.d61c0367-b31d-4f6b-ab32-7fbb2e1c2772
realm:          d61c0367-b31d-4f6b-ab32-7fbb2e1c2772    # dynex.be home tenant
username:       eric.wauters@dynex.be
```

Under `client_id = 04b07795-8ddb-461a-bbee-02f9e1bf7b46`
(YAMMER_PUBLIC_CLIENT_ID) there **are** separate refresh-token
entries per realm — one in `d61c0367` (home) and one in
`72f988bf-86f1-41af-91ab-2d7cd011db47` (Microsoft). But the `Account`
table itself is keyed by `home_account_id` and is **not partitioned
by clientId**.

Consequence: `mainAuth.listAccounts()` and `vivaAuth.listAccounts()`
return the same `Account` object for eric, with
`homeAccountId = af7fc1c6-...-d61c0367` and `tenantId = d61c0367`.
The scheduler and discover pass identical `(account, authority)`
pairs to MSAL.

### The original hypothesis is therefore wrong

The homeAccountId-mismatch story cannot be the cause — there is no
mismatch to observe. Whatever differs between discover (works) and
sync (401) must be somewhere other than the MSAL cache partition.

### E2 also needs a correction

The original E2 `node --experimental-strip-types` invocation fails in
the container with `Cannot find module '/app/src/config.js'` — the
strip-types loader does not rewrite `.js` specifiers to resolve
`.ts`. The container actually runs
`node_modules/.bin/tsx src/cli.ts` (see `Dockerfile` ENTRYPOINT), so
the correct invocation is:

```sh
sudo docker exec waldo-wtf \
  node_modules/.bin/tsx src/cli.ts \
  --viva-discover --account eric.wauters@dynex.be 2>&1 | head -30
```

E2 is still useful as a container-env baseline; rerun with the
corrected command.

### Revised hypothesis — `sub.tenantId` is NULL for eric's row

`src/sync/sync-viva.ts:215`:

```ts
const tenantId = sub.tenantId ?? account.tenantId;
```

If the `viva_subscriptions` row for eric's Microsoft-tenant community
(BC Partners, network `72f988bf`) has `tenant_id IS NULL`, the
fallback yields `account.tenantId = d61c0367` (dynex.be home), and
`vivaAuthorityFor` builds the **home-tenant** authority. MSAL
happily redeems against the Yammer-clientId home-tenant refresh
token that we saw in E1 and returns a valid home-network Yammer
token. That token is then used to call
`/messages/in_group/{Microsoft-network-communityId}.json`, which
Yammer 401s because Yammer access tokens are **network-scoped** and
a home-network token cannot read Microsoft-network groups.

The discover path escapes this trap because it only ever calls
user-centric endpoints (`/networks/current.json`,
`/users/current.json?include_group_memberships=true`) which surface
cross-network memberships and do not enforce per-network access on
the token.

The tenantId-propagation logic in `discoverForAccount` is recent
(`cb43760`, `10da925`); eric's subscription was likely created
before that landed, with `tenant_id = NULL` in SQLite.

### Revised experiments

Run in order. E2b and E3b replace E2/E3 from the original plan;
E1 is preserved for history.

#### E2b — inspect eric's subscription row on the NAS

This is the single cheapest way to falsify or confirm the revised
hypothesis. Read-only SQLite query against the running DB:

```sh
sudo docker run --rm -v /volume1/docker/waldo-wtf/db:/db keinos/sqlite3 \
  sqlite3 "file:/db/lake.db?immutable=1" \
  "SELECT account, network_id, community_id, tenant_id, enabled
   FROM viva_subscriptions
   WHERE account='eric.wauters@dynex.be';"
```

Expected if revised hypothesis holds: at least one row with
`tenant_id IS NULL` (or the literal string `NULL`), and
`network_id` referring to a Microsoft Yammer network (not the
dynex.be one).

If every row has a non-null `tenant_id` matching its network's
tenant, the revised hypothesis is wrong and we investigate token
audience/scope next.

#### E3b — verify by minting both tokens and calling `/messages/in_group`

One-off tsx script to run inside the container. Mints (a) a
home-tenant Yammer token and (b) a Microsoft-tenant Yammer token
using the Yammer-clientId PCA, then calls the group-messages
endpoint for eric's subscribed Microsoft community with each token
and prints `status + (first 200 bytes of body)`.

Expected under revised hypothesis:
- home-tenant token → 401
- Microsoft-tenant token → 200 with a `messages` array

If both 401, the revised hypothesis is also wrong (token audience is
fine; something else — scope, consent, account eligibility — is
rejecting both). If both 200, the observed sync 401 is from some
other code path we haven't identified; look at `sync_log` timing vs
subscription churn.

This is the concrete point at which we either lock in the fix
(backfill `tenant_id` on existing rows + guard against NULL in
`syncViva`) or re-open the investigation.

### Revised decision points

- **E2b shows `tenant_id IS NULL` for eric's Microsoft community**
  → revised hypothesis is very likely correct; run E3b to seal it,
  then move to the fix plan (backfill migration + no-NULL guard).
- **E2b shows correct `tenant_id` on all rows** → revised hypothesis
  is wrong; investigate Yammer token audience / consent next.
- **E3b home-token 401 + MS-token 200** → confirmed. Write the plan.
- **E3b MS-token also 401** → deeper issue; record and re-investigate.

---

## Update 2026-04-24 #2 — E2b disproves tenant_id=NULL hypothesis

### E2b outcome

```
eric.wauters@dynex.be|107|238051221504|72f988bf-86f1-41af-91ab-2d7cd011db47|1
eric.wauters@dynex.be|107|251257815040|72f988bf-86f1-41af-91ab-2d7cd011db47|1
eric.wauters@dynex.be|107|248182374400|72f988bf-86f1-41af-91ab-2d7cd011db47|1
eric.wauters@dynex.be|107|238049591296|72f988bf-86f1-41af-91ab-2d7cd011db47|1
eric.wauters@dynex.be|107|238049124352|72f988bf-86f1-41af-91ab-2d7cd011db47|1
eric.wauters@dynex.be|107|238046830592|72f988bf-86f1-41af-91ab-2d7cd011db47|1
eric.wauters@dynex.be|107|238064648192|72f988bf-86f1-41af-91ab-2d7cd011db47|1
```

All 7 subscription rows carry `tenant_id = 72f988bf-...` (Microsoft).
The fallback at `sync-viva.ts:215` never fires. The scheduler IS
requesting a token against
`authority = https://login.microsoftonline.com/72f988bf-.../`.

### What we now know

- E1 ruled out: the homeAccountId-mismatch story. MSAL's `Account`
  table is keyed by `home_account_id` alone — main and Yammer PCAs
  return the same Account.
- E2b ruled out: the tenant_id-NULL story. All of eric's subs are
  correctly tagged with the Microsoft tenant.
- Pre-b309967 vs post-b309967 behavior comparison:
  - **Pre**: main-clientId PCA had no Yammer RT → MSAL threw
    `silent-failed` → caught in `getTokenForTenant` → stored per
    community → `SyncVivaResult.added = 0` → scheduler logged
    `status=ok, messagesAdded=0`. **Silent swallow explained.**
  - **Post**: Yammer-clientId PCA has a Yammer RT under
    `realm=72f988bf` → MSAL returns a fresh AT →
    `yammer.listThreads` → `/messages/in_group/{id}` → HTTP 401 →
    `TokenExpiredError("Yammer 401")` → `isHardStop` → thrown up →
    scheduler logs `status=error, errorMessage="Yammer 401"`.

So the slice-B fix exposed a deeper problem: **the Microsoft-authority
Yammer AT is being issued by AAD but rejected by Yammer's group
endpoint**.

### Why discover still appears to work

Discover never calls `/messages/in_group/{id}`. It calls:
- `/networks/current.json` — resolves the token's network and
  returns that single network's metadata.
- `/users/current.json?include_group_memberships=true` — returns
  the user's cross-network group memberships.

The second endpoint surfaces Microsoft-network groups even when the
caller's token is for a different network. That is how eric's subs
were discovered. It says nothing about whether the token can
actually read those groups — and `/messages/in_group/{id}`
enforces strict network-scope.

### Third hypothesis — Yammer AT issued against `/72f988bf/` authority is still home-network-scoped

For a B2B guest identity, AAD honors the resource-tenant authority
for token issuance, but the resulting Yammer token's network claim
(`nid`) may be determined by the *home-network* of the signed-in
user, not the resource-tenant. In that case, the AT looks correct
to AAD but Yammer rejects `/messages/in_group/{MS-community-id}`
because the token's `nid` points at dynex.be's Yammer network, not
Microsoft's network 107.

If this is true, the working flow needs a different account entry
— one whose `home_account_id` is anchored in the Microsoft tenant
— to mint a Microsoft-network Yammer token. The `--add-account
--tenant 72f988bf` device-code flow creates refresh tokens under
`realm=72f988bf`, but MSAL still keys the Account by the user's
home tenant (`d61c0367`), so there isn't a separate "guest-in-MS"
Account to use.

This is a **plausible** explanation but NOT proven yet. E3b is the
definitive test.

### E3b — repro script (to write, then paste into container)

A one-off tsx script that:

1. Loads `Config` via the real loader.
2. Builds the Yammer-clientId PCA (mirrors `buildDefaultVivaAuth`).
3. Resolves eric's `Account` via `listAccounts()`.
4. Acquires a Yammer AT against
   `vivaAuthorityFor("72f988bf-86f1-41af-91ab-2d7cd011db47")`.
5. Prints:
   - AT's decoded JWT header + non-sensitive claims (`aud`, `iss`,
     `tid`, `scp`; skip `upn`/`oid`/`unique_name` to keep the log
     safe).
   - `GET /networks/current.json` status + first 200 bytes
     (reveals which Yammer network the token resolves to).
   - `GET /users/current.json?include_group_memberships=true`
     status + count of `group_memberships`.
   - `GET /messages/in_group/238051221504.json?threaded=extended`
     status + first 200 bytes (reproduces the 401).
6. Then re-runs (5)'s last call with a token acquired against the
   **home** authority `vivaAuthorityFor("d61c0367-...")` for
   comparison.

Expected under the third hypothesis:
- Microsoft-authority AT: `/networks/current.json` returns network
  ID ≠ 107, or returns home-network metadata. `/messages/in_group`
  → 401.
- Home-authority AT: same outcome or worse.

If `/networks/current.json` with the Microsoft-authority AT
actually returns network 107 but `/messages/in_group` still 401s,
the problem is narrower — likely a missing Yammer-specific consent
or that group's ACL. Record and investigate.

### Decision points (this round)

- **E3b shows MS-auth token resolves to home network** → third
  hypothesis confirmed. Fix requires a different token-minting
  strategy (e.g. Yammer-specific scope against the resource tenant
  with a resource-tenant-anchored account, or OAuth-on-behalf-of
  via Graph). New investigation branch.
- **E3b shows MS-auth token resolves to network 107 but
  `/messages/in_group` still 401s** → Yammer-side ACL / consent.
  Check whether the community requires additional per-group
  membership the token doesn't carry.
- **E3b shows `/messages/in_group` returns 200** → sync has a bug
  elsewhere (e.g. token is being regenerated mid-flight with a
  different tenantId, or the sub's communityId is stale). Look at
  live scheduler behavior next.

---

## Outcome (2026-04-24)

**E3b and the follow-up sync_log query closed the investigation.**
Slice B (commit b309967) is functioning correctly. The 401 was a
one-shot.

### E3b result

Both the MS-authority and home-authority token acquisitions returned
identical valid tokens (MSAL returned the same cached AT to both
calls, same `iat`/`exp`/`nonce`). Decoded claims:

```
tid:   72f988bf-86f1-41af-91ab-2d7cd011db47  (Microsoft)
aud:   https://api.yammer.com
scp:   user_impersonation
appid: 04b07795-8ddb-461a-bbee-02f9e1bf7b46  (YAMMER_PUBLIC_CLIENT_ID)
idp:   sts.windows.net/d61c0367-...-6286/    (home-IDP for guest — normal)
idtyp: user
```

All three Yammer endpoints returned 200:
- `/networks/current.json` → network `107` ("Microsoft")
- `/users/current.json?include_group_memberships=true` → eric's
  membership list in network 107
- `/messages/in_group/238051221504.json?threaded=extended` → real
  thread data

The third hypothesis (MS-authority token being home-network-scoped)
is **also wrong**. The token is correctly Microsoft-network-scoped
at mint time, and Yammer accepts it on the group endpoint.

### sync_log follow-up

```
2026-04-24 09:37:23|ok|515|
2026-04-24 09:25:53|ok|515|
2026-04-24 09:22:30|ok|515|
2026-04-24 09:08:53|ok|583|     ← first successful viva sync post-deploy
2026-04-24 09:04:18|error||Yammer 401
2026-04-24 08:54:20|ok|0|       ← last pre-deploy silent-swallow
```

One 401, then the very next tick (~4.5 min later) succeeded and
pulled 583 messages. Every tick since is `ok`.

### What the 401 actually was

Most likely: the on-disk Yammer-clientId cache held an access token
minted during an earlier `--add-account --tenant` or
`--viva-discover` run, minted with properties that Yammer accepted
for user-centric endpoints but rejected for `/messages/in_group`.
When the first post-slice-B scheduler tick fired, MSAL returned
that cached AT (still unexpired per its `exp`). One tick later, the
AT had rotated and everything worked.

This is consistent with the fact that `/users/current.json` and
`/networks/current.json` have historically accepted tokens that
`/messages/in_group` will reject — those user-centric endpoints
resolve the user cross-network, while group endpoints enforce
network scope strictly. A token minted for the wrong network
could pass the first pair and fail the third.

We cannot reconstruct the exact bad AT after the fact (MSAL has
since rotated the cache). So the root cause is "stale AT in the
Yammer-clientId cache at the moment Slice B started running" —
resolved by natural cache rotation.

### Follow-on (shipped 2026-04-24)

Shipped under [plans/done/viva-sync-force-refresh-on-401.md](../plans/done/viva-sync-force-refresh-on-401.md).
`syncViva` now force-refreshes the Yammer token and retries the
offending community once on `TokenExpiredError`; stale-AT episodes
self-heal on the same tick instead of waiting for the next one, and
a second 401 is a per-community error rather than a whole-pass
abort. See the 2026-04-24 changelog entry.

### Artifacts cleaned up

- `scripts/viva-sync-401-repro.ts` — deleted. The one-off tsx
  script served its purpose. If future 401s recur, the heredoc
  payload is preserved in this document's conversation history
  and can be resurrected.
