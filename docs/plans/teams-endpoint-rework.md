# Plan — Teams endpoint rework: migrate off `/me/chats/getAllMessages/delta`

> **Status:** Slice 2 shipped 2026-04-13. Delegated Teams polling is
> live on the dev db. Recap: slice 1 landed schema v4 `chat_cursors` +
> store CRUD. Slice 2 reshaped the `TeamsClient` seam (`listChats` +
> `getChatMessages`), rewrote `HttpTeamsClient` and `syncTeams` for
> polling, and added schema v5 renaming `chat_cursors.last_modified_iso
> → cursor`. Live smoke: one real account synced Teams successfully (96
> messages, 13 chat cursors); the other returned `403 Forbidden —
> Missing scope permissions`, a tenant-level policy correctly recorded
> in `sync_log`. See [../changelog.md](../changelog.md) entry for
> 2026-04-13 for full details.

## Problem statement

Live smoke on 2026-04-13 (two real accounts across two tenants, clean
db) surfaced a blocker on the Teams sync path:

```
HTTP 412 PreconditionFailed — Requested API is not supported in delegated context.
```

Both accounts, both tenants, unconditional — returned from
`GET /me/chats/getAllMessages/delta` (the endpoint
[src/sources/http-teams-client.ts](../src/sources/http-teams-client.ts) has
hit via `DEFAULT_TEAMS_DELTA_ENDPOINT` since Weekend 4 slice 4). This is
not a `$filter` issue introduced by the `WALDO_BACKFILL_DAYS` feature —
removing the filter returns the same 412.

Root cause is a Microsoft Graph architectural constraint: the
`chats/getAllMessages` family is only available with **application
permissions** + **Resource-Specific Consent (RSC)**. Under the delegated
`Mail.Read`/`Chat.Read` device-code flow waldo.WTF relies on, Graph
refuses the call unconditionally. This has been true since the endpoint
was added; it was never live-smoked until today because Weekend 4 slices
4–6 used `FakeTeamsClient` end-to-end.

Outlook is unaffected and shipping — see
[feat-backfill-days-window.md](feat-backfill-days-window.md) outcome.

## Why this is load-bearing

- Teams coverage is the whole point of Weekend 4. Without it, "check all
  accounts + both sources" (the Claude Desktop system prompt we want to
  write in Weekend 4 closeout) is a lie.
- The error is not swallowed — `sync_log` correctly records a `teams` row
  per tick per account with `lastStatus = "error"`. That signal is doing
  its job, but it means every `get_sync_status()` call from Claude
  Desktop will report `staleCount ≥ 2` forever until this is fixed.
- The fix cannot be "suppress the error". Suppressing would hide future
  regressions and would break the observability model `sync_log` exists
  for.

## Options

### Option A — Poll `/me/chats` + `/me/chats/{id}/messages`

Walk `/me/chats` to enumerate the user's 1:1 and group chats, then for each
chat pull `/me/chats/{id}/messages` (no delta). Filter client-side by
`lastModifiedDateTime` against the last seen high-water-mark stored in
`sync_state` (repurpose `deltaToken` as an ISO timestamp, or add a
companion column — TBD at FRAME time).

- ✅ Works under the existing delegated device-code flow. No new consent.
- ✅ Preserves multi-tenant / cross-tenant support (common authority).
- ✅ Keeps the existing `TeamsClient` seam and scheduler wiring —
  internals swap, shape stays, `src/index.ts` wiring is unchanged.
- ❌ Loses delta semantics. Every tick does a full scan of chat metadata
  (`/me/chats`) + a bounded-window pull per chat. More requests per tick.
- ❌ `@removed` detection is harder — Graph's non-delta `messages`
  endpoint doesn't emit tombstones. For v1 we accept "deletes become
  eventually-consistent on the Teams side", noted as a known limitation.
- ❌ Channel messages in teams (not chats) are a different endpoint
  (`/teams/{id}/channels/{id}/messages`) and not covered by
  `/me/chats`. v1 scopes down to 1:1 + group chats only, matching the
  already-open question in PROGRESS.md §Open questions.

### Option B — Application permissions + Resource-Specific Consent

Register a separate Entra app with application permissions
(`ChatMessage.Read.All` or the RSC variant), walk the client-credentials
flow, and per-tenant per-chat obtain RSC grants from each chat owner.

- ✅ Real delta semantics. Real `@removed`. Lowest Graph quota cost.
- ❌ Dead on arrival for waldo.WTF's target (customer tenants,
  cross-tenant guest accounts). Admin consent is required in every
  tenant; RSC requires chat-owner consent per chat. Neither will be
  granted for a personal tool that pulls arbitrary historical chats.
- ❌ Changes the auth model from "device code, zero admin involvement"
  to "per-tenant admin ceremony". Non-starter for the multi-account
  story.

### Option C — Drop Teams from v1

Remove `syncTeams` + `HttpTeamsClient` + schema v3 Teams columns (or
leave the columns dormant). Ship Outlook-only until Microsoft changes the
delegated story.

- ✅ Smallest surface. Honest about what works.
- ❌ Gives up on one of the two stated v1 sources. Weekend 4 would have
  produced nothing shipping. Also, future revival requires undoing all
  the schema + seam work.

## Recommendation

**Option A (polling).** It's the only delegated-compatible path that
preserves the multi-tenant device-code auth model. The cost is real —
losing delta semantics means heavier Graph usage per tick and weaker
delete detection — but v1 is a personal lake with two accounts, not a
production sync engine, and the scheduler ticks every 5 minutes. The
polling cost is well under Graph's delegated quota ceiling.

Keep the `HttpTeamsClient` file (and therefore `src/index.ts` +
scheduler wiring). Swap its internals so the seam stays stable and the
rest of the stack doesn't ripple. `DEFAULT_TEAMS_DELTA_ENDPOINT` gets
renamed or deleted — TBD at FRAME time.

Two open questions to answer at FRAME time, flagged in the parent
wrap-up plan:

1. Polling-per-chat means N+1 requests per tick per account. Do we
   cache the chat list between ticks to avoid re-enumerating, and if so
   where (sync_state row, in-memory on the scheduler)?
2. How do we represent the "last seen per chat" cursor in `sync_state`
   so it round-trips through the existing schema without a v4
   migration? (A JSON blob under `deltaToken`? A new `cursor_json`
   column? v4 migration?)

## Scope boundary

**IN** (when this cycle runs, not now)

- Swap `HttpTeamsClient` internals to poll `/me/chats` +
  `/me/chats/{id}/messages`.
- Update `syncTeams` to drive the new client shape. Keep the mapping to
  `Message` (schema v3 is already right — `chatType`, `replyToId`,
  `mentions` still apply).
- Per-chat high-water-mark storage. Schema v4 migration if needed.
- `TeamsClient` seam may need a new method (e.g.
  `listChats()` + `getMessages(chatId, sinceIso)`) — confirm at FRAME
  time. The existing `getDelta(url, token)` method likely goes away, so
  callers update too.
- `FakeTeamsClient` updated to match the new seam shape.
- Live smoke against both real accounts on a clean db, just like the
  backfill feature got.

**OUT**

- Channel messages in Teams (teams → channels → messages). Deferred. v1
  stays 1:1 + group chats only.
- Real-time `@removed` detection. v1 accepts eventual consistency on
  deletes.
- Per-chat backfill window. Use the existing `WALDO_BACKFILL_DAYS`
  global value, filtered client-side.
- Surfacing a per-chat cursor via `get_sync_status`. Separate concern.

## RED test list (scaffold)

To be finalized at FRAME time. Starting points:

- `HttpTeamsClient.listChats()` walks `/me/chats` with `nextLink`
  paging; 401/410/429 still map to the existing error types.
- `HttpTeamsClient.getMessages(chatId, sinceIso)` composes
  `/me/chats/{id}/messages?$filter=lastModifiedDateTime ge <iso>` and
  walks `nextLink`.
- `syncTeams` iterates the chat list, for each chat reads the stored
  high-water-mark, fetches since that mark, upserts, and updates the
  mark on success only.
- `syncTeams` on a chat-level failure records the error but continues
  to the next chat (chat-level isolation, same spirit as the existing
  source-level isolation).
- `WALDO_BACKFILL_DAYS` still bounds the **initial** per-chat window
  (no stored high-water-mark yet) — parallels the Outlook behavior.
- Token-expired / rate-limited errors propagate up and halt the tick
  for that account, as today.

## Risks

- Per-tick Graph request volume on active users. Mitigate by honoring
  `nextLink` paging and not refetching chats with unchanged
  `lastMessagePreview.lastModifiedDateTime` (optimization, not a
  correctness concern).
- Schema migration v4 if we need a new cursor column. Additive-only, so
  low risk, but it's the first v4 and needs the migration test suite
  updated.
- Two existing tests (`sync-teams.test.ts`, `http-teams-client.test.ts`)
  assume the delta endpoint shape. They'll need to be rewritten, not
  patched.

## Out-of-scope follow-ups

- Teams channel messages (`/teams/{id}/channels/{id}/messages`).
- Real `@removed` semantics once/if Graph opens delegated `getAllMessages`.
- A Graph-side quota dashboard or per-tick budget guard.
