# Teams Channels — Phase 4: CLI discover / list / subscribe / unsubscribe

## Task

Add `--teams-discover`, `--teams-list`, `--teams-subscribe`, and
`--teams-unsubscribe` CLI commands so the user can pick which Teams
channels flow into the lake. Mirrors the existing `--viva-*` CLI surface
([cli.ts:411-456](../../src/cli.ts#L411-L456)). Feature is still
**dormant in the scheduler** — this slice only lets the user populate
`teams_channel_subscriptions`. Phase 5 turns the tap on.

Prerequisites: Phases 1–3 merged. Subscription store, `syncTeamsChannels`
(fakes only), and `HttpTeamsChannelClient` all landed.

## Scope boundary

**IN:**
- Four CLI commands (mutually exclusive per invocation, like
  `--viva-*`):
  - `--teams-discover --account <u>` — calls `listJoinedTeams` +
    `listChannels` and prints a tab-separated table.
  - `--teams-list --account <u>` — reads subscriptions and prints them.
  - `--teams-subscribe <teamId>:<channelId> --account <u>` — writes a
    subscription row. Refuses if the pair is not in the current discover
    output (safety check: `--teams-subscribe-force` escape hatch? no —
    keep it simple, no force flag).
  - `--teams-unsubscribe <teamId>:<channelId> --account <u>` — deletes.
- CLI dispatcher and result types (`TeamsCliCommand`, `TeamsCliResult`).
- Refresh `team_name` / `channel_name` on discover — on re-subscribe,
  the fresh name overwrites the stored one. (Covers team/channel
  renames per design decision from prior conversation.)
- The discover path acquires the channel scope via `auth.getTokenSilent`
  with the new `TEAMS_CHANNEL_SCOPES` array. **This is the first place
  the new scopes are used.** On failure (interaction_required /
  consent_required), print a clear operator message and exit non-zero.
  This makes discover the "canary" per design D1.

**OUT:**
- Scheduler wiring — Phase 5.
- `TEAMS_CHANNEL_SCOPES` added to base `SCOPES` array —  **no**, they
  stay separate. Phase 5 also does not add them to base.
- CLI-level `--teams-subscribe-team <teamId>` convenience command —
  deferred.
- Expanding CLI's `KNOWN_SOURCES` in [cli.ts:216-221](../../src/cli.ts#L216-L221) —
  Phase 5, atomic with scheduler turn-on.

## Files to create / touch

**Touch:**
- `src/cli.ts` — new command types, parser entries, dispatcher,
  printer. Follow `--viva-*` shape 1:1.
- `src/cli.test.ts` — add test cases for parsing and dispatch.
- `src/auth/msal-auth-client.ts` — **only** add
  `export const TEAMS_CHANNEL_SCOPES = [...] as const;`. No change to
  base `SCOPES`. Tests: one compile-time spot test that the array is
  exported with the three expected members.
- `src/index.ts` — construction-root: when the CLI resolves a
  `TeamsCliCommand`, construct the real `HttpTeamsChannelClient` and the
  `SqliteTeamsChannelSubscriptionStore` and pass both to the dispatcher.
  Tested via the existing e2e-http path plus a narrow new smoke (see
  risks).

**Create:**
- Fixtures in `src/__fixtures__/teams-channel-discovery/` — example
  joinedTeams + channels responses for parser tests (anonymized).

## Seams involved

| Seam | Role |
|---|---|
| **msal** | new `TEAMS_CHANNEL_SCOPES` constant, used by discover |
| **store** | `TeamsChannelSubscriptionStore` (from Phase 1) |
| **client** | `TeamsChannelClient` (from Phase 2/3); fake for tests, real for live CLI |
| clock | subscribedAt timestamps |
| fs / logger / http | untouched directly (http reached via client) |

## Design — CLI grammar

Add to `BOOLEAN_FLAGS`:
```
"--teams-discover", "--teams-list"
```

Add to (new) `TEAMS_VALUE_FLAGS`:
```
"--teams-subscribe", "--teams-unsubscribe"
```

Parse `<teamId>:<channelId>` via a small helper
`parseTeamChannelKey(raw: string): { teamId: string; channelId: string }`
that throws `CliUsageError` on malformed input. Both fields must be
non-empty after split.

Mutual-exclusion check mirrors Viva's `activeCount > 1` test
([cli.ts:418-425](../../src/cli.ts#L418-L425)).

## Result types

```ts
type TeamsCliResult =
  | {
      readonly action: "list";
      readonly subs: readonly TeamsChannelSubscription[];
    }
  | {
      readonly action: "discover";
      readonly entries: readonly {
        readonly teamId: string;
        readonly teamName: string;
        readonly channelId: string;
        readonly channelName: string;
        readonly membershipType?: "standard" | "private" | "shared";
        readonly alreadySubscribed: boolean;
      }[];
    }
  | {
      readonly action: "subscribe";
      readonly sub: TeamsChannelSubscription;
    }
  | {
      readonly action: "unsubscribe";
      readonly removed: boolean;
    };
```

### Discover printer

Tab-separated:
```
team_id    team_name    channel_id    channel_name    type    subscribed
<...>      Contoso R&D  <...>         General         std     no
<...>      Contoso R&D  <...>         Announcements   std     yes
```

### Subscribe safety check

`--teams-subscribe` calls discover first (burns one API round-trip, but
is the safest guard against fat-fingering a channelId) and refuses if
the pair isn't found. Prints:
```
error: channel <channelId> not found in team <teamId> for account <u>.
run --teams-discover to see visible channels.
```

### Admin-consent canary

Discover calls:
```ts
await auth.getTokenSilent(account, { scopes: TEAMS_CHANNEL_SCOPES });
```

On MSAL `interaction_required` / `consent_required` (surfaced as
`AuthError` per [types.ts](../../src/auth/types.ts)):
```
error: this tenant has not consented to ChannelMessage.Read.All.
ask a tenant admin to grant admin consent for the app, or use a
different --account.
```
Exit non-zero. Other errors bubble up normally.

## RED test list (file: `src/cli.test.ts` — extend existing)

```
- AC1: parser accepts --teams-discover with --account
  - test: "parses --teams-discover as a discover command"
  - seams: none

- AC2: parser rejects --teams-discover without --account
  - test: "rejects --teams-* commands without --account"
  - seams: none

- AC3: parser accepts --teams-list with --account
  - test: "parses --teams-list as a list command"
  - seams: none

- AC4: parser accepts --teams-subscribe <teamId>:<channelId>
  - test: "parses --teams-subscribe with a well-formed key"
  - seams: none

- AC5: parser rejects --teams-subscribe with empty key / missing colon / empty part
  - test: "rejects malformed --teams-subscribe values"
  - seams: none
  - edge: "" | ":" | "team:" | ":chan"

- AC6: parser accepts --teams-unsubscribe <teamId>:<channelId>
  - test: "parses --teams-unsubscribe"
  - seams: none

- AC7: parser refuses more than one --teams-* per invocation
  - test: "rejects two --teams-* flags at once"
  - seams: none

- AC8: discover dispatcher lists joined teams, enumerates channels, flags subscribed pairs
  - test: "discover returns entries with alreadySubscribed reflecting the store"
  - seams: client (fake), store (in-memory)

- AC9: discover surfaces AuthError("consent_required") with a clear operator message
  - test: "discover reports a clear message on consent_required"
  - seams: msal (fake)

- AC10: list dispatcher returns subscriptions ordered by subscribedAt ASC
  - test: "list returns subscriptions for the given account"
  - seams: store

- AC11: subscribe refuses an unknown (teamId, channelId) pair
  - test: "subscribe refuses a pair not in discover output"
  - seams: client, store

- AC12: subscribe stores a row with team/channel names from discover
  - test: "subscribe persists names from the discover call"
  - seams: client, store

- AC13: subscribe refreshes team/channel names if row already exists? → no, subscribe is insert-only; conflict → StoreError → printed
  - test: "subscribe on an existing pair surfaces StoreError(conflict) with a helpful message"
  - seams: store

- AC14: unsubscribe removes and reports
  - test: "unsubscribe removes a row and reports removed=true"
  - seams: store

- AC15: unsubscribe on unknown pair reports removed=false (not an error)
  - test: "unsubscribe on an unknown pair reports no-op, exit 0"
  - seams: store

- AC16: TEAMS_CHANNEL_SCOPES exports exactly the three expected scope strings
  - test: "TEAMS_CHANNEL_SCOPES exports ChannelMessage.Read.All, Team.ReadBasic.All, Channel.ReadBasic.All"
  - seams: none
```

**Total: 16 ACs.**

## Open questions / assumptions

1. **Assumption**: `auth.getTokenSilent` with new scopes on an
   unconsented tenant fails with a typed `AuthError` whose `message`
   contains `consent_required` or `interaction_required`. If MSAL
   surfaces a different code in practice, the matcher in the canary
   logic will need an update. Verify in Phase 4 live smoke against one
   of the 20 tenants.
2. **Assumption**: Discover does not cache results — every invocation
   fetches fresh. That's fine for CLI speed (O(teams × channels) is a
   few dozen HTTP calls for a typical user). If a user has 500+ teams
   we may want caching later.
3. **Assumption**: `--teams-subscribe` refusing unknown pairs is a
   strict net-positive UX (vs. a `--force` escape). Revisit only if
   the discover call is chronically broken.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `--teams-discover` slow on users with hundreds of teams | Medium | Print teams as they stream; don't buffer the whole list before printing |
| Admin-consent error from MSAL has a different code than expected | Medium | Live smoke catches it; fallback matcher is `error.message.toLowerCase().includes("consent")` or `.includes("interaction_required")` |
| User runs `--teams-subscribe` against an account whose tenant hasn't consented | Low | Subscribe path also calls discover first, so it hits the same canary |
| Printing tab-separated long team/channel names gets messy | Low | Accept; `--json` output flag is a possible follow-up |

## Out-of-scope follow-ups

- [ ] Phase 5: scheduler wiring. Once that merges, every unconsented
      account writes a single `sync_log` error row per tick — monitor for
      noise and consider a "consent is required; muted until admin
      consents" dampener.
- [ ] `--teams-subscribe-team <teamId>` convenience to subscribe to every
      current channel in a team. Low-effort; add when a user asks.
- [ ] `--teams-discover --json` for scripting.
- [ ] Caching discover output for a short TTL to speed up
      `--teams-subscribe` when chained after `--teams-discover`.
