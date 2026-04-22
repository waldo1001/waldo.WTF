# Plan: Wire `--viva-discover` and `--viva-subscribe` to a real VivaClient in the CLI

## Task

Make `--viva-discover` and `--viva-subscribe <communityId>` actually work
in production against Microsoft Graph, so the operator can bootstrap a
Viva subscription without SQL surgery.

## Context — why this is needed

The add-viva-engage-source slice shipped all plumbing — CLI flag
parsing, `VivaCommand` type, `VivaCliResult` type, result-formatting in
`reportVivaResult`, `HttpVivaClient` adapter, `SqliteVivaSubscriptionStore`,
scheduler integration, docs — but the CLI's production default path for
`subscribe` and `discover` throws:

```ts
// src/cli.ts:588-595 (current)
case "subscribe":
case "discover":
  // Discover + subscribe-validation require a live VivaClient; they go
  // through the injected vivaImpl in tests, and through main() in
  // production once Slice 5 wires the Graph adapter.
  throw new Error(
    `viva ${command.action} requires VivaClient — not available in CLI default impl yet`,
  );
```

Confirmed at runtime on 2026-04-22 after the Viva auth-scope deploy:

```
$ docker compose run --rm waldo --account eric.wauters@dynex.be --viva-discover
viva discover requires VivaClient — not available in CLI default impl yet
```

`realViva` today only constructs an `SqliteVivaSubscriptionStore` and
handles the two commands that don't need Graph (`list`, `unsubscribe`).
It never builds an `HttpVivaClient`, never acquires an MSAL token for
the `--account`, and has no path to validate "does this account
actually see that community" before inserting a subscription row.

[docs/user-guide.md §5b](../user-guide.md) documents these two commands
as working, and the scheduler assumes they are — the Viva sync tick is a
no-op until at least one row exists in `viva_subscriptions`. So the
feature is operator-blocked end-to-end: the server has the scope, the
scheduler has the client, but the only supported way to create the
first subscription row throws.

This is "Slice 5" that the in-code comment was promising. This plan is
Slice 5.

## Scope boundary

**In scope:**

1. In `realViva` ([src/cli.ts:567](../../src/cli.ts#L567)), construct an
   `HttpVivaClient` and an `MsalAuthClient` so we can get a delegated
   token and call Graph on the operator's behalf — mirroring the
   equivalent wiring in [src/index.ts:135-139](../../src/index.ts#L135-L139)
   and the MSAL setup the CLI already does elsewhere.
2. Implement the **discover** case:
   - `auth.getTokenSilent(<account lookup by username>)` → `AccessToken`.
   - Paginate `viva.listCommunities(token, nextLink)` across all
     `@odata.nextLink` pages, accumulating `VivaCommunity[]`.
   - Return `{ action: "discover", communities }` — existing
     `reportVivaResult` already formats this shape.
3. Implement the **subscribe** case:
   - Same token acquisition.
   - Same paginated `listCommunities`.
   - Validate: the operator-provided `communityId` must appear in the
     list. If not, throw `CliUsageError` with `"community <id> not
     visible to account <username> (check the id or run --viva-discover)"`.
   - If found: call `store.subscribe({ account, communityId, networkId,
     networkName? })` — networkId comes from the discovered community,
     which is exactly the reason we need discover before subscribe.
4. Surface user-meaningful errors:
   - `AuthError("silent-failed")` → `"no cached token for <account>;
     run --add-account first"`.
   - `TokenExpiredError` → same message (cached token exists but
     refresh failed — re-consent path).
   - `GraphRateLimitedError` → `"Graph rate-limited, try again in a
     moment"`.
   - Anything else → rethrow (stack goes to stderr, exit 1 via the
     existing CLI error path).
5. Remove the `// Slice 5 wires the Graph adapter` comment since it's
   now untrue, and the throwing branch with it.
6. Tests:
   - Three-to-four RED tests for `realViva` covering discover
     success, subscribe success, subscribe-validation-failure,
     token-missing path.
   - The existing `vivaImpl`-injected test surface in
     `runCli` stays unchanged — those tests already prove the
     result-shape contract.
7. Changelog entry, security scan, docs-update (user-guide.md gets a
   short "Run --viva-discover first to find the communityId" line if
   it doesn't already), plan archive.

**Out of scope** (deliberately deferred — flag if discovered, don't
silently expand):

- Server-side `/mcp` tool surface for Viva management — subscriptions
  are operator actions, MCP stays read-only per brief §9.
- Automatic re-consent when `getTokenSilent` fails. CLI surfaces the
  message; the operator re-runs `--add-account` manually — same
  contract every other CLI command assumes.
- Pagination cap / max-pages safety net. `listCommunities` for a
  single user is bounded by Graph-side membership — a few pages at
  most in practice. Not worth a safety net until we see a tenant
  where it matters.
- A `--viva-refresh-discover` that bypasses a cache. There is no
  cache; every invocation is live.
- Changes to `HttpVivaClient`, `VivaClient` interface, or the
  subscription store. This slice is pure CLI composition root.
- Adding `networkName` to the discover output table. The existing
  `reportVivaResult` formatter decides the columns — leave it alone.
- Timestamped logs (separate plan:
  [timestamped-logs.md](./timestamped-logs.md)).
- Per-account scope splitting (out-of-scope follow-up from
  [done/viva-auth-scope.md](done/viva-auth-scope.md)).

## Files to create / touch

- **Edit** [src/cli.ts](../../src/cli.ts)
  — `realViva` gains MSAL + VivaClient construction in the
  `discover` / `subscribe` branches, plus pagination loop and
  validation. Remove the `case "subscribe": case "discover": throw`
  block. Small additions — maybe 50-70 lines total.
- **Edit** [src/cli.test.ts](../../src/cli.test.ts) (if that's where
  CLI tests live; otherwise whatever sibling it uses — confirm before
  RED).
  — New tests injecting a fake `VivaClient` into `realViva` (NOT
  through `vivaImpl`, which replaces `realViva` wholesale). Requires
  `realViva` to accept an injected `VivaClient` + `AuthClient` via a
  new optional `deps` parameter used only in tests. That parameter is
  the testability seam — if we skip it we can only test through
  `vivaImpl`, which misses the composition-root bug we just hit.
- **Edit** [docs/user-guide.md](../user-guide.md) §5b — confirm the
  "run `--viva-discover` to get communityId" line is accurate; add
  one line if not.
- **Edit** [docs/changelog.md](../changelog.md) — entry under today's
  date.
- **Move** this plan to `docs/plans/done/viva-cli-graph-wiring.md` via
  `/docs-update` archive step.

## Seams involved

`msal` + `graph` (via `HttpVivaClient`) + `store` (viva-subscription).
No clock, fs, logger changes. No schema migration.

## RED test list

- **AC1**: `realViva` with `action: "discover"` returns the full
  paginated community list for the account.
  - Approach: inject a fake `VivaClient` whose `listCommunities` returns
    two pages (`@odata.nextLink` → second call → terminal page). Inject
    a fake `AuthClient` that returns a canned `AccessToken`. Assert the
    resulting `communities` array has all items from both pages, in
    order.
  - test file: [src/cli.test.ts](../../src/cli.test.ts) (confirm)
  - test name: `"realViva --viva-discover paginates listCommunities across @odata.nextLink"`
  - seams touched: msal (fake), graph-viva (fake)
  - edge cases: single-page response (no nextLink), empty response
    (zero communities — already covered by `reportVivaResult` output
    assertion: `"no viva communities visible to this account"`).

- **AC2**: `realViva` with `action: "subscribe"` and a **valid**
  communityId inserts a row in `viva_subscriptions` and returns
  `{ action: "subscribe", ok: true, ... }` (or whatever the
  existing `VivaCliResult` shape demands — confirm in RED).
  - Approach: fake `listCommunities` returns one community. Call
    subscribe with that id. Assert a row exists in the store with
    `(account, communityId, networkId)` matching the discovered
    community.
  - test file: [src/cli.test.ts](../../src/cli.test.ts)
  - test name: `"realViva --viva-subscribe <id> inserts subscription with networkId from discover"`
  - seams touched: msal, graph-viva, store
  - edge cases: already-subscribed community — the store's subscribe
    semantics already handle idempotency (confirm by reading
    `SqliteVivaSubscriptionStore.subscribe`); if it's an upsert, one
    test asserts the second call is a no-op at the DB level.

- **AC3**: `realViva` with `action: "subscribe"` and an **invalid**
  communityId (not in the discover list) throws `CliUsageError` with
  a message that names the id and the account, and inserts no row.
  - test file: [src/cli.test.ts](../../src/cli.test.ts)
  - test name: `"realViva --viva-subscribe rejects unknown communityId with a CliUsageError"`
  - seams touched: msal, graph-viva, store
  - edge cases: case-sensitivity of GUID match — Graph returns
    lowercase GUIDs; operator might paste uppercase. Prefer
    case-insensitive compare to avoid a sharp edge. Confirm before
    RED.

- **AC4**: `realViva` surfaces a specific message when the account has
  no cached MSAL token or silent acquisition fails.
  - Approach: fake `AuthClient.getTokenSilent` throws
    `AuthError("silent-failed")`. Assert the thrown error message
    includes `"run --add-account first"` and names the account.
  - test file: [src/cli.test.ts](../../src/cli.test.ts)
  - test name: `"realViva --viva-discover surfaces a friendly message when no cached token exists"`
  - seams touched: msal
  - edge cases: none.

- **AC5** *(optional, low cost)*: token-expired path surfaces the
  same re-consent hint.
  - Approach: fake `listCommunities` throws `TokenExpiredError`.
    Assert a friendly-message wrap.
  - test file: [src/cli.test.ts](../../src/cli.test.ts)
  - test name: `"realViva wraps TokenExpiredError as a re-consent hint"`
  - seams touched: graph-viva
  - edge cases: none. Skip if the existing CLI error layer already
    produces an acceptable message.

## Open questions / assumptions

1. **Assumption**: `HttpVivaClient`'s `listCommunities` already throws
   `TokenExpiredError` on 401 and `GraphRateLimitedError` on 429, per
   the comment in [src/sources/viva.ts:54-56](../../src/sources/viva.ts#L54-L56).
   Will confirm at SCAFFOLD time by reading `HttpVivaClient`.
2. **Assumption**: `MsalAuthClient.getTokenSilent` can be called by
   username alone — the CLI only has `--account eric.wauters@dynex.be`,
   not a `homeAccountId`. Need to confirm the method signature;
   likely there's a `listAccounts()` → filter by username path. If
   not, the CLI must resolve username → Account row via the
   accounts table first.
3. **Assumption**: `SqliteVivaSubscriptionStore.subscribe` is
   upsert-safe. Will verify before AC2.
4. **Assumption**: tests live in [src/cli.test.ts](../../src/cli.test.ts).
   If they're in [src/cli.viva.test.ts](../../src/cli.viva.test.ts) or
   similar (already-namespaced), new tests go there — confirm via
   `ls src/cli*.test.ts` in FRAME, not now.
5. **Question for the operator**: when `--viva-subscribe` is called
   with a GUID the account can't see, is a hard `CliUsageError` the
   right UX, or do we want to print the discover list and let them
   choose? AC3 assumes **hard error** — matches every other CLI's
   stance and keeps the code path linear. Override if you want
   otherwise.

## Risks

- **Risk**: resolving `--account <username>` → `Account` object for
  `getTokenSilent` needs a lookup. If we add a whole new seam for
  "account-by-username" instead of reusing `auth.listAccounts()`, the
  slice grows. → read `MsalAuthClient.listAccounts` first; if the
  filter-in-memory path is fine, use it. If a dedicated method is
  needed, flag and split into two slices.
- **Risk**: the test file we think holds CLI tests is actually split
  by command family and adding viva-specific tests elsewhere would be
  inconsistent. → check at FRAME time with a quick `ls`; low cost.
- **Risk**: `HttpVivaClient` expects a specific `fetch` injection
  shape and the CLI's environment doesn't match (e.g. a one-shot
  `docker compose run` might lack something the long-running
  container has). → it won't — `globalThis.fetch` is present in
  node 20+ and the image uses node 22. Verified by the scheduler
  already running against Graph from inside the container.
- **Risk**: adding a `deps` parameter to `realViva` for testability
  creates two code paths. → keep `deps` optional with real defaults;
  in production the defaults construct the real client, in tests the
  caller passes fakes. Existing `buildRealAuth` / `buildRealX`
  patterns in cli.ts already do this.
- **Risk**: we inadvertently widen the scope split and end up
  changing `VivaClient` signatures. → don't. The interface is
  stable. This slice is composition root only.

## Out-of-scope follow-ups

- A `--viva-rediscover` alias that re-reads and prints communities
  after the first time, once we know which ones the operator wants
  to track over time.
- Smarter `--viva-subscribe`: take `--community-name "Dynex Internal"`
  instead of a GUID and resolve it behind the scenes. Saves the
  operator a copy-paste. Not blocking; defer.
- A `scheduler_tick_summary` log line that names WHICH sources
  ticked `ok` vs `error` (today's "12 ok / 0 error" is opaque —
  post-subscribe we'll want to see that `viva-engage` specifically
  ticked). Candidate for the same slice as the timestamped-logs
  plan, or its own.
- Move `accounts.json` → an `accounts` SQLite table (already in the
  schema?) so the CLI has one authoritative source for
  username→account resolution. Probably already there — but this
  slice shouldn't touch it.

## Definition of done

- AC1–AC4 (and AC5 if cheap) all have named tests, all green.
- `npm test -- --coverage` passes the 90% gate; `src/cli.ts` coverage
  of the viva branches is ≥90%.
- `/security-scan` PASS — no real tenant IDs or tokens in fixtures.
- `/docs-update` PASS — changelog entry, user-guide cross-check, plan
  archived to `docs/plans/done/viva-cli-graph-wiring.md`.
- Operator runs `/local-smoke` (covers boot) and then:

  ```sh
  sudo docker compose run --rm waldo \
    --account eric.wauters@dynex.be --viva-discover
  ```

  sees a real list of communities, picks one, runs:

  ```sh
  sudo docker compose run --rm waldo \
    --account eric.wauters@dynex.be \
    --viva-subscribe <communityId>
  ```

  sees confirmation, then `--viva-list` shows the row. Next sync tick
  logs `viva-engage ok` in `sync_log` for that account.
