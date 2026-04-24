# Teams Channels — Phase 5: Scheduler wiring + graceful degradation

## Task

Turn the tap on. Wire `syncTeamsChannels` into `SyncScheduler` so that
every tick, for every account with ≥1 enabled subscription:

1. Acquire a token with `TEAMS_CHANNEL_SCOPES` — once per account per
   tick, cached.
2. On acquisition success, call `syncTeamsChannels`; write one
   `sync_log` row per subscription (per-sub isolation).
3. On acquisition failure with a consent/interaction error, write **one**
   `sync_log` row for the account (not N) with a clear message, and move
   on. Outlook/Chat/Viva sync are unaffected.

Simultaneously: extend all `KNOWN_SOURCES` allowlists + JSON-schema
`enum`s in MCP tools + CLI so the `"teams-channel"` source becomes
queryable by operators.

Prerequisites: Phases 1–4 merged. After this slice the feature is
**live**.

## Scope boundary

**IN:**
- `src/sync/sync-scheduler.ts` — new `teamsChannel` block modeled on the
  Viva block ([sync-scheduler.ts:166-203](../../src/sync/sync-scheduler.ts#L166-L203)).
  Skip-if-empty; per-sub sync-log row; per-account scope-acquisition
  error → one log row then skip.
- `SyncSchedulerDeps` gains `teamsChannel?: TeamsChannelClient` and
  `teamsChannelSubs?: TeamsChannelSubscriptionStore`.
- `src/index.ts` — composition root wiring. Construct
  `HttpTeamsChannelClient` + `SqliteTeamsChannelSubscriptionStore` and
  pass them in.
- Extend **all six** `KNOWN_SOURCES` allowlists + JSON `enum` fields:
  - [cli.ts:216](../../src/cli.ts#L216)
  - [mcp/tools/list-threads.ts:6](../../src/mcp/tools/list-threads.ts#L6)
    + the inline `enum` at line 45
  - [mcp/tools/get-recent-activity.ts:12](../../src/mcp/tools/get-recent-activity.ts#L12)
    + the inline `enum` at line 74
  - [mcp/tools/add-steering-rule.ts:12](../../src/mcp/tools/add-steering-rule.ts#L12)
    + the inline `enum` at line 63
  - [mcp/tools/diagnose-sync-health.ts](../../src/mcp/tools/diagnose-sync-health.ts) —
    include `"teams-channel"` in any per-source iteration and in the
    `remediation-prompts` source catalog
    ([remediation-prompts.ts:14](../../src/mcp/tools/remediation-prompts.ts#L14))
  - Any source-enum JSON schema not already covered above.
- New MSAL error taxonomy helper: `isConsentRequiredError(err)` in
  `src/auth/msal-auth-client.ts` or `src/auth/auth-client.ts`, with
  unit tests against the actual error shapes surfaced by MSAL. Used by
  the scheduler to distinguish "tenant hasn't consented"
  (log-once-skip) from "transient network failure" (propagate).
- Docs: `docs/user-guide.md` gets a new section on Teams Channels;
  `docs/setup.md` lists the new scopes and the admin-consent caveat.

**OUT:**
- Opening a Microsoft admin-consent URL from the CLI — future
  enhancement.
- Per-account suppression of repeated consent-required log rows (every
  tick will add one — monitor noise and revisit).
- Changing how `diagnose-sync-health` computes health for the new
  source — same rules as `teams`.

## Files to create / touch

**Touch:**
- `src/sync/sync-scheduler.ts` — new block after Viva.
- `src/sync/sync-scheduler.test.ts` — new cases for the block.
- `src/index.ts` — wire up real client + store.
- `src/auth/msal-auth-client.ts` — add `isConsentRequiredError` helper
  and a test (fake MSAL raising the documented error codes).
- `src/cli.ts` — widen `KNOWN_SOURCES`.
- `src/mcp/tools/list-threads.ts` — widen.
- `src/mcp/tools/get-recent-activity.ts` — widen.
- `src/mcp/tools/add-steering-rule.ts` — widen.
- `src/mcp/tools/diagnose-sync-health.ts` — extend per-source loops
  (check carefully — there's a hardcoded `"viva-engage"` branch at
  [diagnose-sync-health.ts:105](../../src/mcp/tools/diagnose-sync-health.ts#L105);
  decide whether teams-channel needs equivalent special handling).
- `src/mcp/tools/remediation-prompts.ts` — add teams-channel prompts.
- `src/mcp/tools/get-sync-status.ts` — check if any source-specific
  logic exists and widen.
- `src/mcp/tools/get-thread.ts` — no enum widening needed (accepts any
  `MessageSource`), but check.
- `docs/user-guide.md`, `docs/setup.md`, `docs/changelog.md`.

## Seams involved

| Seam | Role |
|---|---|
| **msal** | new scope acquisition path + error classification |
| **store** | `MessageStore.appendSyncLog` + `TeamsChannelSubscriptionStore.listEnabledForAccount` |
| **client** | `TeamsChannelClient` (real in prod, fake in tests) |
| clock / http / fs / logger | indirect |

## Design — the scheduler block

Follow the Viva pattern closely. Pseudocode:

```ts
if (
  this.deps.teamsChannel !== undefined &&
  this.deps.teamsChannelSubs !== undefined
) {
  const enabled = await this.deps.teamsChannelSubs
    .listEnabledForAccount(account.username);

  if (enabled.length > 0) {
    let token: AccessToken;
    try {
      token = await this.deps.auth.getTokenSilent(account, {
        scopes: TEAMS_CHANNEL_SCOPES,
      });
    } catch (err) {
      if (isConsentRequiredError(err)) {
        await this.deps.store.appendSyncLog({
          ts: this.deps.clock.now(),
          account: account.username,
          source: "teams-channel",
          status: "error",
          errorMessage:
            "admin consent required for ChannelMessage.Read.All",
        });
        errorCount += 1;
        // skip all subs for this account this tick
      } else {
        throw err;   // network / transient → let outer loop log
      }
    }

    if (token !== undefined) {
      try {
        const r = await syncTeamsChannels({
          account,
          token: token.token,
          client: this.deps.teamsChannel,
          store: this.deps.store,
          subs: this.deps.teamsChannelSubs,
          clock: this.deps.clock,
          ...(this.deps.backfillDays !== undefined && {
            backfillDays: this.deps.backfillDays,
          }),
        });
        // One log row per sub, so diagnose-sync-health can pinpoint.
        for (const p of r.perSubscription) {
          await this.deps.store.appendSyncLog({
            ts: this.deps.clock.now(),
            account: account.username,
            source: "teams-channel",
            status: p.error === undefined ? "ok" : "error",
            messagesAdded: p.added,
            ...(p.error !== undefined && { errorMessage: p.error }),
          });
        }
        okCount += r.perSubscription.filter((p) => p.error === undefined).length;
        errorCount += r.perSubscription.filter((p) => p.error !== undefined).length;
      } catch (err) {
        // Hard-stop from syncTeamsChannels (TokenExpired/RateLimited)
        await this.deps.store.appendSyncLog({
          ts: this.deps.clock.now(),
          account: account.username,
          source: "teams-channel",
          status: "error",
          errorMessage: errorToString(err),
        });
        errorCount += 1;
      }
    }
  }
}
```

### `isConsentRequiredError(err)`

Checks for:
- `err.name === "AuthError"` and `err.errorCode === "consent_required"`
  or `"interaction_required"` or `"invalid_grant"` with a body mentioning
  `AADSTS65001` (the admin-consent error code).
- Fallback: message match on `/consent|interaction_required/i`.

Implementation is small and tested in isolation against three scripted
MSAL error shapes. The helper lives beside `msal-auth-client.ts` because
that is the only file allowed to know MSAL's error vocabulary
(per [testability-patterns.md §3.5](../../docs/tdd/testability-patterns.md)).

## RED test list

### `src/sync/sync-scheduler.test.ts` (extend existing)

```
- AC1: tick with no teamsChannel/teamsChannelSubs injected skips the block
  - test: "scheduler runs normally when teamsChannel deps are omitted"
  - seams: sync-scheduler

- AC2: tick with deps but zero enabled subscriptions for the account skips Graph calls
  - test: "skips scope acquisition when no enabled subscriptions for account"
  - seams: subs (fake), auth (spy)

- AC3: consent-required error writes exactly one sync_log row per account per tick
  - test: "writes one teams-channel error row on consent_required and continues"
  - seams: auth (fake throws), store
  - edge: Outlook/Chat/Viva blocks for the same account still run

- AC4: transient auth error propagates
  - test: "propagates non-consent auth errors"
  - seams: auth

- AC5: successful pass writes one sync_log row per subscription
  - test: "writes one row per subscription on success"
  - seams: client (fake), store

- AC6: subscription with per-sub error is logged as error; siblings still logged as ok
  - test: "mixed per-sub success and error produce distinct rows"
  - seams: client, store

- AC7: hard-stop error (GraphRateLimitedError) writes one account-level error row
  - test: "maps hard-stop to a single error row"
  - seams: client, store

- AC8: Viva/Chat/Outlook blocks unaffected when teams-channel block errors
  - test: "other sources still run even when teams-channel fails"
  - seams: all

- AC9: TickSummary counters reflect per-sub outcomes
  - test: "okCount / errorCount match per-sub results"
  - seams: none
```

### `src/auth/msal-auth-client.test.ts`

```
- AC10: isConsentRequiredError returns true for errorCode=consent_required
- AC11: isConsentRequiredError returns true for errorCode=interaction_required
- AC12: isConsentRequiredError returns true for AADSTS65001 in the message
- AC13: isConsentRequiredError returns false for a generic network error
- AC14: isConsentRequiredError returns false for TokenExpiredError
- AC15: TEAMS_CHANNEL_SCOPES has exactly the three expected values
```

### MCP / CLI widening tests (across multiple test files)

```
- AC16: cli.ts KNOWN_SOURCES accepts "teams-channel"
- AC17: list-threads tool accepts source="teams-channel"
- AC18: get-recent-activity tool accepts sources=["teams-channel"]
- AC19: add-steering-rule tool accepts source="teams-channel"
- AC20: diagnose-sync-health enumerates "teams-channel" in per-source output
- AC21: remediation-prompts has an entry for "teams-channel"
```

### Integration / e2e

```
- AC22: end-to-end scheduler tick with a fake TeamsChannelClient seeded with one team, two channels, two subscriptions, one message each → exactly two messages in store, two ok rows in sync_log
  - test: in src/sync/__integration__ if the dir exists, else extend sync-scheduler.test.ts
  - seams: all real except client + auth
```

**Total: 22 ACs across several test files.**

## Open questions / assumptions

1. **Assumption**: one error row per tick per unconsented account is
   acceptable noise. If the user runs with 10 unconsented accounts on a
   5-minute interval, that's 2,880 noise rows/day. If intolerable, add a
   follow-up to suppress repeats (e.g., only log the first per rolling
   24h). Defer until we see it.
2. **Assumption**: `diagnose-sync-health` and `remediation-prompts` need
   parallel catalog entries but no special logic. Verified by reading
   them before this slice; worst case, minor refactor.
3. **Assumption**: the Viva-style `per-subscription log row` pattern
   scales. Each subscription produces one row per tick. For a user with
   50 subscribed channels on a 5-minute interval, that's 14,400
   rows/day — fine for SQLite but consider a `sync_log` rollup view
   later if `get_sync_status` gets slow.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Adding `"teams-channel"` to enums silently breaks an MCP caller that validates input strictly | Very low — we're *adding*, not removing | None needed |
| `isConsentRequiredError` matches a false positive (e.g., a transient auth-server error) and we silently swallow a real failure | Medium | Tests cover both sides; in prod, monitor for the pattern "every tick errors with consent_required then works on next boot" — that's the signature of a false match |
| `sync_log` row explosion on users with many subscriptions | Low-Medium | `get_sync_status` already aggregates; if slow, add an index |
| Composition-root breakage when wiring new deps | Medium | `src/index.ts` is exempt from coverage; rely on `/local-smoke` and `/deploy-nas` verify step |

## Out-of-scope follow-ups

- [ ] Admin-consent URL helper CLI command
      (`--teams-print-consent-url --tenant <id>`) that prints the
      admin-consent URL for a tenant.
- [ ] Rollup / debounce for per-account consent-required log rows.
- [ ] `--teams-subscribe-team <teamId>` convenience.
- [ ] Reply-clip fallback (`GET /replies`) once we see how often it
      fires in practice.
- [ ] Team/channel rename auto-refresh (on each successful sync, update
      `teams_channel_subscriptions.team_name` / `channel_name` from the
      latest row). Nice to have; not load-bearing.
- [ ] `remediation-prompts` copy: wording specific to admin-consent UX
      (link to Microsoft admin-consent docs).

## Definition of done

Feature is **live** when:

- [ ] `npm test` green, coverage ≥90% on every touched file.
- [ ] `/security-scan` PASS.
- [ ] `/local-smoke` exercises CLI + MCP dispatch.
- [ ] `/deploy-nas` deploys, runtime logs show one `teams-channel` row
      per subscription per tick for the consented accounts, and one
      error row per tick for any unconsented accounts — without
      impacting other sources.
- [ ] `docs/user-guide.md` has an operator recipe for subscribe →
      verify → unsubscribe.
- [ ] Changelog entry.
