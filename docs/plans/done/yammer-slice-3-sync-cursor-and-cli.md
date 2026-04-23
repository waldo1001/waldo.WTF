# Plan: sync-viva cursor walk + CLI subscribe disambiguation (Slice 3 of 3)

## Task
Implement proper Yammer cursor-based pagination in `sync-viva.ts` (replace the
Slice 2 single-page stub) and update the CLI discover output + subscribe command
to support `<networkId>:<communityId>` disambiguation.

## Scope boundary

**In scope:**
- `src/sync/sync-viva.ts` — replace single-page stub with `olderThan` cursor
  walk: walk backwards per community/thread until either empty page or oldest
  message is older than `lastCursorAt` (stop on already-seen territory).
  Cap at `MAX_PAGES = 50` per community as a safety valve.
- `src/sync/sync-viva.test.ts` — add / update tests for cursor walk, early-stop,
  per-community isolation under rate-limit.
- `src/cli.ts` — `reportVivaResult` discover case: add `network_name` column;
  `resolveVivaCommand` subscribe case: parse `<networkId>:<communityId>` colon
  format; `discoverForAccount` subscribe: disambiguate by networkId prefix.
- `src/cli.test.ts` — cover new discover output columns and subscribe disambiguation.
- `src/testing/fake-viva-client.ts` — no interface changes needed.

**Out of scope:**
- Edited-post handling (Yammer has no `updated_at` in REST v1 `messages` response)
- Deleted-thread 404 handling (Slice 4 follow-up if needed)
- Yammer post pagination (posts within a thread already fetches one page;
  threads with >50 replies will be re-fetched each sync, acceptable for now)

## Files to touch

- `src/sync/sync-viva.ts`
- `src/sync/sync-viva.test.ts`
- `src/cli.ts`
- `src/cli.test.ts`

## Seams involved

`viva` (FakeVivaClient), `store` (InMemoryVivaSubscriptionStore), `clock`

## RED test list

### sync-viva.ts

- AC1: `listThreadsForCommunity` walks multiple pages using `olderThan` cursor
  until empty page; upserts all threads
  - test file: `src/sync/sync-viva.test.ts`
  - test name: "walks multiple thread pages using olderThan until empty page"
  - seams: FakeVivaClient, InMemoryVivaSubscriptionStore
  - edge case: 3-page walk → 3 listThreads calls

- AC2: early-stop when oldest thread in page has `created_at ≤ lastCursorAt`
  - test name: "stops walking threads when oldest message is at or before lastCursorAt"
  - edge case: first page entirely below cursor → 1 call only

- AC3: `listPostsForThread` walks posts with `olderThan` cursor until empty
  - test name: "walks multiple post pages for a single thread"
  - edge case: 2 post pages per thread

- AC4: per-community isolation — rate-limit on community B does not prevent
  community A's cursor from advancing
  - test name: "rate-limit on one community does not block cursor advance on another"

- AC5: MAX_PAGES cap: after 50 pages the walk stops even if pages are non-empty
  - test name: "stops walking after MAX_PAGES pages (safety cap)"
  - edge case: verify cursor still advances to the high-water of pages fetched

### cli.ts

- AC6: `reportVivaResult` discover output includes `network_name` column (4 cols)
  - test file: `src/cli.test.ts`
  - test name: "reportVivaResult discover prints network_name as 4th column"

- AC7: `--viva-subscribe <networkId>:<communityId>` selects the exact community
  in the named network
  - test name: "--viva-subscribe <networkId>:<communityId> resolves unambiguously"

- AC8: `--viva-subscribe <communityId>` where id is unique → auto-resolves (existing behavior preserved)
  - test name: "--viva-subscribe plain communityId auto-resolves when unambiguous"

- AC9: `--viva-subscribe <communityId>` where same id appears in 2 networks →
  `CliUsageError` with both network ids listed
  - test name: "--viva-subscribe throws CliUsageError when communityId is ambiguous across networks"

## Open questions / assumptions

- **Assumption**: `lastCursorAt` is a `Date` and we compare message `created_at`
  ISO string vs `cursor.getTime()`. ISO timestamps from Yammer are +00:00 offset.
- **Assumption**: `VivaThread.lastPostedDateTime` is used as the "age" of a
  thread for cursor comparison (it's the timestamp in the Yammer `created_at`
  field, not a separate "last modified").
- **Assumption**: `MAX_PAGES = 50` is sufficient for normal communities (typically
  <500 threads visible per sync tick, Yammer returns ~20 per page).
- **Assumption**: The colon format `<networkId>:<communityId>` uses the first `:` 
  as delimiter (community IDs from Yammer REST are plain integers, never contain `:` 
  themselves).

## Risks

- The early-stop on `created_at ≤ lastCursorAt` may skip messages if Yammer
  returns pages out of time order. Mitigation: use the `id` field ordering (Yammer
  IDs are ascending), which the `olderThan` param already enforces.
- Tests for AC5 (MAX_PAGES) require 50 scripted steps in the fake — this is
  verbose. Use a helper that generates N steps.

## Out-of-scope follow-ups

- Yammer post pagination within a thread (posts > page size)
- Deleted-thread / deleted-post handling
- `--viva-unsubscribe <networkId>:<communityId>` colon format
- Full smoke on NAS (separate deploy step)
