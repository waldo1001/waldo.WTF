# Plan: force-refresh-on-401 retry in `syncViva`

## Context

The investigation at
[docs/investigations/viva-sync-401.md](../investigations/viva-sync-401.md)
closed on 2026-04-24 with a self-heal: one `Yammer 401` row at
09:04:18 followed by six clean ticks. Root cause was a stale
access token that MSAL held in the Yammer-clientId partition
after the slice-B deploy (commit b309967). The on-disk AT was
unexpired per its `exp` but no longer accepted by Yammer; one
tick later MSAL rotated it and sync succeeded.

**Goal.** Turn that "wait one tick" into "self-heal on the same
tick". When `/messages/in_group/{id}` returns 401, retry the
community once after re-acquiring the token with `forceRefresh`
set. A second 401 on the retry is treated as a genuine hard-stop,
same as today.

**Why this is worth shipping even though the investigation
self-healed.** Deploys and tenant-consent churn will keep
producing occasional stale ATs. Today each incident costs one
`sync_log` error row and up to one full sync-interval of
missed messages. The retry turns those into zero visible
failures and zero lost messages. Small blast radius, obviously
correct behavior, easy to test.

## Scope boundary

**In scope.**
- `GetTokenOptions` on `src/auth/auth-client.ts` gains an optional
  `forceRefresh?: boolean` flag.
- `MsalAuthClient.getTokenSilent` on `src/auth/msal-auth-client.ts`
  forwards `forceRefresh` to `pca.acquireTokenSilent`.
- The `MsalLikePca.acquireTokenSilent` seam signature gains the
  same optional flag so fake PCAs can assert it.
- `syncViva` in `src/sync/sync-viva.ts` wraps `syncOneCommunity`
  in a single-shot retry: on `TokenExpiredError` (the Yammer 401),
  re-acquire the token with `forceRefresh: true` (bypassing the
  per-run `tokenCache` for this tenant), retry the community once,
  and surface whatever happens next as the final result.
- Per-community error isolation is preserved — a retry that also
  401s fails only that community, not the whole account's viva
  pass. (Today a Yammer 401 is `isHardStop` and throws out of
  `syncViva` entirely. This change softens that for the first
  401 only.)

**Out of scope.**
- Retrying non-401 hard-stops (429 rate-limit stays as-is — it
  carries its own `Retry-After` contract and belongs to a
  different layer).
- Applying the same retry to Outlook / Teams sync. Those have
  different token lifetime semantics and have not produced
  stale-AT incidents. If they do, a follow-up plan extends the
  pattern.
- Changing `syncInbox` / `syncSent` / `syncTeams`.
- Any change to discover, `--add-account`, or external-tenant
  registration paths.
- Exposing a CLI flag to force-refresh all tokens (separate
  operator concern; not asked for).

## Files to touch

**Modified.**
- `src/auth/auth-client.ts` — add `forceRefresh?: boolean` to
  `GetTokenOptions`.
- `src/auth/msal-auth-client.ts` — forward the flag to the PCA;
  extend the `MsalLikePca` seam signature.
- `src/auth/msal-auth-client.test.ts` — cover the new flag
  forwarding.
- `src/sync/sync-viva.ts` — single-shot retry around
  `syncOneCommunity` when the thrown error is a
  `TokenExpiredError` originating from Yammer.
- `src/sync/sync-viva.test.ts` — new RED tests for the retry
  behavior (see RED list below).

**Created.** None. All behavior lives on existing seams.

## Seams we lean on

- **`AuthClient` fake** already exists in
  [src/testing/fake-auth-client.ts](../../src/testing/fake-auth-client.ts)
  (or wherever viva's current sync tests build theirs — confirm
  during FRAME). The fake needs to (a) accept `forceRefresh` in
  the options and (b) be scriptable to return different token
  strings on first call vs forceRefresh call, so the test can
  distinguish them.
- **`VivaClient` fake** — scriptable per-call responses. We need
  a variant that rejects call N with a 401 (`TokenExpiredError`)
  and succeeds call N+1. Likely already present in
  `src/testing/fake-viva-client.ts` or the sync-viva test file.
  Reuse, don't reinvent.
- **Clock** injected as today — no changes.

Every new test must hit these seams, never real MSAL or real
Yammer. Matches the "Graph is always faked" rule in
[CLAUDE.md](../../CLAUDE.md).

## RED test list

Each item is a single test that must fail with the initial shape
and go green on the smallest implementation.

1. **`GetTokenOptions.forceRefresh` is forwarded to MSAL** —
   given an `MsalAuthClient` with a fake PCA, calling
   `getTokenSilent(account, { forceRefresh: true })` results in
   `acquireTokenSilent` being invoked with
   `forceRefresh: true`. When omitted, `forceRefresh` is
   undefined in the PCA call (not `false` — preserve
   property-absence semantics matching how `authority` is
   handled at `msal-auth-client.ts:146`).

2. **`syncViva` retries a community once after a Yammer 401,
   using `forceRefresh: true`** — given an auth fake that returns
   `"stale-token"` on the first call and `"fresh-token"` only
   when `forceRefresh: true`, and a viva fake that 401s when
   called with `"stale-token"` and succeeds when called with
   `"fresh-token"`, `syncViva` completes with `added > 0` for the
   community (the fresh-token run is what the lake ingests).

3. **`syncViva` surfaces a second 401 as a per-community failure,
   not a whole-pass abort** — with an auth fake that always
   returns a stale token regardless of `forceRefresh`, and a viva
   fake that 401s every call, `syncViva` returns with
   `perCommunity[i].error` containing `Yammer 401` for the
   affected sub and does NOT throw. Other subs in the same pass
   still get attempted. This is the behavior change: today the
   first 401 throws out of `syncViva` entirely because
   `isHardStop(err)` is true.

4. **Retry is only triggered by `TokenExpiredError`** — with a
   viva fake that throws a `GraphRateLimitedError` (the 429
   path), `syncViva` re-throws it as today. No retry, no
   `forceRefresh` call. Preserves existing rate-limit handling.

5. **Retry is scoped to the offending community only** — with
   two enabled subs, sub A's first call 401s and its retry
   succeeds; sub B's single call succeeds. The auth fake sees
   exactly two token acquisitions with `forceRefresh: undefined`
   (for subs A and B — note sub A hits the per-run tokenCache
   via sub B, or each gets its own depending on tenantId) and
   exactly one with `forceRefresh: true` (for sub A's retry).
   The exact acquisition count per call may vary with the
   tokenCache seam; the test asserts what matters: one
   `forceRefresh: true` call, not two.

6. **Per-run `tokenCache` does NOT poison the retry** —
   `syncViva`'s internal `tokenCache: Map<tenantId, ...>` must
   bypass its cached value when retrying, otherwise the retry
   hands the same stale token to Yammer and fails again. The
   test script a scenario where sub A 401s, retry succeeds, then
   sub C (same tenantId as A) runs next; sub C must reuse the
   fresh token, not re-trigger a `forceRefresh`. (This rules out
   the naive fix of "always call with forceRefresh on retry and
   don't update the cache".)

7. **`sync_log` records success on same-tick self-heal** — the
   existing `sync-scheduler.test.ts` already asserts that
   `syncViva` success produces `status=ok` rows; add one case
   where the underlying viva fake 401s-then-succeeds and confirm
   the scheduler logs exactly one `status=ok` row, no `error`
   row. Proves the observable behavior: invisible self-heal.

## Implementation shape (drafted for scaffolding step)

```ts
// sync-viva.ts — inside syncViva, current inner loop:

for (const sub of enabled) {
  const tenantId = sub.tenantId ?? account.tenantId;
  const tokResult = await getTokenForTenant(tenantId);
  if (tokResult instanceof Error) { /* unchanged */ continue; }
  try {
    const res = await syncOneCommunity({ viva, token: tokResult.token, sub, store, subs, clock });
    // ... unchanged success path
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      // Same-tick self-heal: re-acquire with forceRefresh, replace the
      // per-run cache entry, retry the community ONCE.
      const fresh = await forceRefreshTokenForTenant(tenantId);
      if (fresh instanceof Error) { /* record per-community error */ continue; }
      try {
        const res = await syncOneCommunity({ viva, token: fresh.token, sub, store, subs, clock });
        // success path as above
      } catch (retryErr) {
        if (isHardStop(retryErr)) throw retryErr;  // 429 etc — propagate
        perCommunity.push({ communityId: sub.communityId, added: 0,
          error: retryErr instanceof Error ? retryErr.message : String(retryErr) });
      }
    } else if (isHardStop(err)) {
      throw err;  // 429 — unchanged
    } else {
      // other errors — unchanged per-community record
    }
  }
}
```

The `forceRefreshTokenForTenant` helper is a three-line cousin
of `getTokenForTenant` that skips the cache check, sets
`forceRefresh: true` on the call, and writes the result back into
`tokenCache` for any subsequent sub in the same tenant.

## Risks

- **`forceRefresh` in `@azure/msal-node`**: the option exists and
  is honored; verified by looking at the type definition imported
  at `src/auth/msal-auth-client.ts:2`. Still, confirm during
  GREEN by running the existing suite and watching for any
  MSAL-side surprise. The fake-PCA tests are the primary
  correctness gate.
- **Infinite retry if the retry itself 401s and we forget to
  catch**: guarded explicitly in the RED list (test #3).
- **Rate-limit interaction**: if Yammer returns 429 on the retry
  instead of 401, we re-throw (isHardStop). That is the right
  behavior — the scheduler's per-account 429 handling kicks in.
  Test #4 covers adjacent path.
- **Observable churn for operators**: a previously-error row in
  `sync_log` becomes an `ok` row with `messages_added > 0`. This
  is the desired change; no alerting is wired to the row count
  shape today. No risk.

## Definition of done

- All 7 RED tests are GREEN.
- Touched files meet the 90% line+branch threshold
  ([coverage-policy](../tdd/coverage-policy.md)).
- `/security-scan` clean — no token strings leaked into tests
  or logs.
- `/docs-update` has refreshed the changelog entry noting
  "viva sync self-heals stale Yammer tokens on the same tick".
- `docs/investigations/viva-sync-401.md`'s "Follow-on" section
  gets a pointer back to this plan's closing commit.

## Out of scope for this plan

- Tuning the per-run `tokenCache` eviction beyond the narrow
  retry path.
- Changing the `SyncScheduler`'s own hard-stop handling at the
  account level.
- Exposing `forceRefresh` to any caller other than `syncViva`'s
  internal retry path.
- Instrumentation / counters for how often the retry fires.
  (Valuable, but a separate MCP-side observability plan.)
