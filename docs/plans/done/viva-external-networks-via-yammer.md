# Plan: Viva Engage external networks via Yammer REST

## Context

The current Viva source (shipped in [add-viva-engage-source.md](done/add-viva-engage-source.md)) calls Microsoft Graph beta `/employeeExperience/communities`. That endpoint has a hard limitation documented by Microsoft:

> The Viva Engage API in Microsoft Graph is only supported for Viva Engage networks in **native mode**. You can't use this API to manage legacy or **external** Viva Engage networks. — [engagement-api-overview](https://learn.microsoft.com/graph/api/resources/engagement-api-overview?view=graph-rest-1.0)

Result on [the live NAS](../changelog.md): for `eric.wauters@dynex.be`, `--viva-discover` correctly returns `no viva communities visible to this account` — because the single valuable network (`microsoft.onmicrosoft.com`, the Microsoft partner community where Eric is a guest) is an **external** network and Graph silently hides it.

Smoke-tested 2026-04-22: the legacy Yammer REST API (`https://www.yammer.com/api/v1/…`) **accepts Microsoft Entra tokens** (resource `https://api.yammer.com/`) and **does enumerate external networks** for the signed-in user. For Eric's token, `/networks/current.json` returns 13 networks including the Microsoft one; for `WAUTERI@ifacto.be` it returns 2 networks including a genuine cross-tenant external. Evidence is in this branch's chat history — no code change was needed to prove the capability.

Decision: **pivot the Viva source from Graph to Yammer REST.** Drop the Graph `/employeeExperience` path entirely — it gives us strictly less than Yammer REST (home-tenant native-mode only) for the same cost. Yammer REST covers both home and external networks.

Microsoft's own guidance supports this direction ([Call Yammer APIs](https://learn.microsoft.com/rest/api/yammer/api-requests-1)):

> All Yammer APIs support authentication via Entra tokens. We recommend using Entra applications to access the Yammer APIs.

## Goal

After this plan ships, `--viva-discover --account eric.wauters@dynex.be` lists every community Eric can see in every network — home **and** external. Subscribing to a Microsoft-network community and running the sync loop ingests its threads into the lake, and `get_recent_activity sources=["viva-engage"]` / `get_thread` / `search` / steering all work the same as they do for Teams and Outlook today.

## Architecture map

**Files added:**
- `src/sources/yammer.ts` — the new `YammerClient` interface + shared types (`YammerNetwork`, `YammerGroup`, `YammerThread`, `YammerPost`, error classes).
- `src/sources/http-yammer-client.ts` — HTTP implementation against `https://www.yammer.com/api/v1/…`.
- `src/testing/fake-yammer-client.ts` — deterministic fake for sync + CLI tests.

**Files modified:**
- [src/auth/msal-auth-client.ts](../../src/auth/msal-auth-client.ts) — replace the fixed `SCOPES` constant with a per-call `scopes` parameter on `getTokenSilent`/`loginWithDeviceCode`. Drop `Community.Read.All` (Graph-only). Add the Yammer scope (`https://api.yammer.com/user_impersonation`) to the login request so one consent covers both Graph and Yammer.
- [src/auth/auth-client.ts](../../src/auth/auth-client.ts) — widen `AuthClient.getTokenSilent` to accept `scopes?: readonly string[]`. Default keeps today's behavior (Graph scopes) so non-Viva call sites don't change.
- [src/sources/viva.ts](../../src/sources/viva.ts) — reshape the `VivaClient` interface so it is **implementation-neutral** (no Graph URL shapes leak through). The current shape (`listCommunities`/`listThreads`/`listPosts` with `@odata.nextLink`) already fits; we just retarget it at Yammer endpoints and replace `nextLink` with `olderThan` cursors that Yammer uses for pagination.
- [src/sources/http-viva-client.ts](../../src/sources/http-viva-client.ts) — **delete**. Its tests move to `http-yammer-client.test.ts`.
- [src/sync/sync-viva.ts](../../src/sync/sync-viva.ts) — swap the client call sites to the new pagination idiom (`olderThan` instead of `nextLink`). Thread id format is unchanged: `viva:{networkId}:{communityId}:{conversationId}` — values are still strings, Yammer's numeric ids stringify.
- [src/cli.ts](../../src/cli.ts) — extend `--viva-discover` to group output by network (`network_permalink`, `network_name`, then community rows). `--viva-subscribe <id>` accepts either `<community_id>` (unique) or `<network_id>:<community_id>` (disambiguator).

**Files unchanged:**
- Schema — `viva_subscriptions` already carries `network_id` and `network_name`; no V12 needed.
- [src/store/viva-subscription-store.ts](../../src/store/viva-subscription-store.ts), [src/store/viva-subscription-store-contract.ts](../../src/store/viva-subscription-store-contract.ts) — IDs are `TEXT`, Yammer's numeric ids fit.
- [src/mcp/tools/get-recent-activity.ts](../../src/mcp/tools/get-recent-activity.ts), [src/mcp/tools/list-threads.ts](../../src/mcp/tools/list-threads.ts), [src/mcp/tools/get-thread.ts](../../src/mcp/tools/get-thread.ts), [src/mcp/tools/search.ts](../../src/mcp/tools/search.ts) — `source: "viva-engage"` continues to flow through; the MCP surface does not know or care that the ingest path changed.
- Steering — same.

## Scope boundary

**In scope:**
1. New Yammer REST path end-to-end: auth (Entra token → Yammer audience), HTTP client, sync function pivot, CLI discovery.
2. Delete the Graph-based Viva HTTP client; remove `Community.Read.All` from the MSAL scope set.
3. Re-consent flow: existing accounts must be prompted once (at next `getTokenSilent` failure) to consent to the Yammer scope. The MSAL cache handles the silent-first path automatically once the new scope is on the first interactive login.
4. Tests + ≥90% coverage on touched files + `/security-scan` clean + `/docs-update` for changelog + user guide, per [CLAUDE.md](../../CLAUDE.md).

**Out of scope** (explicit non-goals — do not expand during implementation):
- **Legacy Yammer OAuth 2.0 tokens.** Microsoft is retiring them; Entra-only.
- **Yammer-specific app registration.** Smoke test proved the default public-client app works when the scope is added to MSAL. No new Entra app.
- **Attachments, reactions, bookmarks, @-mentions as first-class entities.** Message body + metadata only, as today.
- **Private messages / chats across networks.** Public community posts only.
- **Writing to Yammer.** Read-only forever — brief §2.
- **Backfill knobs.** Yammer's `older_than` default window is what we take. We do not add a `--viva-backfill-days` flag in this plan.
- **Dual-mode operation** (Graph for home + Yammer for external). One path. Yammer REST handles both; carrying two clients is pure toil.

## Endpoint surface (smoke-verified)

All reads, all `GET`:

| Purpose | Path | Pagination |
|---|---|---|
| List networks visible to token | `/api/v1/networks/current.json` | none (single page, ~20 networks max) |
| List groups in a network | `/api/v1/groups.json?network_id={id}` | `page={n}` |
| List top-level threads in a group | `/api/v1/messages/in_group/{group_id}.json?threaded=extended&older_than={msg_id}` | `older_than` (descending by newest) |
| Replies within a thread | `/api/v1/messages/in_thread/{thread_id}.json?older_than={msg_id}` | `older_than` |
| Single message (for retry/repair) | `/api/v1/messages/{id}.json` | n/a |

**Important Yammer quirks to encode in the client:**
- `older_than` is a message ID, not a timestamp. First request omits it; subsequent requests pass the oldest `id` from the previous page. Yammer signals end-of-stream with an empty `messages` array.
- Rate limit: **10 requests per user per app per 30 s.** The Graph client's 429 handling can be reused; retry-after is not always supplied, so we use a fixed 6 s backoff on 429s from the Yammer host.
- Host split: token audience is `api.yammer.com`, paths live at `www.yammer.com/api/v1/…`. Hard-code both; no config.
- Response shape for threads: `{messages: [...], threaded_extended: {thread_id: [reply_ids]}, references: [...]}` — the sender/user data lives in `references`, keyed by id. The client must resolve each message's `sender_id` against `references`.

## Incremental sync strategy

Yammer has no delta token. The approach in `viva_subscriptions.last_cursor_at` (ms epoch) still works — but we invert the loop:

1. On each sync tick, walk `/messages/in_group/{g}.json?threaded=extended` **descending by newest**.
2. For each page, keep messages whose `created_at > last_cursor_at`. Stop walking the moment a page's **last** message is `≤ last_cursor_at` (everything older is already ingested).
3. For every new top-level message, `listPosts(threadId)` and upsert replies.
4. Advance `last_cursor_at` to the max `created_at` seen **only on success** (same as Teams).

First-ever sync (cursor null): walk until the Yammer end-of-stream or a safety cap of N pages (parameterized, default 20 pages = ~400 messages) to avoid pulling years of history on day one.

## Slices

Each slice is a full `/tdd-cycle` (RED → GREEN → REFACTOR → COVER → SECURITY → DOCS).

### Slice 1 — MSAL scope surgery

**Goal**: one MSAL login yields both Graph-audience and Yammer-audience tokens; `getTokenSilent` accepts a `scopes` override.

**Files**: `src/auth/msal-auth-client.ts`, `src/auth/auth-client.ts`, `src/auth/msal-auth-client.test.ts`, `src/auth/types.ts` (no shape change, constants only).

**RED tests**:
- `msal-auth-client.test.ts`: `getTokenSilent(account, { scopes: ["https://api.yammer.com/user_impersonation"] })` calls MSAL's `acquireTokenSilent` with **those** scopes, not `SCOPES`.
- `msal-auth-client.test.ts`: calling `getTokenSilent(account)` with no override still uses the default Graph scopes (regression guard).
- `msal-auth-client.test.ts`: `loginWithDeviceCode` requests **both** Graph scopes and the Yammer scope in one consent so users don't re-consent later.
- `msal-auth-client.test.ts`: removing `Community.Read.All` from the default scope set — one test asserts it is **not** in `SCOPES` (this will fail until we drop it).

**GREEN**: thread `scopes?: readonly string[]` through `AuthClient.getTokenSilent`; update `MsalAuthClient.getTokenSilent` to prefer the override. Update `SCOPES` → `["Mail.Read", "Chat.Read", "https://api.yammer.com/user_impersonation"]`.

**Risk**: existing users have a cached token without the Yammer scope. MSAL's silent-first path will throw `interaction_required` on the first Yammer call. The CLI already handles this by falling back to device-code; the user experiences one extra consent prompt.

### Slice 2 — `YammerClient` interface + `FakeYammerClient` + HTTP impl

**Goal**: a typed, test-isolated client covering the five endpoints above.

**Files**: `src/sources/yammer.ts` (new), `src/sources/http-yammer-client.ts` (new), `src/sources/http-yammer-client.test.ts` (new), `src/testing/fake-yammer-client.ts` (new), `src/testing/fake-yammer-client.test.ts` (new).

**RED tests**:
- **Fake** covers: seeded networks/groups/threads/posts round-trip; `listThreads` returns newest-first; `olderThan` paginates correctly; `listPosts` resolves sender from `references`; rate-limit injection surfaces `YammerRateLimitedError`; 401 surfaces `TokenExpiredError` (reuse the one from `graph.ts`).
- **HTTP client** covers: builds `www.yammer.com` URLs regardless of token audience; sends `Authorization: Bearer …`; maps 401/429/4xx/5xx to the error classes; parses the `references` array back into typed senders; does **not** log token material (grep fixture output).
- **Cross-cutting**: fixtures contain **no real tenant IDs, group IDs, user IDs, display names, or message bodies**. All values are `00000000-…` or obviously synthetic.

**GREEN**: straightforward fetch wrapper; reuse the `FetchLike` contract from `http-graph-client.ts`.

**Security scan hook**: this is where the `/security-scan` step must assert fixtures are scrubbed. Blocking.

### Slice 3 — `sync-viva` pivot

**Goal**: the existing `syncViva` drives the new `YammerClient` unchanged from the caller's perspective.

**Files**: `src/sources/viva.ts` (reshape interface if needed — prefer keeping the same names and swapping the internals), `src/sync/sync-viva.ts`, `src/sync/sync-viva.test.ts`, delete `src/sources/http-viva-client.ts` + its test.

**Design call**: keep the `VivaClient` name as the seam so the sync code and its tests don't need a rename. Internally, `VivaClient` is now implemented by `HttpYammerClient`. The interface's method names stay (`listCommunities`, `listThreads`, `listPosts`); only the pagination argument shifts from `nextLink` to `olderThan`.

**RED tests** (extend the existing suite):
- Empty cursor → walks Yammer descending until end-of-stream or `maxPages` cap; upserts all; cursor advances to max `created_at`.
- Non-empty cursor → stops walking when a page's oldest message is `≤ cursor`; does not re-upsert.
- Rate limit mid-community → cursor for the in-flight community is **not** advanced; cursor for already-completed communities is; error is reported per-community so sibling communities still advance.
- Thread id format preserved: `viva:{networkId}:{communityId}:{conversationId}`; existing messages upsert by id without duplicates.
- Edited post (`updated_at > created_at`) → body/html overwrite on the existing row.
- Deleted thread (Yammer returns 404 on `/in_thread/{id}.json`) → swallowed per-thread, sibling threads still sync.

### Slice 4 — CLI discovery + subscribe/unsubscribe disambiguation

**Goal**: `--viva-discover` shows every community Eric can see across every network; `--viva-subscribe` uses an unambiguous id format.

**Files**: `src/cli.ts`, `src/cli.test.ts`.

**RED tests**:
- `--viva-discover --account <x>` prints header `network_permalink  network_name  community_id  display_name`; one row per (network, community); networks with zero communities are omitted (match today's "no viva communities" behavior per-network, but only globally if every network is empty).
- Exit code 0 with "no viva communities visible to this account" when **every** network returns zero groups (and there are no networks either).
- `--viva-subscribe <community_id>`: if exactly one network contains that community, auto-resolve; if multiple do, fail with `ambiguous community id: present in networks [a, b] — use --viva-subscribe <network_id>:<community_id>`; if zero, fail with `unknown community`.
- `--viva-subscribe <network_id>:<community_id>`: always unambiguous.
- `--viva-unsubscribe` unchanged shape; it already operates on `(account, community_id)`.

**GREEN**: thread the full discovery result through the CLI renderer; add the `:`-split parser.

### Slice 5 — Scheduler regression sweep + end-to-end smoke

**Goal**: full integration against a real account; prove the lake gets populated.

**Files**: none in production code — this slice is mostly verification. Possibly one docs-only change.

**Steps**:
1. `npm test` — full suite green.
2. `/security-scan` — clean.
3. `/local-smoke` — MCP `tools/list` unchanged; CLI boots on SQLite with existing schema.
4. **Live smoke** on the NAS with `eric.wauters@dynex.be`:
   - `--viva-discover --account eric.wauters@dynex.be` → must show the Microsoft network and at least one community. Screenshot-level evidence in the commit message.
   - `--viva-subscribe <a community in the Microsoft network> --account eric.wauters@dynex.be`
   - Run the sync loop once.
   - `get_recent_activity hours=168 sources=["viva-engage"]` → returns at least one message from the subscribed community.
   - Add a steering rule `thread_name_contains "<something>"` scoped `source: "viva-engage"` and confirm it hides only Viva hits.
5. `/docs-update` — [changelog](../changelog.md), [user-guide](../user-guide.md), [setup](../setup.md) (scope change is a re-consent event for existing installs and must be called out).

## Verification (definition of done)

1. `npm test` — full suite green, ≥90% line + branch coverage on every touched file ([docs/tdd/coverage-policy.md](../tdd/coverage-policy.md)).
2. `/security-scan` — clean; fixtures contain no real tenant/user/group/community data.
3. `/local-smoke` — passes.
4. Live smoke above: **message from `microsoft.onmicrosoft.com` visible in `get_recent_activity`**. This is the user-visible goal; anything short of it is not done.
5. `/docs-update` — changelog entry naming the breaking scope change; user-guide section on the new discover output format.
6. No references to `/employeeExperience/` in `src/`. `rg` check is part of the review.

## Risks / open questions

- **Re-consent UX for existing accounts.** Adding the Yammer scope to the default login set means today's cached tokens don't carry it. First `--viva-discover` after upgrade throws `interaction_required`; user runs the existing device-code flow once. Surface this in the changelog and in the CLI error message: `re-authentication required for Yammer scope — run: waldo --login --account <x>`.
- **Scope string format.** MSAL wants `https://api.yammer.com/user_impersonation` (resource-prefixed full URI) vs Yammer docs that just say "Yammer API". Smoke-verify in slice 1 by logging in once and grepping the token's `aud` claim. If the scope string is wrong, MSAL surfaces `AADSTS65001` — unambiguous.
- **Rate limits.** 10 req / user / app / 30 s is tight. On first-ever sync of a large community, pagination alone will throttle. Mitigation: `maxPagesPerSync = 20` cap (default), plus a 6 s pause between pages in the HTTP client. Parameterize so the NAS operator can slow it down further without code changes.
- **Legacy external network migration.** Microsoft is migrating external networks to the modern Engage UX "starting June 2025". If an external network has been fully migrated and its Yammer API surface is removed mid-deploy, the client must degrade gracefully (404 on `networks/current.json` for that network id → skip). Test as part of slice 2.
- **Numeric ID storage.** Yammer ids are 64-bit ints (e.g. `70210486273`). Stored as `TEXT` already in `viva_subscriptions` and in the derived `thread_id`; no concern. Worth an assertion in the sync test that ids ≥ 2^53 round-trip losslessly.
- **Privacy when logging.** The token includes a signed JWT with the user's `upn`, `oid`, and home tenant. `http-yammer-client.ts` must never log the `Authorization` header. Existing `http-graph-client.ts` redaction helper is reused.

## Non-goals (do not expand during implementation)

- No new MCP tools. Everything routes through existing `search` / `get_thread` / `get_recent_activity` / `list_threads`.
- No UI beyond the CLI.
- No Graph fallback. If Yammer is down, Viva sync is down — same contract as Teams ↔ Graph today.
- No opt-in/opt-out knob. Yammer REST becomes the only path, full stop.
