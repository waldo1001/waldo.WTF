# VIVA Engage sync: over-fetching and inflated counts

**Date:** 2026-04-25
**Status:** draft
**Trigger:** diagnostics reported ~86k VIVA messages added in 24h; actual unique count is ~514

## Problem

Every 5-minute sync cycle re-fetches and re-upserts virtually all VIVA
messages across all subscribed communities. The database is not exploding
(UPSERT deduplicates), but the sync is doing ~150x more work than necessary
and the reported message count is wildly misleading.

**Live evidence (2026-04-25):**

| Metric | Value |
|--------|-------|
| Unique VIVA messages in DB | ~514 across 140 threads |
| Communities subscribed | 7 (BC Partners network) |
| `messagesAddedLastOk` (last sync) | 514 |
| `messagesAddedLast24h` | 83,120 |
| Sync interval | 5 min (288 cycles/day) |
| Implied cycles contributing | 83,120 / 514 ≈ 162 (~13.5h uptime) |

## Root cause analysis

### 1. No delta sync for Yammer

Outlook and Teams use Microsoft Graph delta tokens — the API returns only
changes since the last token. VIVA uses the legacy Yammer REST API
(`/api/v1/messages/in_group/{id}.json?threaded=extended`) which has no delta
support. The code compensates with a date-based watermark (`lastCursorAt`
stored per community), but the watermark only controls *pagination depth*,
not *what gets upserted*.

### 2. Thread-level granularity causes full-thread re-fetch

`syncOneCommunity` (sync-viva.ts:161) does:

1. `listThreadsForCommunity` — pages backward through threads until the
   oldest thread on a page has `lastPostedDateTime <= cursor`. All threads
   from that boundary page are included. With ~20 threads per page, this
   means the first page is *always* returned even when nothing is new.
2. For each returned thread, `listPostsForThread` fetches **all** posts
   (paginating backward until `oldest.createdDateTime <= cursor`).
3. All fetched posts are upserted — including posts already in the DB.

With 7 communities × ~20 threads/page = ~140 threads → ~514 posts
re-upserted every cycle.

### 3. `lastPostedDateTime` is the thread-starter's `created_at`

In `http-yammer-client.ts:170-173`, the code maps `m.created_at` to
`lastPostedDateTime`. With `threaded=extended`, `m` is the thread-starter
message, so `created_at` is when the thread was created — not the date of
the last reply. This makes the thread-level cursor comparison unreliable
for filtering: a thread started in January with a reply today shows
`lastPostedDateTime = January`, which is always `<= cursor`.

### 4. Count inflation: `added + updated` reported as "added"

`sync-viva.ts:176` — `added += r.added + r.updated`. The upsert returns
`{ added: 0, updated: 514 }` on a quiet cycle, but the sync reports 514
as "messages added" to the sync log. Over 24h this accumulates to 83k.

This pattern exists in all sync sources (inbox, sent, teams, channels,
viva), but for delta-based sources the `updated` count is small. For VIVA
it dominates.

## Impact

- **Reporting:** the 83k number is alarming but fake — real new messages
  per day are likely single-digit to low-hundreds
- **API budget:** ~140 Yammer API calls per sync cycle (listThreads ×7 +
  listPosts ×140), ~40k/day — unnecessary load and rate-limit risk
- **DB writes:** ~514 UPSERTs per cycle, ~148k/day — all no-ops but still
  WAL churn
- **Data integrity:** no impact — UPSERT is idempotent, no duplicates

## Proposed fix: rolling 24h time window

Drop the complex cursor-pagination dance. The Yammer API has no delta
support anyway — we're always walking pages. Replace with a simple,
self-healing approach:

### How it works

Each sync cycle, for each community:

1. **List threads** — fetch page 1 only (~20 most recently active threads).
   No pagination, no cursor comparison. One API call per community.
2. **For each thread, fetch posts** — paginate backward, stop when
   `createdDateTime < now - 24h`. Collect all posts within the window.
3. **Upsert** — the DB deduplicates via `ON CONFLICT(id) DO UPDATE`.
   Only count `r.added` (genuinely new rows), ignore `r.updated`.
4. **No cursor management** — the 24h window is self-healing. If the
   server was down overnight, the next cycle catches up automatically.
   The per-community `lastCursorAt` column can stay in the schema (no
   migration needed) but is no longer read or written by sync.

### Why this is better

| | Current (cursor) | Rolling 24h window |
|---|---|---|
| API calls/cycle | ~148 (7 listThreads + ~140 listPosts) | ~28 (7 listThreads + ~20 listPosts) |
| Posts upserted/cycle | ~514 (everything) | ~50-100 (24h window) |
| Self-healing | No — stale cursor = stale data | Yes — always covers last 24h |
| Code complexity | High (cursor set/get, boundary pages, high-water calc) | Low (simple date comparison) |
| Missed-message risk | Cursor bugs skip data silently | 24h window is generous, hard to miss |

Most communities get <20 posts/day, so 1 page of posts per thread covers
the full 24h window. The ~20 threads from page 1 will include any thread
with recent activity. Quiet threads (no posts in 24h) still appear in the
thread listing but their post-fetch returns nothing within the window —
cheap, no harm.

### Count fix

Change `sync-viva.ts:176` from `r.added + r.updated` to `r.added`. This
makes the reported count reflect genuinely new messages regardless of how
many were re-upserted.

### The 24h constant

Make it a named constant (`VIVA_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000`)
so it's easy to tune. 24h is generous — covers overnight gaps, weekend
restarts, timezone spread of BC Partners contributors. A tighter window
(e.g. 1h) would reduce API traffic further but risks missing posts after
a longer outage.

### What about the initial sync?

First sync for a new subscription has no history. Current behavior: fetch
everything (up to 50 pages). New behavior: fetch 24h of posts. This is
fine — the subscription discovery flow already backfills via the existing
`listPostsForThread` walk. If a full historical backfill is ever needed,
it can be a separate one-shot operation, not part of the recurring sync.

## Implementation

### syncOneCommunity rewrite (sync-viva.ts)

```
async function syncOneCommunity(deps):
  cutoff = now - VIVA_SYNC_WINDOW_MS

  // Step 1: one page of threads (no pagination)
  threads = viva.listThreads(token, communityId, {})

  // Step 2: for each thread, fetch recent posts
  added = 0
  for thread of threads:
    posts = fetchPostsSince(viva, token, thread.id, cutoff)
    if posts.length === 0: continue
    messages = posts.map(postToMessage)
    r = store.upsertMessages(messages)
    added += r.added          // genuinely new only

  return { added }
```

`fetchPostsSince` replaces `listPostsForThread` — same pagination loop
but stops at `cutoff` and only returns posts newer than `cutoff`.

### Remove cursor management

- Remove `highWater` tracking and `subs.setCursor()` call from
  `syncOneCommunity`
- Remove `recordSuccess` cursor-advancement logic from `syncViva`
- `lastCursorAt` column stays in schema (harmless), not read/written

### Thread-listing simplification

- Remove `listThreadsForCommunity` helper entirely
- Replace with a single `viva.listThreads(token, communityId, {})` call
  (no `olderThan`, no loop)
- If a community has >20 active threads in 24h, we miss some — acceptable
  tradeoff for simplicity. Can revisit with pagination if needed.

## Files to modify

| File | Change |
|------|--------|
| `src/sync/sync-viva.ts` | Rewrite `syncOneCommunity`, drop cursor logic, fix count |
| `src/sync/sync-viva.test.ts` | New tests for 24h window; remove/adjust cursor tests |

## Verification

1. `npm test` — all tests pass
2. New test: posts older than 24h window are not upserted
3. New test: posts within 24h window are upserted, count reflects `added` only
4. New test: empty community (no recent posts) returns `added: 0`, no errors
5. After deploy: `get_sync_status` should show `messagesAddedLast24h` in the
   low hundreds at most, not 83k

## Out of scope

- Changing the count pattern in other sync sources (delta-based, low impact)
- sync_log retention/pruning (separate concern)
- Database size monitoring (not actually a problem)
- Full historical backfill command (separate feature if ever needed)
