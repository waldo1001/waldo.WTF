# Plan — Sync Outlook Sent Items so "did I reply?" is answerable

## 1. Task

Extend the Outlook sync to also ingest messages from `/me/mailFolders/sentitems/messages/delta`, storing full bodies alongside inbox messages with a `from_me` marker. This makes user-authored replies first-class in `get_thread`, enables a "replied / completed" annotation on `get_recent_activity`, and lets the assistant quote the exact reply the user sent.

## 2. Scope boundary

**IN**
- A second delta cursor per Outlook account, scoped to Sent Items.
- A new `from_me` boolean column on `messages` (default 0 for existing rows, 1 for sent-items rows).
- Full body projection for sent messages (same `body` + `bodyHtml` handling as inbox).
- Per-account sync state row keyed by `(account, source="outlook-sent")` OR a composite `(account, source, folder)` — decided in §6.
- `get_thread` naturally interleaves inbox + sent rows by `sent_at ASC` (they already share `threadId`).
- `get_recent_activity` returns a new per-thread annotation `replied: boolean` — true when the latest message in the conversation has `from_me=1`.
- Steering rules for `sender_email` / `sender_domain` / `body_contains` **ignore** rows where `from_me=1`, so a user's own reply is never muted by a rule that targets someone they correspond with.
- `search` is unaffected semantically except that `from_me` rows become discoverable; `sender_email` filtering continues to match on stored sender, which for sent rows is the account owner.
- In-memory store parity for tests.
- Schema migration (forward-only, additive column + backfill of `from_me=0`).

**OUT (deferred)**
- Backfilling historical Sent Items on first run beyond `backfillDays` — matches inbox behavior; no separate window.
- A `from_me` filter on the `search` tool surface (can be added later if asked).
- Teams "from me" detection — Teams has its own sender identity model; out of scope here.
- WhatsApp — sender identity already handled by importer; no change.
- Any write path to Graph.
- UI changes beyond the new `replied` annotation string in the MCP response.

## 3. Files to create / touch

- [src/store/types.ts](../../src/store/types.ts) — add `fromMe?: boolean` to `Message`.
- [src/store/schema.ts](../../src/store/schema.ts) + [schema.test.ts](../../src/store/schema.test.ts) — add `from_me INTEGER NOT NULL DEFAULT 0` to `messages`; bump schema version; migration test.
- [src/store/sqlite-message-store.ts](../../src/store/sqlite-message-store.ts) — read/write `from_me`; include in upsert columns.
- [src/testing/in-memory-message-store.ts](../../src/testing/in-memory-message-store.ts) — carry `fromMe` through the in-memory model.
- [src/sync/sync-inbox.ts](../../src/sync/sync-inbox.ts) — rename `DEFAULT_INBOX_DELTA_ENDPOINT` is fine; add `fromMe` arg to `toMessage` (inbox passes `false`).
- [src/sync/sync-sent.ts](../../src/sync/sync-sent.ts) *(new)* — mirror of `syncInbox` pointed at `/me/mailFolders/sentitems/messages/delta`, `source="outlook"` but `fromMe=true` on every row, persists its own sync-state row under a distinguishing key (see §6).
- [src/sync/sync-sent.test.ts](../../src/sync/sync-sent.test.ts) *(new)* — delta, backfill-window, removed-tombstone, and no-from-field (drafts) cases.
- [src/sync/sync-scheduler.ts](../../src/sync/sync-scheduler.ts) — call `syncSent` after `syncInbox` for each Outlook account; same error handling / log entry shape.
- [src/sync/sync-scheduler.test.ts](../../src/sync/sync-scheduler.test.ts) — assert both syncs run per account, in the right order, and that sent-items failures don't abort inbox-success logging (and vice versa).
- [src/mcp/tools/get-recent-activity.ts](../../src/mcp/tools/get-recent-activity.ts) — compute `replied` per thread (latest `sentAt` row's `fromMe`). Update response schema.
- [src/mcp/tools/get-recent-activity.test.ts](../../src/mcp/tools/get-recent-activity.test.ts) — ACs below.
- [src/mcp/tools/get-thread.ts](../../src/mcp/tools/get-thread.ts) — ensure ordering is purely by `sent_at ASC`; surface `fromMe` on each message in the returned payload.
- [src/mcp/tools/get-thread.test.ts](../../src/mcp/tools/get-thread.test.ts) — interleaved thread returns both sides in order.
- [src/store/steering-filter.ts](../../src/store/steering-filter.ts) (or wherever the steering predicate lives — grep on first RED) — exempt `from_me=1` rows from `sender_email` / `sender_domain` / `body_contains` rules.
- [src/store/steering-filter.test.ts](../../src/store/steering-filter.test.ts) — ACs below.
- [docs/changelog.md](../changelog.md) + [docs/user-guide.md](../user-guide.md) — note Sent Items ingestion, `replied` annotation, and steering carve-out for own replies (via `/docs-update`).

## 4. Seams involved

- `graph` — new endpoint, same `GraphClient.getDelta` contract, no new auth scope (Mail.Read already covers Sent Items).
- `store` — schema change, new column, migration; both implementations updated in lockstep.
- `clock` — unchanged.
- `auth` — unchanged; same token used for both deltas.
- `scheduler` — new call site.
- No fs / msal / http surface change.

## 5. RED test list

Each item is one test.

### Schema / store
- **AC-S1** `schema migration adds from_me column with default 0 to existing rows` — [schema.test.ts](../../src/store/schema.test.ts).
- **AC-S2** `sqlite upsert round-trips fromMe=true` — [sqlite-message-store.test.ts](../../src/store/sqlite-message-store.test.ts).
- **AC-S3** `sqlite upsert defaults fromMe to false when field is absent` — legacy callers don't break.
- **AC-S4** `in-memory store round-trips fromMe` — [in-memory-message-store.test.ts](../../src/testing/in-memory-message-store.test.ts).

### Sync
- **AC-Y1** `syncSent hits /me/mailFolders/sentitems/messages/delta` — asserts the URL the `GraphClient` was called with.
- **AC-Y2** `syncSent persists rows with fromMe=true` and same `threadId` as their inbox counterparts when `conversationId` matches.
- **AC-Y3** `syncSent resumes from its own deltaToken, independent of inbox` — two accounts, one inbox-only, one both; assert no cross-pollution of cursors.
- **AC-Y4** `syncSent honors backfillDays the same way as inbox`.
- **AC-Y5** `syncSent handles @removed tombstones` (move-to-folder / permanent-delete).
- **AC-Y6** `syncSent skips drafts without a populated from field` (observed in Graph on unsent drafts) — importedAt-only row is not written with a missing sender; decide: skip vs. synthesize from account owner. Default: **synthesize** using `account.username` as `senderEmail` so the row is still searchable.
- **AC-Y7** `scheduler runs inbox then sent per Outlook account; a failure in one records its own sync-log entry without swallowing the other`.

### Read-side surfacing
- **AC-R1** `get_thread interleaves inbox and sent messages in sent_at order`.
- **AC-R2** `get_thread payload includes fromMe on each message`.
- **AC-R3** `get_recent_activity returns replied=true for a thread whose latest message is fromMe`.
- **AC-R4** `get_recent_activity returns replied=false when inbound is the latest`.
- **AC-R5** `get_recent_activity thread ordering is unchanged by fromMe rows` — i.e. the `replied` flag is informational, not reordering.

### Steering carve-out
- **AC-T1** `sender_email steering rule for gunter@example does NOT mute the user's own reply in that thread`.
- **AC-T2** `sender_domain steering rule does NOT mute fromMe rows`.
- **AC-T3** `body_contains steering rule does NOT mute fromMe rows`.
- **AC-T4** `thread_id steering rule DOES mute fromMe rows too` — muting a whole thread is a stronger intent; the user asked to not see the thread at all. Documented.
- **AC-T5** `muted_count is unaffected by the carve-out` — carve-out changes *which* rows are muted, count reflects reality.

## 6. Open questions / assumptions

- **Open (needs decision before RED):** how to key the new sync-state row. Options:
  1. Extend `MessageSource` with `"outlook-sent"` — simple, but leaks a sync implementation detail into the read model (`message.source` would now be a union of folder-ish values).
  2. Add `folder` column to `sync_state` and key on `(account, source, folder)` — cleaner, but a migration.
  3. Keep `source="outlook"` and use a reserved prefix in `deltaToken` to disambiguate — too clever, rejected.
  **Recommendation:** option 2. `messages.source` stays `"outlook"`; only the `sync_state` table learns about folders. Confirm in plan chat.
- **Assumption:** Graph Mail.Read scope already covers Sent Items. Confirm against current [docs/setup.md](../setup.md) scope list during FRAME; if not, this plan grows a scope bump.
- **Assumption:** `conversationId` is the same across inbox and sent for a given thread — Graph contract, confirmed in MS Learn docs. Edge case (new-subject replies) is acknowledged and out of scope.
- **Assumption:** "from me" == the row was ingested from Sent Items. We do **not** try to match `from.emailAddress.address` against `account.username` at read time — the folder is the source of truth. Simpler and immune to shared-mailbox shenanigans.
- **Assumption (flagged):** body storage for sent messages uses the same `htmlToText` projection and FTS indexing as inbox. This means the user's own replies become searchable via `search`. Confirm that's desired — the user asked to see reply content, which implies yes.
- **Open:** should `search` expose `from_me: true|false` as a filter? **Decision:** deferred. Easy to add later; not required for "did I reply?".
- **Open:** do we want a `/docs-update` note about a one-time re-sync cost? First run will backfill Sent Items within `backfillDays` — could be hundreds of messages. Call it out in the changelog.

## 7. Risks

- **Schema migration on the NAS DB is not free.** `ALTER TABLE ... ADD COLUMN from_me INTEGER NOT NULL DEFAULT 0` on an existing large `messages` table is O(rows) in SQLite. Needs to run under [/deploy-nas](../../.claude/skills/deploy-nas/SKILL.md) `--migrate`, not silently at boot. Add a migration file under [docs/migrations/](../migrations/).
- **Privacy surface grows.** The local lake now stores the user's outgoing bodies. Still local-only, but steering-rule author and future export tooling must be aware. Note in user-guide.
- **Steering carve-out could surprise.** If a user muted a sender to hide a thread they no longer care about, seeing their own replies in that thread may feel wrong. The `thread_id` rule (AC-T4) is the correct way to mute a whole conversation; we'll document this.
- **Double-sync error blast radius.** If Sent Items sync fails hard (e.g. 403 on a shared mailbox), the scheduler must still log inbox success so `get_sync_status` doesn't go all-red. AC-Y7 guards.
- **Delta cursor drift between folders.** If inbox succeeds and sent fails repeatedly, inbox state marches forward while sent falls behind — `replied` annotations will be stale. Surface this in `get_sync_status` with a per-folder row (follow-up: AC-Y7 asserts logging; UI-level surfacing is out of scope here).
- **Rollback.** Additive column + new delta cursor → revert = drop column + delete sync_state rows where `folder="sentitems"`. Cleanly reversible; document in the migration file.

## 8. Out-of-scope follow-ups

- `from_me` filter on `search`.
- `get_sync_status` exposes per-folder state so the operator can see "sent-items sync has been broken for 3 days".
- Teams "from me" detection using Graph `/me` identity match.
- An "only show threads awaiting my reply" mode on `get_recent_activity` (inverse of `replied`).
- Optional body redaction for sent messages in steering-filtered views (if privacy feedback comes in).
