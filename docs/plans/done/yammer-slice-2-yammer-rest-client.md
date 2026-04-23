# Plan: Yammer REST client + VivaClient interface pivot (Slice 2 of 3)

## Task
Replace the Graph-based `VivaClient` / `HttpVivaClient` with a Yammer REST
implementation that enumerates networks and their groups, so external networks
(like `microsoft.onmicrosoft.com`) appear in `--viva-discover`.

## Scope boundary

**In scope:**
- New raw Yammer response types in `src/sources/yammer.ts`
- Reshaped `VivaClient` interface in `src/sources/viva.ts`:
  - `listNetworks(token)` → `readonly VivaNetwork[]`
  - `listCommunities(token, networkId)` → `readonly VivaCommunity[]` (flat, paginates internally)
  - `listThreads(token, communityId, { olderThan? })` → `VivaThreadPage` (cursor = oldest message ID)
  - `listPosts(token, threadId, { olderThan? })` → `VivaPostPage`
  - Remove `VivaCommunityListPage`, `@odata.nextLink` pagination from the interface
  - Add `olderThanCursor?: string` to `VivaThreadPage` and `VivaPostPage`
- `src/sources/http-yammer-client.ts` (new) — implements reshaped `VivaClient` against `www.yammer.com/api/v1`
- `src/sources/http-yammer-client.test.ts` (new)
- `src/testing/fake-viva-client.ts` — updated to new interface shapes
- `src/testing/fake-viva-client.test.ts` — updated
- Delete `src/sources/http-viva-client.ts` + `src/sources/http-viva-client.test.ts`

**Out of scope (deferred to Slice 3):**
- `sync-viva.ts` pagination change (`sinceIso` → walk-until-cursor) — that's Slice 3
- `cli.ts` discover changes (call `listNetworks` + loop `listCommunities`) — that's Slice 3
- Any migration for existing `viva_subscriptions` rows with Graph GUIDs — users have no subscriptions yet on the NAS

## Files to create / touch

- `src/sources/yammer.ts` (NEW) — raw Yammer REST response shapes
- `src/sources/viva.ts` — reshaped `VivaClient` + updated types
- `src/sources/http-yammer-client.ts` (NEW) — HTTP implementation
- `src/sources/http-yammer-client.test.ts` (NEW)
- `src/testing/fake-viva-client.ts` — updated to new interface
- `src/testing/fake-viva-client.test.ts` — updated / new tests
- `src/sources/http-viva-client.ts` — DELETE
- `src/sources/http-viva-client.test.ts` — DELETE
- `src/sync/sync-viva.ts` — minimal fixup only: `listThreads` signature change (remove `sinceIso`; will be properly addressed in Slice 3 — here just keep it compilable with stub)
- `src/cli.ts` — minimal fixup: `discoverAllCommunities` needs new interface (kept compilable)
- `src/cli.test.ts` — update `listCommunitiesOk` fake steps → `listNetworksOk` + `listCommunitiesOk`

## Seams involved

`http` (Yammer REST), none for the fake

## Yammer REST endpoint surface

| Purpose | URL | Notes |
|---|---|---|
| List networks | `GET https://www.yammer.com/api/v1/networks/current.json` | Single page, array |
| List groups in network | `GET https://www.yammer.com/api/v1/groups.json?network_id={id}` | `page=N` pagination; empty array = end |
| List threads in group | `GET https://www.yammer.com/api/v1/messages/in_group/{id}.json?threaded=extended[&older_than={msgId}]` | descending by newest; `older_than` = message ID |
| List replies in thread | `GET https://www.yammer.com/api/v1/messages/in_thread/{id}.json[?older_than={msgId}]` | same pagination |

Rate limit: 10 req/user/app/30s → 429 retry backoff 6s (not 60s like Graph).

Token audience: `https://api.yammer.com/` (different from Graph).
Request host: `www.yammer.com` — hard-coded, no config knob needed.

## RED test list

### `http-yammer-client.test.ts`

- AC1: `listNetworks` hits `https://www.yammer.com/api/v1/networks/current.json` with Bearer token, parses `[{id, name, permalink}]`, returns `VivaNetwork[]`
  - seam: FetchLike
- AC2: `listNetworks` maps 401 → `TokenExpiredError`
- AC3: `listNetworks` maps 429 → `GraphRateLimitedError` with 6s default (not 60s)
- AC4: `listCommunities(token, networkId)` hits `/groups.json?network_id={id}`, maps to `VivaCommunity[]`, paginates via `page=2` until empty array
  - edge case: single page (no second call)
- AC5: `listCommunities` maps each Yammer group `{id, full_name, network_id}` to `VivaCommunity { id: string(id), displayName: full_name, networkId: string(network_id) }`
- AC6: `listThreads(token, communityId, {})` hits `/messages/in_group/{id}.json?threaded=extended`, maps top-level messages to `VivaThread[]`, resolves sender display name from `references`, returns `olderThanCursor` = oldest message id when page is non-empty
- AC7: `listThreads` with `olderThan` appends `&older_than={id}` to URL
- AC8: `listThreads` returns `olderThanCursor: undefined` when `messages` is empty (end of stream)
- AC9: `listPosts(token, threadId, {})` hits `/messages/in_thread/{id}.json`, maps messages to `VivaPost[]` with correct `conversationId` = `thread_id` field, resolves sender
- AC10: `listPosts` with `olderThan` appends `&older_than={id}`
- AC11: token not leaked in any error message (401, 429, 500)
- AC12: `listCommunities` maps 401/429 to typed errors

### `fake-viva-client.test.ts`

- AC13: `FakeVivaClient` with `listNetworksOk` step returns scripted networks
- AC14: `FakeVivaClient` with `listCommunitiesOk` step returns scripted communities
- AC15: `FakeVivaClient` calling wrong method on a scripted step throws a clear error

## Open questions / assumptions

- **Assumption**: Yammer numeric IDs (64-bit ints) are serialized as numbers in JSON. JS `JSON.parse` loses precision for values > 2^53. **Mitigation**: use `JSON.parse(text, (key, val, ctx) => ctx.source)` pattern with `reviver` to keep IDs as strings — or simply call `.toString()` on each id field after parse. The plan calls for storing as TEXT already. Test will assert a known >2^53 ID round-trips losslessly as string.
- **Assumption**: `threaded=extended` on the in_group endpoint returns a flat `messages` array of top-level posts plus `threaded_extended` mapping thread_id → array of reply ids. We use only `messages` (top-level) for `listThreads`; `listPosts` fetches replies separately via `in_thread`.
- **Assumption**: Re-using `GraphRateLimitedError` / `TokenExpiredError` from `graph.ts` is fine; they are already imported by `viva.ts` and `sync-viva.ts`.
- **Assumption**: `listCommunities` fetching all pages internally is safe given the expected number of groups per network (tens, not thousands). If a network has >1000 groups we'd want external pagination — out of scope.

## Risks

- **Breakage to `sync-viva.ts` and `cli.ts`** during the interface change: both still reference `@odata.nextLink` and `sinceIso`. They will fail to compile after this slice. Minimal fixups (compiling stubs) are part of this slice to keep the suite green.
- **Existing `cli.test.ts` tests for `realViva` discover** use `listCommunitiesOk` with `@odata.nextLink` — these need updating as part of this slice.
- **Yammer group `id` is a number in JSON** — must be string-ified consistently across `listCommunities`, `listThreads` URL building, and `viva_subscriptions` storage.

## Out-of-scope follow-ups

- Slice 3: pivot `sync-viva.ts` to Yammer walk-until-cursor strategy; update `cli.ts` `discoverAllCommunities` to call `listNetworks` + `listCommunities` per network; update CLI discover output format; `--viva-subscribe` disambiguation for `<network_id>:<community_id>`.
