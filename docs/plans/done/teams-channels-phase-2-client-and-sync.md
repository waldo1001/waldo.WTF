# Teams Channels — Phase 2: Client interface + syncTeamsChannels (fakes only)

## Task

Define the `TeamsChannelClient` seam (interface + fake implementation) and
write `syncTeamsChannels` — the per-subscription sync function that walks
channel messages via delta + `$expand=replies`, upserts into the
`messages` table, and persists the delta cursor. Entire slice runs
against the fake client only — **no `fetch`, no real Graph**.

Prerequisites: Phase 1 merged. `teams_channel_subscriptions` table
exists. `"teams-channel"` is a valid `MessageSource`.

## Scope boundary

**IN:**
- `src/sources/teams-channel.ts` — interface + shared types.
- `src/testing/fake-teams-channel-client.ts` — scripted fake (mirror
  `src/testing/fake-viva-client.ts` or `fake-graph-client.ts`
  conventions).
- `src/sync/sync-teams-channels.ts` — pure function, dependency-injected,
  no `fetch` imports.
- Message projection: `ChannelMessage` → `Message` row mapping
  (`threadId` = top-level post id per design D3; `replyToId` threading;
  `chatType: "channel"`; fully-qualified `threadName`).
- Cursor semantics: reuse existing `chat_cursors` table keyed as
  `channel:<teamId>:<channelId>` (opaque `deltaLink`). Uses
  `store.getChatCursor` / `store.setChatCursor` unchanged.
- Backfill bootstrap: first-run uses `backfillDays` window via
  `$filter=lastModifiedDateTime gt <iso>` before the first `deltaLink`
  is persisted.
- Hard-stop errors: `TokenExpiredError`, `GraphRateLimitedError`
  propagate. All other per-subscription errors are returned in a
  `SyncTeamsChannelsResult` so Phase 5 scheduler can log per-sub.

**OUT:**
- HTTP implementation — Phase 3.
- Scheduler wiring — Phase 5.
- CLI — Phase 4.
- Reply-clip fallback to `GET /messages/{id}/replies` — deferred to
  observation (see Phase 3 notes).
- MSAL scope acquisition — Phase 5. `syncTeamsChannels` accepts a
  pre-acquired `token: string` parameter; caller (Phase 5 scheduler) is
  responsible for scope handling.

## Files to create / touch

**Create:**
- `src/sources/teams-channel.ts`
- `src/testing/fake-teams-channel-client.ts`
- `src/sync/sync-teams-channels.ts`
- `src/sync/sync-teams-channels.test.ts`

**Touch:**
- `src/sources/teams.ts` — **do not edit**. `teams-channel.ts` is its own
  seam; chat client stays narrow.
- `src/store/types.ts` — if the `ChatType` union needs confirmation it
  includes `"channel"` (already present per [types.ts:3](../../src/store/types.ts#L3), no
  change expected).

## Seams involved

| Seam | Role |
|---|---|
| **store** | `MessageStore.upsertMessages` + `getChatCursor` / `setChatCursor` + existing `TeamsChannelSubscriptionStore.setCursor` (for `lastCursorAt` display metadata) |
| **clock** | `importedAt` on every row |
| **graph-ish** | new `TeamsChannelClient` interface — fake only |
| msal | untouched (caller supplies token) |
| fs / http / logger | untouched |

## Design

### `TeamsChannelClient` interface

```ts
export interface TeamsChannelMessageBody {
  readonly contentType?: "text" | "html";
  readonly content?: string;
}

export interface TeamsChannelUser {
  readonly id?: string;
  readonly displayName?: string;
  readonly userPrincipalName?: string;
}

export interface TeamsChannelMessage {
  readonly id: string;
  readonly createdDateTime: string;
  readonly lastModifiedDateTime?: string;
  readonly messageType?: string;          // "message" | "systemEventMessage" | ...
  readonly replyToId?: string | null;
  readonly from?: { readonly user?: TeamsChannelUser } | null;
  readonly body?: TeamsChannelMessageBody;
  readonly mentions?: readonly TeamsMention[];  // reuse from teams.ts
  readonly deletedDateTime?: string | null;
  readonly "@removed"?: { readonly reason: string };
  // When the request uses $expand=replies, top-level posts carry:
  readonly replies?: readonly TeamsChannelMessage[];
  // "@odata.count" for replies is present when the reply array was clipped.
  readonly "replies@odata.count"?: number;
}

export interface TeamsJoinedTeam {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
}

export interface TeamsChannel {
  readonly id: string;
  readonly displayName: string;
  readonly membershipType?: "standard" | "private" | "shared";
}

export interface TeamsChannelMessagesPage {
  readonly value: readonly TeamsChannelMessage[];
  readonly "@odata.nextLink"?: string;
  readonly "@odata.deltaLink"?: string;
}

export interface TeamsChannelClient {
  /** Discovery only. Phase 4 CLI uses this. */
  listJoinedTeams(token: string): AsyncIterable<TeamsJoinedTeam>;
  /** Discovery only. Phase 4 CLI uses this. */
  listChannels(token: string, teamId: string): AsyncIterable<TeamsChannel>;
  /**
   * Delta query with $expand=replies. Returns:
   *  - On first call (no deltaLink, sinceIso given): initial backfill page(s).
   *  - On subsequent calls (deltaLink): just what changed.
   *
   * Pagination:
   *  - @odata.nextLink present → more pages this run, call again with { nextLink }.
   *  - @odata.deltaLink present → done for this run; persist it.
   *
   * Error mapping (real HTTP impl, not this fake):
   *  - 401 → TokenExpiredError
   *  - 429 → GraphRateLimitedError
   */
  getChannelMessagesDelta(
    token: string,
    teamId: string,
    channelId: string,
    opts: {
      readonly deltaLink?: string;
      readonly nextLink?: string;
      readonly sinceIso?: string;    // only honored when deltaLink undefined
    },
  ): Promise<TeamsChannelMessagesPage>;
}

export { TokenExpiredError, GraphRateLimitedError } from "./graph.js";
```

### `syncTeamsChannels` signature

```ts
export interface SyncTeamsChannelsDeps {
  readonly account: Account;
  readonly token: string;                              // pre-acquired by caller
  readonly client: TeamsChannelClient;
  readonly store: MessageStore;
  readonly subs: TeamsChannelSubscriptionStore;
  readonly clock: Clock;
  readonly backfillDays?: number;
}

export interface SyncTeamsChannelsSubResult {
  readonly teamId: string;
  readonly channelId: string;
  readonly added: number;
  readonly error?: string;
}

export interface SyncTeamsChannelsResult {
  readonly added: number;
  readonly removed: number;
  readonly perSubscription: readonly SyncTeamsChannelsSubResult[];
}

export async function syncTeamsChannels(
  deps: SyncTeamsChannelsDeps,
): Promise<SyncTeamsChannelsResult>;
```

Per-subscription error isolation same as Viva
([sync-viva.ts:306-311](../../src/sync/sync-viva.ts#L306-L311)): soft errors
surface in `perSubscription[*].error`; hard-stops
(`TokenExpiredError`/`GraphRateLimitedError`) abort the whole pass.

### Message projection (`channelMessageToMessage`)

Per design D3 + D5:

```
id          = teams-channel:<account>:<teamId>:<channelId>:<messageId>
source      = "teams-channel"
account     = <account.username>
nativeId    = <messageId>
threadId    = teams-channel:<teamId>:<channelId>:<rootId>      // D3
threadName  = "<teamName> / <channelName>" (+ " / " + first-40-chars-of-body for root posts)
replyToId   = teams-channel:<account>:<teamId>:<channelId>:<replyToId>   if replyToId set, else undefined
chatType    = "channel"
sentAt      = new Date(createdDateTime)
importedAt  = clock.now()
mentions    = extractMentions(message.mentions) — reuse helper from sync-teams.ts
rawJson     = JSON.stringify(message)
```

`threadId` uses `rootId` = `replyToId ?? id`. We need `teamName` /
`channelName` at projection time — threaded through from the
`TeamsChannelSubscription` row the sub-iteration is on. (This is also
why we snapshot them in Phase 1's schema.)

`messageType !== "message"` (system events like "user joined") are
skipped — they're noise and don't carry author data. Tested explicitly.

### Backfill bootstrap

First run (no persisted `chat_cursors` row for this channel):
- If `backfillDays` set: pass `sinceIso = now - backfillDays` on first
  delta call. Graph applies this server-side on the initial delta.
- If `backfillDays` undefined: full history (Graph default delta
  behavior). Loud warning in the CLI flow, not here.
- Drain all `@odata.nextLink` pages, upsert each page atomically.
- Persist the final `@odata.deltaLink` to `chat_cursors`
  (key = `channel:<teamId>:<channelId>`) **only after** all pages
  succeed. A mid-pass crash means next tick re-does the initial
  backfill — idempotent via `upsertMessages`.

Steady-state run (cursor present):
- Call delta with `{ deltaLink }`; drain nextLinks; persist new
  deltaLink. Same atomicity rule.

### Replies via `$expand=replies`

Top-level posts in the page carry a `replies[]` array. We flatten:
emit the top-level message + every reply as separate `Message` rows.
Each reply's `replyToId` field on the Graph payload gives us the thread
root.

**Clip detection**: if `replies@odata.count > replies.length`, log a
structured warning event `teams_channel_reply_clipped` with
`{ teamId, channelId, rootMessageId, returned, total }` and **continue**.
Phase 3 notes call out a future fallback to `GET /replies`. For now, we
accept partial replies rather than blocking.

## RED test list (file: `src/sync/sync-teams-channels.test.ts`)

```
- AC1: on first run with no cursor and backfillDays=30, calls delta with sinceIso = clock.now() - 30d
  - test: "first run without cursor bootstraps with sinceIso window"
  - seams: client (fake), clock, store
  - edge: sinceIso is ISO-8601 Zulu

- AC2: on subsequent run with persisted deltaLink, calls delta with that deltaLink
  - test: "subsequent run passes the persisted deltaLink"
  - seams: client, store

- AC3: drains @odata.nextLink pages before persisting final deltaLink
  - test: "drains all nextLink pages and persists only the final deltaLink"
  - seams: client, store

- AC4: top-level message + expanded replies are all upserted as separate rows
  - test: "expands replies into individual Message rows"
  - seams: store
  - edge: root replyToId=null, child replyToId=<rootId>

- AC5: top-level with zero replies produces one row
  - test: "top-level post with no replies produces one row"
  - seams: store

- AC6: @removed entries are skipped (not inserted)
  - test: "skips @removed entries"
  - seams: store
  - edge: @removed on a reply vs. on a root

- AC7: messageType !== "message" is skipped
  - test: "skips systemEventMessage rows"
  - seams: store

- AC8: threadId is teams-channel:<teamId>:<channelId>:<rootId>
  - test: "threadId uses the root post id, not the channel id"
  - seams: store
  - edge: a reply's threadId matches its root's threadId

- AC9: threadName is "<teamName> / <channelName> / <snippet>"
  - test: "threadName includes team and channel names"
  - seams: store
  - edge: root post threadName includes body snippet; replies inherit same threadName

- AC10: chatType is "channel"
  - test: "every row has chatType='channel'"
  - seams: store

- AC11: mentions are extracted
  - test: "extracts mentions into the mentions array"
  - seams: store
  - edge: reuse extractMentions helper (Phase 2 may extract to a shared util)

- AC12: rawJson is present on every row
  - test: "preserves raw Graph payload as rawJson"
  - seams: store

- AC13: importedAt is clock.now() at run time
  - test: "importedAt is set from injected clock"
  - seams: clock

- AC14: deltaLink is persisted to chat_cursors keyed as channel:<teamId>:<channelId>
  - test: "writes deltaLink to chat_cursors with channel:<teamId>:<channelId> key"
  - seams: store
  - edge: keyed string shape matches documented contract

- AC15: deltaLink is NOT persisted if any page throws mid-drain
  - test: "does not advance chat_cursors on mid-drain error"
  - seams: client, store
  - edge: idempotent retry on next tick

- AC16: subs.setCursor(account, teamId, channelId, now) is called on successful sync
  - test: "updates TeamsChannelSubscriptionStore.lastCursorAt on success"
  - seams: subs

- AC17: TokenExpiredError propagates (hard stop for the whole pass)
  - test: "propagates TokenExpiredError from the delta call"
  - seams: client

- AC18: GraphRateLimitedError propagates (hard stop)
  - test: "propagates GraphRateLimitedError"
  - seams: client

- AC19: other errors land in perSubscription[].error, do not abort other subs
  - test: "soft errors on one subscription do not block others"
  - seams: client
  - edge: two subs, first throws non-hard-stop, second must still run

- AC20: replies@odata.count > replies.length logs structured warning event
  - test: "logs teams_channel_reply_clipped when replies array is truncated"
  - seams: logger
  - edge: warning does not skip the clipped replies we DO have — they still upsert

- AC21: empty enabled-subscription list returns zero-added result, no Graph calls
  - test: "no-op when account has zero enabled subscriptions"
  - seams: subs (returns [])
```

**Total: 21 ACs, one test file.**

## Open questions / assumptions

1. **Assumption**: `$expand=replies` returns the root message's `replies`
   array inline on the **top-level** message only. Replies-of-replies
   (if Teams even supports that — it does not) would need another call.
   We treat the tree as flat: `root + direct-children`.
2. **Assumption**: `messageType` values we care about are `"message"`
   only. Other values (`"systemEventMessage"`, `"chatMessage"` etc.)
   are dropped. If the user cares about system events later, that's a
   scope widening in a follow-up slice.
3. **Assumption**: `backfillDays` defaults to whatever the scheduler
   passes (currently `WALDO_BACKFILL_DAYS` env → default 30 in
   [config.ts](../../src/config.ts)). Not this slice's concern.
4. **Open for observation**: whether Graph's `$filter=lastModifiedDateTime gt`
   is honored on the `/messages/delta` endpoint for channels. Docs say yes.
   If it's silently ignored, the backfill could be enormous. Phase 3 live
   smoke will confirm — fallback is to pass no filter and accept a
   one-time full backfill on first subscribe.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Reply clipping common in busy channels | Medium | Warning-log + accept for now; fallback call is Phase 3+ |
| `$expand=replies` not supported on delta endpoint | Low-Medium | Verified in Graph docs; Phase 3 live smoke confirms. Fallback: separate delta + per-root `/replies` fetch (expensive) |
| `chat_cursors` key collision with a chat literally named `channel:<...>` | Effectively zero — chat IDs are `19:...@thread.v2` | Documented in a code comment |
| `threadName` body-snippet encodes message body in an index column | Low privacy risk | Truncate to 40 chars, strip newlines; same pattern Viva already uses |
| Concurrent ticks: two runs for the same channel | Zero — scheduler single-flights via `isRunning` | Existing guard in [sync-scheduler.ts:60-64](../../src/sync/sync-scheduler.ts#L60-L64) |

## Out-of-scope follow-ups

- [ ] Phase 3: HTTP `TeamsChannelClient` implementation.
- [ ] Phase 4: CLI discover/subscribe/list/unsubscribe.
- [ ] Phase 5: scheduler wiring + token acquisition + graceful degradation.
- [ ] Future: reply-clip fallback to `GET /channels/{id}/messages/{rootId}/replies` — triggered by the warning counter exceeding a threshold.
- [ ] Future: `systemEventMessage` rendering (member joins, bot pins, etc.) if a real need surfaces.
