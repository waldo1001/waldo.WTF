# Plan: Add Viva Engage as a Source

## Context

The user follows multiple Viva Engage networks and, within each network, multiple communities/groups. Today, waldo.WTF ingests Outlook, Teams, and WhatsApp but has **zero mentions of Viva/Yammer/Engage** in code or docs. The goal is to bring Viva into the read-only lake so that `search`, `get_recent_activity`, `get_thread`, `list_threads`, and steering all work uniformly across Viva alongside the existing sources.

**Decisions confirmed with user:**
- **API**: Microsoft Graph beta `/employeeExperience` endpoints. Reuse existing MSAL + `HttpGraphClient`. No Yammer REST.
- **Scope**: Explicit subscription list — the user chooses which `(network, community)` pairs to follow per account.
- **Thread model**: One thread per Viva *conversation* (starter post + its replies), `thread_id = viva:{networkId}:{communityId}:{conversationId}`.

## Architecture map

Mirrors the Teams pattern ([src/sync/sync-teams.ts](../../src/sync/sync-teams.ts)) and reuses:
- [src/auth/msal-auth-client.ts](../../src/auth/msal-auth-client.ts) — add `Community.Read.All` scope (exact scope confirmed in slice 1)
- [src/sources/http-graph-client.ts](../../src/sources/http-graph-client.ts) — unchanged; already handles 429 / 401 / 410 / pagination
- [src/sync/sync-scheduler.ts](../../src/sync/sync-scheduler.ts) — extend loop to iterate Viva subscriptions per account
- [src/store/steered-message-store.ts](../../src/store/steered-message-store.ts) — no changes; `source: "viva-engage"` flows through unchanged
- [src/mcp/tools/get-recent-activity.ts](../../src/mcp/tools/get-recent-activity.ts) and [src/mcp/tools/list-threads.ts](../../src/mcp/tools/list-threads.ts) — add `"viva-engage"` to `KNOWN_SOURCES`

**Viva Engage beta endpoints** (verified in slice 1 against live tenant before writing sync code):
- `GET /beta/employeeExperience/communities` — list accessible communities (≈ "groups" in user's terminology)
- `GET /beta/employeeExperience/communities/{id}` — community metadata incl. network
- `GET /beta/employeeExperience/communities/{id}/threads` — conversations (paged, no delta)
- `GET /beta/employeeExperience/communities/{id}/threads/{id}/posts` — replies within a conversation

No deltaLink → timestamp cursor per `(account, community)`.

## Scope boundary

**In scope:**
1. New source `viva-engage` end-to-end: ingest, store, surface via MCP tools.
2. Subscription CLI: `npm run viva -- list`, `viva -- subscribe <community-id>`, `viva -- unsubscribe <community-id>`.
3. Per-subscription timestamp cursor so re-syncs are incremental.
4. Tests + 90% coverage + security scan + docs update, per [CLAUDE.md](../../CLAUDE.md).

**Out of scope** (explicit non-goals for this plan):
- Reactions, attachments, bookmarks — body + metadata only in v1.
- Yammer REST fallback.
- Historical backfill beyond what the Graph endpoint returns by default (we accept the Graph-imposed window).
- Cross-network DMs (Viva Engage private messages) — only community posts.
- Writing to Viva (read-only forever, per brief).

## Schema changes

Add migration **V11** in [src/store/schema.ts](../../src/store/schema.ts):

```sql
CREATE TABLE viva_subscriptions (
  account TEXT NOT NULL,
  network_id TEXT NOT NULL,
  network_name TEXT,
  community_id TEXT NOT NULL,
  community_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  subscribed_at INTEGER NOT NULL,
  last_cursor_at INTEGER,          -- ms epoch of newest post last seen
  PRIMARY KEY (account, community_id)
);
CREATE INDEX idx_viva_subs_account ON viva_subscriptions(account, enabled);
```

`sync_state` is **not** extended — it stays `(account, source)` and records the scheduler's overall last-run for `viva-engage`. Per-community cursors live in `viva_subscriptions.last_cursor_at` so each community advances independently without colliding on a shared key.

No change to `messages` schema; Viva messages fit the existing shape:
- `id` = `"viva-engage:" + account + ":" + nativeId` (hashed, per existing convention)
- `source` = `"viva-engage"`
- `thread_id` = `"viva:" + networkId + ":" + communityId + ":" + conversationId`
- `thread_name` = `communityName + " / " + conversationTopic` (truncated)
- `sender_name` / `sender_email` from post author
- `body` = plain text, `body_html` = rendered
- `chat_type` = `"group"`

## Slices (each one ≥1 `/tdd-cycle`)

Each slice ships independently. Stop after each; do not merge steps.

### Slice 1 — Source type + message shape (foundations)

**Files**: [src/store/types.ts](../../src/store/types.ts), [src/store/schema.ts](../../src/store/schema.ts) (migration V11), [src/mcp/tools/get-recent-activity.ts](../../src/mcp/tools/get-recent-activity.ts), [src/mcp/tools/list-threads.ts](../../src/mcp/tools/list-threads.ts).

**RED tests:**
- `types.test.ts` — `"viva-engage"` is a valid `MessageSource`.
- `schema-migration.test.ts` — migration V11 creates `viva_subscriptions` with expected columns + indices; up/down is safe on a populated DB.
- `get-recent-activity.test.ts` — filtering `sources: ["viva-engage"]` returns only Viva messages; default (no filter) includes them.
- `list-threads.test.ts` — accepts `source: "viva-engage"`; rejects unknown sources.

**GREEN**: extend the union + `KNOWN_SOURCES` sets + write migration.

### Slice 2 — Subscription store + CLI

**Files**: new `src/store/viva-subscription-store.ts` + in-memory/sqlite twins mirroring the [message-store-contract](../../src/store/message-store-contract.ts) pattern; extend [src/cli.ts](../../src/cli.ts) with `viva:list`, `viva:subscribe`, `viva:unsubscribe`, `viva:discover`.

**RED tests:**
- Contract tests covering `subscribe`, `unsubscribe`, `listForAccount`, `setCursor`, `toggleEnabled`.
- CLI integration: `viva:subscribe` rejects unknown community IDs; `viva:discover` lists communities returned by a **faked** `VivaClient`.

**GREEN**: SQLite store + CLI handlers. No live Graph call yet.

### Slice 3 — VivaClient (Graph wrapper) + fake

**Files**: new `src/sources/viva-client.ts` (interface + HTTP impl), new `src/testing/fake-viva-client.ts`.

Interface shape (parallel to [src/sources/graph.ts](../../src/sources/graph.ts)):

```ts
interface VivaClient {
  listCommunities(): Promise<readonly VivaCommunity[]>;
  listThreads(communityId: string, since: Date): Promise<VivaThreadPage>;
  listPosts(communityId: string, threadId: string): Promise<readonly VivaPost[]>;
}
```

**RED tests**: fake handles pagination (`@odata.nextLink`), 429 surfaces `GraphRateLimitedError`, 410 surfaces `DeltaTokenInvalidError` analog (we'll reuse or mint a `VivaCursorInvalidError`).

**GREEN**: thin wrapper over existing `HttpGraphClient` — no new HTTP primitives.

**Security scan hook**: fixtures must not contain real tenant IDs, community IDs, or display names. Scrub with `00000000-0000-…`.

### Slice 4 — Sync function

**Files**: new `src/sync/sync-viva.ts` mirroring [src/sync/sync-teams.ts](../../src/sync/sync-teams.ts).

**Algorithm:**
1. Load all enabled subscriptions for the account.
2. For each community, fetch threads newer than `last_cursor_at`.
3. For each thread, fetch posts → convert to `Message` rows.
4. `store.upsertMessages(...)` then update `last_cursor_at` = max(`sentAt`) **only on success**.
5. Return `{added, updated, errors}` per-community so one bad community doesn't kill the run.

**RED tests** (all against `FakeVivaClient` + `InMemoryMessageStore`):
- Empty cursor → fetches everything the fake exposes.
- Existing cursor → only posts after cursor are fetched and upserted.
- Rate-limit mid-sync → advances cursor for communities already processed, leaves others untouched.
- Thread name collision across communities → `thread_id` includes community prefix so they don't merge.
- Deleted/edited posts → upsert overwrites by `id`, no duplicates.

### Slice 5 — Scheduler wiring + end-to-end

**Files**: [src/sync/sync-scheduler.ts](../../src/sync/sync-scheduler.ts), [src/index.ts](../../src/index.ts), docs.

**RED tests**: scheduler invokes `syncViva` once per account that has at least one enabled subscription; zero subscriptions → skips (no empty Graph calls); error in Viva sync does not abort Outlook/Teams syncs.

**GREEN + smoke**: run `/local-smoke`, then exercise via MCP:
- `list_accounts` unchanged.
- `search "<known viva term>"` returns Viva hits.
- `get_thread "<viva thread id>"` returns the conversation.
- `list_threads source=viva-engage` lists subscribed communities' conversations.
- Add a steering rule `thread_name_contains "Sales"` scoped `source: "viva-engage"` and confirm it hides only Viva hits.

## Verification (run before declaring done)

1. `npm test` — full suite green.
2. Coverage: touched files ≥90% line + branch ([docs/tdd/coverage-policy.md](../tdd/coverage-policy.md)).
3. `/security-scan` — clean.
4. `/local-smoke` — MCP `tools/list` shows no regressions; SQLite boots with V11.
5. Manual MCP smoke against a **real** account with one subscribed community: `get_recent_activity hours=24 sources=["viva-engage"]` returns the post I just made in that community.
6. `/docs-update` — changelog + user guide entries for the new source and CLI commands.

## Risks / open questions to revisit during slice 1

- **Exact Graph scope name** — docs vary between `Community.Read.All`, `CommunityPost.Read.All`, `Tenant.Read.All`. Confirmed by calling the endpoint with a scoped token before writing sync code.
- **Multi-network via single MSAL account** — Graph `/employeeExperience/communities` returns communities from the *home* tenant's network. Guest access to other networks may require per-network auth. If true, Slice 2 subscription key becomes `(account, network_id, community_id)` and Slice 3 adds a network selector. Detected by a probe in Slice 1.
- **Throttling budget** — Viva endpoints are more aggressive than Mail/Chat. Scheduler interval may need to widen for Viva-only ticks; parameterize so we don't hard-code 5 min.

## Non-goals (to prevent scope creep during implementation)

- No UI changes beyond CLI.
- No new MCP tools. Everything routes through existing `search` / `get_thread` / `get_recent_activity` / `list_threads`.
- No retroactive renaming of sources; `teams` remains `teams`, `viva-engage` stands on its own.
