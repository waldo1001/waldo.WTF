# Teams Channels — Phase 1: Subscription store + "teams-channel" MessageSource

## Task

Add a new local store, `TeamsChannelSubscriptionStore`, that records which
Teams channels the user has opted into syncing — plus schema migration v14
and the new `"teams-channel"` value on the `MessageSource` union. **No sync
code, no CLI flags, no MCP exposure, no scope acquisition.** Feature is
dormant after this slice: nothing calls the store outside its own tests.

This is Phase 1 of 5 in the Teams Channels feature. Design locked in the
prior conversation thread: per-channel opt-in mirroring Viva, `threadId` =
per top-level post, reuse `chat_cursors` for delta links, graceful
per-account degradation for tenants without `ChannelMessage.Read.All`
consent.

## Scope boundary

**IN:**
- New `MessageSource` member: `"teams-channel"` (type union widening only —
  no downstream allowlist changes).
- Schema migration v14: creates `teams_channel_subscriptions` table.
- New store contract + SQLite impl + in-memory test double.
- New types: `TeamsChannelSubscription`, `AddTeamsChannelSubscriptionInput`.
- Contract tests (17 cases) + migration tests.

**OUT (deferred to later phases):**
- `TeamsChannelClient` interface + HTTP impl — Phase 2/3.
- `syncTeamsChannels` function — Phase 2.
- CLI flags (`--teams-discover`, `--teams-subscribe`, `--teams-list`,
  `--teams-unsubscribe`) — Phase 4.
- Scheduler wiring — Phase 5.
- New MSAL scopes (`Team.ReadBasic.All`, `Channel.ReadBasic.All`,
  `ChannelMessage.Read.All`) — Phase 5.
- Per-account graceful-degradation error mapping — Phase 5.
- Extending MCP tool input `KNOWN_SOURCES` allowlists
  ([add-steering-rule.ts:12](../../src/mcp/tools/add-steering-rule.ts#L12),
  [get-recent-activity.ts:12](../../src/mcp/tools/get-recent-activity.ts#L12),
  [list-threads.ts:6](../../src/mcp/tools/list-threads.ts#L6),
  [diagnose-sync-health.ts](../../src/mcp/tools/diagnose-sync-health.ts),
  [get-sync-status.ts](../../src/mcp/tools/get-sync-status.ts),
  [get-thread.ts](../../src/mcp/tools/get-thread.ts)) — deliberately frozen
  at `["outlook","teams","whatsapp","viva-engage"]` until Phase 5 surfaces
  the feature. If a Phase-1 MCP caller passed `source: "teams-channel"`
  they'd get a validation error, which is the correct behavior while the
  store is empty.
- CLI `KNOWN_SOURCES` in [cli.ts:216](../../src/cli.ts#L216) — same reason.

## Files to create / touch

**Create:**
- `src/store/teams-channel-subscription-store-contract.ts` — shared contract suite.
- `src/store/teams-channel-subscription-store.ts` — `SqliteTeamsChannelSubscriptionStore` + interface + input validator.
- `src/store/teams-channel-subscription-store.test.ts` — runs contract against SQLite + in-memory impl; includes migration-v14 DDL tests.
- `src/testing/in-memory-teams-channel-subscription-store.ts` — test double.

**Touch:**
- `src/store/types.ts` — widen `MessageSource` union with `"teams-channel"`; add `TeamsChannelSubscription` + `AddTeamsChannelSubscriptionInput` interfaces.
- `src/store/schema.ts` — bump `CURRENT_SCHEMA_VERSION` 13 → 14; add `MIGRATION_14` DDL; add to `applyMigrations` chain.

## Seams involved

| Seam | Role |
|---|---|
| **store** | new SQLite table + in-memory equivalent |
| **clock** | `FakeClock` for deterministic `subscribedAt` in contract tests |
| msal | untouched (scope additions deferred to Phase 5) |
| graph | untouched (no Graph calls) |
| fs | untouched |
| http | untouched |
| logger | untouched |

Mirrors the exact seam profile of
[viva-subscription-store.ts](../../src/store/viva-subscription-store.ts) —
same Deps shape (`Database`, `Clock`), same `StoreError` kinds, same
async-everywhere interface for future-proofing.

## Schema — migration v14

```sql
CREATE TABLE IF NOT EXISTS teams_channel_subscriptions (
  account TEXT NOT NULL,
  team_id TEXT NOT NULL,
  team_name TEXT,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  subscribed_at INTEGER NOT NULL,
  last_cursor_at INTEGER,
  PRIMARY KEY (account, team_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_tcs_account_enabled
  ON teams_channel_subscriptions(account, enabled);
```

Three-tuple primary key `(account, team_id, channel_id)`. The `team_id` leg
defends against theoretical channel-id collisions across teams and makes
"unsubscribe from one channel of a team" well-defined without joins. Index
matches the Phase-5 scheduler skip-if-empty query
(`listEnabledForAccount`).

`last_cursor_at` is display/observability metadata only — a "last synced
successfully at" marker for the future `--teams-list` CLI. The actual
delta-link cursor lives in `chat_cursors` (reused, keyed by
`channel:<teamId>:<channelId>`), which is **not** touched by this slice.

Additive migration only. No data mutation on upgrade from v13.

## Store interface

```ts
export interface TeamsChannelSubscriptionStore {
  subscribe(input: AddTeamsChannelSubscriptionInput): Promise<TeamsChannelSubscription>;
  unsubscribe(account: string, teamId: string, channelId: string): Promise<{ removed: boolean }>;
  listForAccount(account: string): Promise<readonly TeamsChannelSubscription[]>;
  listEnabledForAccount(account: string): Promise<readonly TeamsChannelSubscription[]>;
  listAll(): Promise<readonly TeamsChannelSubscription[]>;
  setCursor(account: string, teamId: string, channelId: string, at: Date): Promise<void>;
  toggleEnabled(account: string, teamId: string, channelId: string, enabled: boolean): Promise<TeamsChannelSubscription | null>;
}
```

```ts
export interface TeamsChannelSubscription {
  readonly account: string;
  readonly teamId: string;
  readonly teamName?: string;
  readonly channelId: string;
  readonly channelName?: string;
  readonly enabled: boolean;
  readonly subscribedAt: Date;
  readonly lastCursorAt?: Date;
}

export interface AddTeamsChannelSubscriptionInput {
  readonly account: string;
  readonly teamId: string;
  readonly teamName?: string;
  readonly channelId: string;
  readonly channelName?: string;
}
```

Note: **no `tenantId` field.** Unlike Viva, Teams channel tokens always use
the user's home-tenant authority — even for shared channels that host
cross-tenant members, the Graph call uses the authenticated user's token.
Keeping the schema narrower than Viva is correct.

## RED test list

### Schema / migration (file: `src/store/teams-channel-subscription-store.test.ts`)

```
- AC1: migration v14 creates teams_channel_subscriptions with all 8 columns
  - test: "adds teams_channel_subscriptions table with expected columns"
  - seams: store
  - edge: pragma table_info assertion

- AC2: migration v14 creates idx_tcs_account_enabled index
  - test: "creates account+enabled index for scheduler skip-if-empty queries"
  - seams: store

- AC3: migration v14 bumps user_version to 14
  - test: "bumps user_version to 14"
  - seams: store

- AC4: migration v14 is idempotent on a v13 DB with existing data
  - test: "preserves pre-v14 rows in sibling tables (viva_subscriptions)"
  - seams: store
  - edge: pre-load viva_subscriptions row, set user_version=13, applyMigrations, assert row still present + new table exists
```

### Store contract (file: `src/store/teams-channel-subscription-store-contract.ts`, run from test file against both impls)

```
- AC5: subscribe stores a row enabled=true with subscribedAt and no cursor
  - test: "subscribe stores a row enabled=true with subscribedAt and no cursor"
  - seams: store, clock
  - edge: optional fields undefined on read-back

- AC6: subscribe round-trips teamName + channelName
  - test: "subscribe round-trips teamName and channelName"
  - seams: store

- AC7: subscribe rejects empty account/teamId/channelId with StoreError
  - test: "subscribe rejects empty account/teamId/channelId with StoreError"
  - seams: store
  - edge: three separate empty-string cases

- AC8: subscribe rejects duplicate (account, teamId, channelId) with StoreError(conflict)
  - test: "subscribe rejects duplicate (account, teamId, channelId) with StoreError"
  - seams: store
  - edge: UNIQUE constraint → StoreError kind=conflict

- AC9: subscribe allows the same channelId under different accounts
  - test: "subscribe allows the same channelId under different accounts"
  - seams: store

- AC10: subscribe allows the same channelId under same account but different teamId
  - test: "subscribe allows the same channelId across different teams for one account"
  - seams: store
  - edge: defensive — defends against hypothetical cross-team channel-id collisions; proves the 3-tuple key

- AC11: listForAccount returns [] for an unknown account
  - test: "listForAccount returns [] for an unknown account"
  - seams: store

- AC12: listForAccount returns rows ordered by subscribedAt ASC, then (teamId, channelId) ASC
  - test: "listForAccount returns rows ordered by subscribedAt ASC"
  - seams: store, clock
  - edge: clock must tick between inserts

- AC13: unsubscribe removes by triple, reports removed=true then false on second call
  - test: "unsubscribe removes by (account, teamId, channelId) and reports removed=true; second call false"
  - seams: store

- AC14: unsubscribe is scoped to account
  - test: "unsubscribe is scoped to the given account"
  - seams: store
  - edge: two accounts with same (teamId, channelId); removing from one doesn't touch the other

- AC15: setCursor updates lastCursorAt, readable via listForAccount
  - test: "setCursor updates lastCursorAt and is read back via listForAccount"
  - seams: store

- AC16: setCursor on missing subscription is a no-op (no throw, no row created)
  - test: "setCursor on a missing subscription is a no-op"
  - seams: store

- AC17: toggleEnabled flips and returns updated row
  - test: "toggleEnabled flips the enabled flag and returns the updated row"
  - seams: store

- AC18: toggleEnabled returns null for missing subscription
  - test: "toggleEnabled returns null for a missing subscription"
  - seams: store

- AC19: listAll returns [] on empty store
  - test: "listAll returns [] on an empty store"
  - seams: store

- AC20: listAll returns every row sorted (account ASC, teamId ASC, channelId ASC)
  - test: "listAll returns every row across accounts, sorted"
  - seams: store

- AC21: listEnabledForAccount returns only enabled rows
  - test: "listEnabledForAccount returns only enabled rows"
  - seams: store
```

### Type-level (file: compile check, plus spot test)

```
- AC22: "teams-channel" is a valid MessageSource
  - test: "MessageSource accepts 'teams-channel' as a literal"
  - seams: none (type-level)
  - edge: one-line vitest assertion that a const of the new literal compiles and round-trips
```

**Total: 22 ACs, 4 migration tests + 17 contract tests run twice (once per impl) + 1 type test.**

## Open questions / assumptions

Two assumptions flagged — proceeding unless user corrects before GREEN.

1. **Assumption**: No runtime allowlist updates in Phase 1 (MCP
   `KNOWN_SOURCES`, CLI `KNOWN_SOURCES`, JSON-schema `enum`s). Rationale:
   feature is dormant; exposing the new source on input validators while
   the store is empty creates a surface where a caller could filter by a
   value that will never match any row. Phase 5 flips these on atomically
   with scheduler wiring.
2. **Assumption**: No new error type added for
   "admin-consent-required-for-this-tenant". That's a Phase-5 concern
   raised at scope-acquisition time, not a store concern.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Widening `MessageSource` breaks an exhaustive `switch` somewhere | Low — none found in grep of `src/` | If `tsc --noEmit` fails, add a `"teams-channel"` case that throws "feature dormant" — those sites must all be Phase 5 updates anyway |
| Migration v14 breaks on an existing deployed `lake.db` on the NAS | Very low — additive-only DDL | Migration test asserts pre-v14 data survives; plan says `/deploy-nas` not run in this slice |
| Contract test drift from Viva precedent | Low | Contract is a near-mechanical copy of `viva-subscription-store-contract.ts`; review diff side-by-side in REFACTOR |
| Three-tuple primary key makes fakes awkward | Low | `key()` helper in in-memory impl concatenates with a reserved separator (`\t` or a tuple-safe encoding) |

## Out-of-scope follow-ups (explicit so they don't get lost)

- [ ] **Phase 2**: `TeamsChannelClient` interface (listJoinedTeams,
      listChannels, getMessagesDelta with `$expand=replies`) + fake +
      `syncTeamsChannels` function tested with fakes only.
- [ ] **Phase 3**: HTTP impl of `TeamsChannelClient` against
      `graph.microsoft.com`, delta query with `$expand=replies`, reply-clip
      fallback to `GET /messages/{id}/replies` deferred until observed.
- [ ] **Phase 4**: CLI flags `--teams-discover`, `--teams-list`,
      `--teams-subscribe <teamId>:<channelId>`, `--teams-unsubscribe`.
      Discover is the canary for admin-consent failures.
- [ ] **Phase 5**: Scheduler wiring (skip-if-no-subscriptions, one
      sync-log row per subscription, hard-stop on rate-limit / token
      expiry). Add `TEAMS_CHANNEL_SCOPES` separate from base `SCOPES`.
      Map `consent_required` / `InteractionRequired` MSAL errors to a
      single `sync_log` row per account per tick. Extend all 6
      `KNOWN_SOURCES` allowlists + JSON-schema `enum`s to include
      `"teams-channel"`.
- [ ] **Phase 5+**: Consider `--teams-subscribe-team <teamId>` convenience
      wrapper that subscribes to every standard channel of a team.
- [ ] **Later**: Refresh `team_name` / `channel_name` on each
      `--teams-discover` run (not just at subscribe time) — handles
      renames.
