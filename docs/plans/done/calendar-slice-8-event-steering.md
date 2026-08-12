# Calendar — Slice 8: steering rules apply to events

Parent: [calendar-overview.md](../calendar-overview.md). Predecessors:
[slice 6](./calendar-slice-6-mcp-and-cli.md),
[slice 7](./calendar-slice-7-unified-activity.md).

## Task

Extend the steering system so the user can mute meetings the same
way they mute message senders, with two new event-specific predicate
types and a single shared filter that applies to both
`find_events` and the event side of `get_recent_activity`.

## Scope boundary

**IN this slice**

- New predicate types in `steering_rules.rule_type` (schema bump
  v16 → v17 — purely an enum widening; no DDL needed if the column
  is `TEXT`, but we record the bump in `applyMigrations` for the
  audit trail and to gate the new MCP tools' acceptance):
  - `event_organizer_email` — exact match on
    `events.organizer_email` (the column slice 1 may have called
    something different — confirm during FRAME; alias if needed).
  - `event_subject_contains` — substring match on `events.subject`,
    case-insensitive, **not** FTS-backed (events aren't in FTS5 in
    the base feature; substring is fine for the volumes involved).
- Existing predicate types remain message-only:
  - `sender_email`, `sender_domain`, `thread_id`,
    `thread_name_contains`, `body_contains` continue to apply only
    to messages. Rationale: a user muting a noisy sender doesn't
    expect their meeting invitations to disappear too. Make this
    decision explicit in the changelog.
- Extend `buildSteeringPredicate` to accept a `target: "message" |
  "event"` argument and emit:
  - For `target: "message"`: same SQL as today (no behaviour change).
  - For `target: "event"`: SQL filtering against `events` columns,
    using only the two new predicate types. Returns a no-op
    predicate if no event-targeted rules are enabled.
- Wire the event-targeted predicate into:
  - `MessageStore.findEvents` from slice 6.
  - `MessageStore.getRecentItems` (event branch only) from slice 7.
  - `MessageStore.getEventsInRange` from slice 1, but **only when
    called from a tool that has the `applySteering: true` flag**.
    The store-level method itself stays unfiltered; the steering
    application sits at the boundary so `get_event` (slice 5) and
    any future tool with a "show me everything" semantic stay
    pristine.
- Honour the `include_muted` escape hatch on
  `find_events` and `get_recent_activity` exactly as
  `search` and `get_recent_activity` do today:
  - `include_muted: false` (default) — apply both message-targeted
    and event-targeted predicates.
  - `include_muted: true` — bypass.
- New MCP tool inputs accept the two new rule types:
  - `add_steering_rule(rule_type, value, ...)` — accepts
    `"event_organizer_email"` and `"event_subject_contains"`.
  - `get_steering` — returns them in the listing.
  - `remove_steering_rule` / `set_steering_enabled` — operate by
    rule id, no enum change needed.
- New CLI flags for parity:
  - `--steer-event-organizer <email>` / `--steer-event-subject <text>`
    — adds the rule.
  - `--steer-list` continues to work; its output gains the new types.

**OUT (deferred)**

- A `kind` predicate ("mute all events" or "mute all messages") —
  speculative. The user can today disable a rule type via
  `set_steering_enabled`; a global kind-mute is more like a UI
  toggle than a steering rule. Defer.
- FTS-backed `event_subject_contains`. Substring is enough for the
  base feature.
- Steering on `get_event` (slice 5) — explicit carve-out, mirroring
  `get_thread`. No change here.

## Files to create / touch

- [src/store/schema.ts](../../../src/store/schema.ts) — bump to v17,
  no-op `migrateV17`.
- [src/store/schema.test.ts](../../../src/store/schema.test.ts) —
  v16 → v17 idempotency.
- [src/store/steering-store.ts](../../../src/store/steering-store.ts)
  — accept the two new `rule_type` values; reject anything else
  with `InvalidParams` (existing pattern).
- [src/store/steering-store.test.ts](../../../src/store/steering-store.test.ts)
  — extended tests.
- [src/store/steering-filter.ts](../../../src/store/steering-filter.ts)
  — `buildSteeringPredicate({rules, target}: ...)`.
- [src/store/steering-filter.test.ts](../../../src/store/steering-filter.test.ts)
  — extended tests.
- [src/store/sqlite-message-store.ts](../../../src/store/sqlite-message-store.ts)
  — wire predicate into `findEvents`, event branch of
  `getRecentItems`.
- (in-memory fake) — same.
- [src/mcp/tools/find-events.ts](../../../src/mcp/tools/find-events.ts)
  — accept `include_muted`, default false. (Renamed from
  `get-upcoming-events.ts` in slice 6, before this slice started.)
- [src/mcp/tools/get-recent-activity.ts](../../../src/mcp/tools/get-recent-activity.ts)
  — confirm `include_muted` already there from prior steering
  rollout; gate event branch on it.
- [src/mcp/tools/add-steering-rule.ts](../../../src/mcp/tools/add-steering-rule.ts)
  — extend enum.
- [src/mcp/tools/get-steering.ts](../../../src/mcp/tools/get-steering.ts)
  — output the new types in listings.
- [src/cli.ts](../../../src/cli.ts) — new flags.
- [src/cli.test.ts](../../../src/cli.test.ts) — new cases.

## Seams involved

- `store` — primary.
- `mcp` — input schema updates.
- (no `graph`, `msal`, `clock`, `fs`, `http`, `logger` work.)

## RED test list

- AC1: schema migration v16 → v17 is idempotent
  - test file: `src/store/schema.test.ts`
  - test name: `"v17 migration is a no-op marker bump"`
  - seams touched: store

- AC2: `add_steering_rule` accepts `event_organizer_email` and
  `event_subject_contains`
  - test file: `src/mcp/tools/add-steering-rule.test.ts`
  - test name: `"add_steering_rule accepts event-targeted rule types"`
  - seams touched: mcp, store
  - edge cases: typo on rule type → `InvalidParams`.

- AC3: `buildSteeringPredicate({target: "event"})` filters out
  events whose `organizer_email` matches a muted rule
  - test file: `src/store/steering-filter.test.ts`
  - test name: `"event-targeted predicate excludes events from muted organizers"`
  - seams touched: store
  - edge cases: rule disabled (no filter); rule enabled (filter);
    case-insensitive email match.

- AC4: event-targeted predicate filters by `event_subject_contains`,
  case-insensitive
  - test file: `src/store/steering-filter.test.ts`
  - test name: `"event-targeted predicate excludes events whose subject contains muted text"`
  - seams touched: store
  - edge cases: substring at start, middle, end; unicode subject.

- AC5: message-targeted rules do **not** affect events
  - test file: `src/store/steering-filter.test.ts`
  - test name: `"message-targeted rules do not filter events"`
  - seams touched: store
  - edge cases: a `sender_email` rule muting an organizer does NOT
    drop their meetings.

- AC6: event-targeted rules do **not** affect messages
  - test file: `src/store/steering-filter.test.ts`
  - test name: `"event-targeted rules do not filter messages"`
  - seams touched: store
  - edge cases: `event_organizer_email` rule does NOT mute that
    person's emails.

- AC7: `find_events` with `include_muted: false` (default)
  excludes muted events
  - test file: `src/mcp/tools/find-events.test.ts`
  - test name: `"find_events excludes muted events by default"`
  - seams touched: mcp, store

- AC8: `find_events` with `include_muted: true` returns muted
  events
  - test file: `src/mcp/tools/find-events.test.ts`
  - test name: `"find_events with include_muted=true returns everything"`
  - seams touched: mcp, store

- AC9: `get_recent_activity` event branch honours `include_muted`
  - test file: `src/mcp/tools/get-recent-activity.test.ts`
  - test name: `"get_recent_activity excludes muted events on the event branch by default"`
  - seams touched: mcp, store
  - edge cases: message branch behaves identically to before;
    interleaved feed has muted events removed but messages intact.

- AC10: `get_event` (slice 5) **does not** apply steering — pin the
  carve-out
  - test file: `src/mcp/tools/get-event.test.ts`
  - test name: `"get_event ignores event steering rules"`
  - seams touched: mcp, store

- AC11: CLI flag adds an event-organizer rule
  - test file: `src/cli.test.ts`
  - test name: `"--steer-event-organizer adds a rule the predicate honours"`
  - seams touched: store, fs

- AC12: CLI flag adds an event-subject-contains rule
  - test file: `src/cli.test.ts`
  - test name: `"--steer-event-subject adds a substring rule the predicate honours"`
  - seams touched: store, fs

## Open questions / assumptions

1. **Open:** Should `event_organizer_email` accept a domain wildcard
   (`@noisycorp.com`) like `sender_domain` does for messages? Yes,
   probably; FRAME decides whether to add a separate
   `event_organizer_domain` rule type or fold the `@`-prefix
   convention into `event_organizer_email`. Tentative: separate
   rule type for symmetry with the message side.
2. **Open:** Display column name. If slice 1 named the field
   `organizer_email` vs `event_organizer_email`, the rule-type name
   should align. FRAME confirms against the schema.
3. **Assumption:** No new `kind` predicate. The user can disable
   all event-targeted rules via `set_steering_enabled` per-rule;
   a "mute all events" toggle is UX outside steering.
4. **Open:** `get_event` carve-out. AC10 pins it. FRAME confirms
   the brief §10 resolution still holds (it does — `get_thread` and
   `list_accounts` are also carved out).

## Risks

- **Predicate confusion.** Two filter targets sharing a builder
  function is ripe for "applied to the wrong side" bugs. Mitigation:
  the function takes an explicit `target` argument, no defaulting,
  and AC5/AC6 test the cross-target null case explicitly.
- **Migration churn.** v17 is a marker-only bump. The risk is a
  future schema change that needs real DDL also bumping to v17 and
  conflating the two. Mitigation: comment in
  [src/store/schema.ts](../../../src/store/schema.ts) calls out v17 is
  enum-widening only and any DDL bumps to v18+.
- **CLI flag surface keeps growing.** Mitigation: `/docs-update`
  refreshes the user guide; the flag list is deliberately
  enumerable in `--help`.

## Implementation notes (post-hoc)

- **v17 needed a real migration, not a no-op marker.** `steering_rules
  .rule_type` carries a `CHECK(rule_type IN (...))` constraint, not a
  bare `TEXT` column as this doc assumed — SQLite has no `ALTER TABLE`
  to widen a `CHECK` in place, so `migrateV17` does the standard
  rebuild-and-rename (mirrors `migrateV11`'s `sync_state` rebuild):
  create the widened table, copy rows verbatim (ids preserved via
  explicit `INSERT ... SELECT`, not relying on `AUTOINCREMENT`), drop
  the old one, rename into place, recreate the two indexes.
- Open question 1 resolved: no `event_organizer_domain` rule type
  added this slice — kept to exactly the two types the plan specified,
  deferred as an out-of-scope follow-up (unchanged from the plan).
- Open question 2 resolved: the schema column is `organizer_email`
  (confirmed in `MIGRATION_16`), so the rule type is
  `event_organizer_email` — matches the plan's assumption exactly.
- CLI flag names: `--steer-add-event-organizer` /
  `--steer-add-event-subject`, not the plan's `--steer-event-organizer`
  / `--steer-event-subject` — matches the existing `--steer-add-*`
  prefix convention used by every other add-rule flag
  (`--steer-add-sender`, `--steer-add-domain`, etc.), which this doc's
  own examples used inconsistently with its own flag names.
- `escapeLikePattern` moved out of `sqlite-message-store.ts` into a new
  [src/store/like-pattern.ts](../../../src/store/like-pattern.ts) so
  `steering-filter.ts` (which `sqlite-message-store.ts` imports) could
  reuse it for `event_subject_contains` without a circular import.
- Account scoping for event-targeted rules: `CalendarEvent` has no
  `source`-comparable field, so only `rule.account` scopes an
  event-targeted rule; `rule.source` (if ever set on one) is simply
  ignored rather than rejected at validation time. Not called out in
  the plan; documented here and in the user guide.

## Out-of-scope follow-ups

- `event_organizer_domain` rule type (probably wanted — flag).
- A `kind`-level mute (UI feature, not a rule).
- FTS-backed event-subject search.
