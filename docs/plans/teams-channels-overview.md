# Teams Channels — Feature overview (5 phases)

Adding Teams **channel** messages (distinct from 1:1 / group chats
already synced) to the waldo.WTF lake. Design resolved in conversation
prior to Phase 1 plan; re-summarized here.

## Why this split

Channels differ from chats along four axes that justify five slices
rather than one mega-PR:

| Axis | Chats (today) | Channels (new) |
|---|---|---|
| Enumeration | `GET /me/chats` | `GET /me/joinedTeams` → per-team `GET /channels` |
| Scale | Dozens per user | Hundreds of teams × dozens of channels |
| Thread shape | Flat | Threaded: root post + replies |
| Incremental sync | No delta (412 on delegated) | Delta works — `/messages/delta` + `$expand=replies` |
| Permissions | `Chat.Read` (user consent) | `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All` (mostly admin consent) |
| Signal/noise | High — personal | Low — org-wide broadcasts + bots |

## Core design decisions (locked)

- **D1. Opt-in per channel**, mirroring Viva Engage's community
  subscription pattern. No "sync everything".
- **D2. New source `"teams-channel"`**, separate from `"teams"` — lets
  users mute channels independently of 1:1 chats.
- **D3. `threadId` = per top-level post**, not per channel —
  `teams-channel:<teamId>:<channelId>:<rootId>`. Matches the UX.
- **D4. Delta with `$expand=replies`** — one call returns root + inline
  replies. Reuses `chat_cursors` keyed as `channel:<teamId>:<channelId>`.
- **D5. Message id shape**:
  `teams-channel:<account>:<teamId>:<channelId>:<messageId>`.
- **D6. Admin consent is not universal** — the user can get
  `ChannelMessage.Read.All` consented in two tenants; must not break
  for the rest. New scopes stay **separate from base `SCOPES`**;
  acquired lazily per account; consent-failure degrades one account
  cleanly without blocking others.

## Phase map

| Phase | Plan | Feature state after merge |
|---|---|---|
| 1 | [teams-channels-phase-1-subscription-store.md](teams-channels-phase-1-subscription-store.md) | Dormant. Table exists; `MessageSource` union widened. |
| 2 | [teams-channels-phase-2-client-and-sync.md](teams-channels-phase-2-client-and-sync.md) | Dormant. `syncTeamsChannels` works against a fake client. |
| 3 | [teams-channels-phase-3-http-client.md](teams-channels-phase-3-http-client.md) | Dormant. Real HTTP client usable via unit tests, unwired. |
| 4 | [teams-channels-phase-4-cli.md](teams-channels-phase-4-cli.md) | User can discover + subscribe via CLI; scheduler still ignores them. |
| 5 | [teams-channels-phase-5-scheduler-wiring.md](teams-channels-phase-5-scheduler-wiring.md) | **Live.** Scheduler syncs subscribed channels every tick; unconsented tenants degrade gracefully. |

Each phase is one `/tdd-cycle`. The feature is shipped after Phase 5's
`/deploy-nas`.

## Cross-phase invariants

- **Graceful per-account degradation** (D6) is implemented in Phase 5
  but informs every interface boundary from Phase 1 onward — tokens
  are acquired per-account per-tick, never at startup; scopes are
  never baked into `SCOPES`.
- **Read-only invariant** is preserved: the new writes
  (`teams_channel_subscriptions`, `chat_cursors` reuse, `messages`
  upserts) are in the sync/CLI paths, not MCP handlers. No Graph write
  calls ever.
- **`chat_cursors` reuse**: the `chat_id` column is just a string key;
  using `channel:<teamId>:<channelId>` as the key is zero-schema-churn
  reuse. No risk of collision — real chat IDs are `19:...@thread.v2`.
- **No deviation from the existing Viva subscription UX** — everything
  the user learned from `--viva-*` applies to `--teams-*` verbatim.

## Estimated effort

Order-of-magnitude, each phase is one focused session:

| Phase | LOC est. (src + tests) | Session time est. |
|---|---|---|
| 1 | ~500 | 1 session |
| 2 | ~700 | 1–2 sessions |
| 3 | ~400 | 1 session |
| 4 | ~400 | 1 session |
| 5 | ~500 | 1–2 sessions (includes `/deploy-nas`) |

Total: ~2500 LOC, ~5–7 focused sessions.

## Future work (not in any phase)

- `--teams-subscribe-team <teamId>` convenience to subscribe to every
  current channel in a team.
- Reply-clip fallback to `GET /messages/{id}/replies` when
  `teams_channel_reply_clipped` warnings exceed a threshold.
- Admin-consent URL helper in CLI.
- Team/channel rename auto-refresh on each successful sync (or on each
  `--teams-discover` run).
- `systemEventMessage` rendering (currently dropped as noise).
