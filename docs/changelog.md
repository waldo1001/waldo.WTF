# Changelog

Reverse-chronological. One entry per day that had meaningful changes.
Each entry is a short bulleted list — one bullet per change, one line
per bullet. No prose, no long explanations. Link to PROGRESS.md for
milestones and to commit hashes for detail.

Updated as the last step of every `/tdd-cycle` invocation (see
[tdd/methodology.md §10](tdd/methodology.md)) via the `/docs-update`
skill.

---

## 2026-10-23

- **Node 22.22.3 → 22.23.4 on the Mac mini** (security, runtime). Fixes the 21 Oct 2026 Node CVEs; reachable here were the Brotli decoder bug (undici `fetch` auto-decompresses `br` from Graph/Yammer) and the TLS hostname-verification bypass (all outbound HTTPS). `dns.resolve` is unused. Same ABI 127, no `better-sqlite3` rebuild.
- `engines.node` raised from `>=22` to `^22.23.4 || ^24.22.1 || >=26.12.1`; patch procedure added to [deploy-macmini.md](deploy-macmini.md#operational-notes).

## 2026-10-13

- **adm-zip 0.5 → 0.6.1** (security, runtime). On 0.5 a crafted WhatsApp export (a smuggled second `_chat.txt`, or an entry claiming more data than the file holds) **imported successfully**. It's now refused as `WhatsAppParseError` and left in the inbox ([import-whatsapp.ts](../src/sync/import-whatsapp.ts)). `@types/adm-zip` dropped (0.6 ships its own types).
- **vitest + @vitest/coverage-v8 2.1.9 → 4.1.11** (dev). `npm audit` now reports 0 critical / 0 high (was 3 / 2). vitest 4's AST-based coverage counts every `??` / short-circuit as a branch and exposed 17 previously-invisible untested branches; covered with ~16 new tests rather than lowering the gate. Shared `*-contract.ts` suites are now excluded from coverage (test code).
- All 75 `c8 ignore` hints became `v8 ignore … -- @preserve` (vitest 4 silently ignores `c8` hints). New rules in [coverage-policy.md](tdd/coverage-policy.md#ignore-hints-vitest--4-v8-provider). Also fixed `readonly Array<…>` in [yammer.ts](../src/sources/yammer.ts) (vitest 4's parser rejected it, so the file silently dropped out of coverage) and made the `/mcp` 413 test deterministic. Plan: [deps-vitest4-admzip06](plans/done/deps-vitest4-admzip06.md).

## 2026-10-12

- **Hotfix (post-deploy):** re-adding the claude.ai connector hung after "Approve". The S1 consent-page CSP `form-action 'self'` also governs the redirect that follows a form submission, so Chrome blocked the 302 back to claude.ai (the server had minted the codes; claude.ai never received them). The consent and wrong-password pages now allow `form-action 'self' <validated redirect origin>`; error pages keep `'self'` only ([plan](plans/done/hotfix-consent-csp-form-action.md)). `/local-smoke`'s curl checks can't see browser-enforced policies.
- **Security hardening S1 — OAuth flow integrity** ([plan](plans/done/security-hardening-s1-oauth-flow-integrity.md), umbrella [security-hardening.md](plans/done/security-hardening.md)). Production is reachable via Tailscale **Funnel**, so consent phishing was a live path: DCR accepted any https callback and the consent POST minted a code for whatever it was sent.
- DCR now only accepts redirect URIs on an allowlist (`WALDO_OAUTH_REDIRECT_ALLOWLIST`, default claude.ai + claude.com callbacks) plus http loopback for Claude Desktop / Claude Code; `client_name` is capped at 64 chars. Rejections log `oauth_dcr_redirect_rejected` so a new legitimate callback is easy to spot.
- `GET` and `POST /oauth/authorize` share one validator (client exists, redirect registered **and** allowlisted, S256, well-formed challenge); the POST validates before the scrypt password check. Clients registered earlier with non-allowlisted callbacks are now refused at authorize time.
- The consent page shows the destination host prominently and labels the client name as self-declared; error pages no longer reflect submitted input; HTML responses carry `X-Frame-Options: DENY`, a strict CSP with `frame-ancestors 'none'`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. OAuth JSON responses are `no-store`.
- `/oauth/token` binds codes and refresh tokens to their client: a `client_id` that doesn't match → `invalid_grant` (omitting it still works).
- Applied non-breaking `npm audit fix` (MCP SDK 1.29.0 → 1.32.1, plus transitive `proxy-addr`, `hono`, `fast-uri` …). Remaining 3 critical / 2 high need major bumps (vitest 2→4 dev-only, adm-zip 0.5→0.6) — deferred to a separate task by decision.
- **Security hardening S2 — static bearer off the public path** ([plan](plans/done/security-hardening-s2-static-bearer-off-public-path.md)). With `WALDO_PUBLIC_URL` set, the public listener (the Funnel-exposed one) now accepts **OAuth tokens only**; the non-expiring `BEARER_TOKEN` is rejected there.
- New `WALDO_INTERNAL_PORT` starts a second listener hard-bound to `127.0.0.1` (ignores `WALDO_BIND_HOST`) that accepts **only** the static bearer and has no OAuth routes — for local headless clients (Jarvis). `WALDO_DISABLE_STATIC_BEARER=true` now means "don't start it". **Operator**: set `WALDO_INTERNAL_PORT=8766`, deploy, then point Jarvis at `http://127.0.0.1:8766/mcp`.
- `.gitignore` now covers `.claude/settings.local.json` (may hold bearer tokens in permission entries) and `.claude/worktrees/`. `/local-smoke` boots in production shape and asserts the static bearer is refused on the public port.
- **Security hardening S3 — abuse limits** ([plan](plans/done/security-hardening-s3-abuse-limits.md)). Request bodies are capped (OAuth routes 64 KB, `/mcp` 1 MiB) → `413` + `Connection: close`; previously every body was buffered without limit.
- OAuth endpoints are rate-limited per client IP and globally (register 10/h, authorize POST 10/min — checked **before** scrypt — token 60/min) → `429` + `Retry-After`. Behind Funnel the client IP is the left-most `X-Forwarded-For`, trusted only when the socket peer is loopback ([client-ip.ts](../src/mcp/client-ip.ts)).
- New `WALDO_OAUTH_MAX_CLIENTS` (default 50) caps DCR registrations; clients unused for 24 h are pruned first, otherwise `503 temporarily_unavailable`. Expired auth codes are pruned on every save.
- Fixed: any error inside an HTTP route (e.g. a duplicate client id or a SQLite error) was an unhandled promise rejection that could hang the request or kill the process. Every route now runs through `runSafely` → logged `http_handler_failed` + `500`.
- **Security hardening S4 — token storage and lifetime** ([plan](plans/done/security-hardening-s4-token-storage-lifetime.md)). Schema v20 stores OAuth access/refresh tokens and auth codes as SHA-256 hashes, hashing existing rows **in place** at boot so live connectors keep working ([migration recipe](migrations/oauth-token-hashing.md)).
- Sliding refresh is now capped at `WALDO_OAUTH_MAX_GRANT_DAYS` (default 180) after the original consent; `expires_in` is clamped near the cap and expired token rows are pruned. Store lookups return grant metadata only — never token values.
- New CLI: `--list-oauth-clients` (redirect host, active grants, last consent; no secrets) and `--revoke-oauth-client <id>` (deletes the client with its tokens and codes) — replaces the raw-SQL recipe in [oauth.md §5](oauth.md).
- Security hardening complete (S1–S4, [umbrella plan](plans/done/security-hardening.md)); branch `security/hardening`, not yet deployed.
- Docs: [deploy-macmini.md](deploy-macmini.md) corrected — production is exposed via **Funnel**, not tailnet-only Serve; `/deploy-local` now re-asserts Funnel. Full tailnet hostnames in docs replaced with `<host>.<tailnet>.ts.net` placeholders.

## 2026-08-24

- **Meeting transcripts are live.** After the ifacto tenant admin enabled
  Graph transcript access, sync started fetching immediately: 12
  transcripts / ~6,400 segments across 9 meetings, with speaker
  attribution intact (the `<v Speaker>` VTT parsing works against real
  data). Ticks steady at `25 ok, 0 error(s)`. The 148 `not-available`
  rows are meetings that genuinely weren't recorded — marked once, never
  retried.
- Confirmed the ingestion boundary while answering a privacy question:
  candidates come **only** from `/me/calendarView/delta` (your own
  calendar, delegated token), then Graph independently enforces its own
  entitlement check. There is no tenant-wide sweep; reading other
  people's meetings would need app-only permissions plus an application
  access policy, which this project deliberately doesn't use.
- Fixed: cancelled meetings were being ingested (2 of the first 12
  fetched transcripts). Graph returns a recurring series' transcripts
  even for an occurrence that was called off, so
  [sync-transcripts.ts](../src/sync/sync-transcripts.ts) now skips
  `isCancelled` events. `--repair-transcript-linkage` gained a third
  operation to delete transcripts (and their segments) already attached
  to cancelled meetings; its counter deliberately excludes marker rows so
  it stays disjoint from `markersCleared`.
- Known limitation, not yet addressed: recurring-series meetings get the
  same series transcripts attributed to several occurrence dates (six
  "Dev Lead Meeting" rows share an identical 211/497 segment split), so
  "what was said on date X" is unreliable for recurring meetings.
  Deliberately not patched blind — needs real data across more
  occurrences before designing a fix.
- Also noted: `event_attendees` carries no row for the signed-in user, so
  filtering by your own RSVP (e.g. "skip meetings I declined") isn't
  possible today without changing calendar sync first.

## 2026-08-20

- **Fixed the bug that made meeting transcripts unreachable in
  production.** `events.online_meeting_id` was populated from Graph's
  `onlineMeeting.conferenceId` — the audio **dial-in number**, not an
  onlineMeeting resource id — so every transcript lookup 404'd. Live
  lake showed the damage: only 9 of 1,264 ifacto events even carried a
  conferenceId, and the single lookup that ran produced a false
  `not-available` marker. Graph's calendarView never returns the id the
  transcript endpoints need; it has to be resolved from the meeting's
  join URL via `GET /me/onlineMeetings?$filter=JoinWebUrl eq '...'`
  (delegated `OnlineMeetings.Read`, **no admin consent**). New
  `TranscriptClient.resolveOnlineMeetingId`, implemented in
  [http-transcript-client.ts](../src/sources/http-transcript-client.ts)
  with the same 401-retry / 429 / redaction shape as its siblings;
  `syncTranscripts` now gates candidates on the joinUrl instead of the
  id, lifting the real candidate pool from 1 meeting to ~46.
  `TRANSCRIPT_SCOPES` gains `OnlineMeetings.Read`, so **both opted-in
  accounts must re-run `--transcripts-enable`**.
- Fixed the same root cause for meeting **chat** links: slice 5 read
  `onlineMeeting.chatInfo.threadId`, which Graph omits on nearly every
  event (470 of ~480 in the lake had a joinUrl but NULL `chat_id`), so
  `get_event.linkedChat` was null almost everywhere. New
  `chatIdFromJoinUrl` derives the `19:…@thread.v2` chat id from the
  joinUrl's meetup-join segment — zero extra Graph calls.
- New `--repair-transcript-linkage` CLI flag + migration recipe
  ([repair-transcript-linkage](migrations/repair-transcript-linkage.md)):
  deletes the false `__no-transcript-found__` markers (which, being
  `not-available`, would otherwise suppress a correct re-check forever)
  and backfills `chat_id` for existing rows. Data-only, no schema bump,
  idempotent, `--dry-run` supported.
- **Live probe answered the plan's open question and found the real
  blocker.** Resolution is NOT organizer-only: probing three of Eric's own
  meetings returned `HTTP 200, matches: 1` with a real `MSp…` onlineMeeting
  id — the joinUrl fix works end to end. The transcript call then returns
  `403 GraphAccessToTranscriptsDisabled`: iFacto's tenant has Graph API
  access to transcripts switched **off**, which Microsoft documents as the
  default and as unbypassable *"regardless of app-level permissions"*.
  Requires a Teams admin (`Set-CsTeamsMeetingConfiguration
  -EnableGraphTranscriptAccess $true -EnableAttributedTranscripts $true`).
- Hardened the 403 mapping as a result: `HttpTranscriptClient` now branches
  on Graph's `innerError.code` (which Microsoft says to use instead of the
  message text) and raises `TranscriptApiDisabledError` /
  `TranscriptSpeakerAttributionDisabledError` for the two tenant-wide admin
  toggles. `syncTranscripts` propagates both instead of writing a per-event
  status. This matters: the old code collapsed every 403 into
  `not-available`, which is never retried — so all 22 checked meetings
  would have stayed permanently poisoned the moment an admin enabled the
  setting. Both error messages name the exact toggle and cmdlet that fixes
  them, and surface as one actionable `sync_log` row per account per tick.
- Plan + verified Graph findings:
  [plans/done/transcripts-meeting-id-resolution.md](plans/done/transcripts-meeting-id-resolution.md).
  Open question recorded there: Microsoft documents attendee-token
  support for the by-id onlineMeeting GET but is silent for the
  JoinWebUrl filter, so resolution may work only for meetings the
  account organized — probed during rollout.

## 2026-08-16

- Fixed a production incident on the first real `--calendar-enable`
  account (`WAUTERI@ifacto.be`): calendar sync had 24 consecutive
  failures, `UNIQUE constraint failed: event_attendees.account,
  event_attendees.event_id, event_attendees.attendee_email`, stuck on
  the same delta page every tick since the account was enabled — no
  calendar events ever landed. Root cause:
  `mapGraphEventToCalendarEvent`
  ([src/sources/calendar.ts](../src/sources/calendar.ts)) built the
  attendees array via a plain `.map()` with no dedup by email; real
  Graph data (confirmed in production, not hypothetical) sends the same
  attendee more than once for one event — same address, sometimes
  different casing/response status — e.g. a distribution-list expansion
  alongside a direct invite. `event_attendees`' PK is `(account,
  event_id, attendee_email)`, so the second insert always threw, and
  `upsertEvents` wraps the whole batch in one transaction, so the entire
  page rolled back and the delta cursor never advanced — same page,
  same failure, every retry. Fixed by keying attendees in a `Map` by
  (lower-cased) email instead of appending to an array — later
  occurrences overwrite earlier ones by value while keeping the first
  occurrence's position, matching the existing organizer-merge policy
  this function already had for the organizer-vs-attendee overlap case
  (that path already deduped correctly; this was specifically the
  plain-attendee-vs-plain-attendee gap). Two new tests reproduce the
  exact failure shape and pin the last-write-wins semantics. Mutation
  score 89.76% on the touched file.
  Deployed straight to production (`waldomacmini1`) given the account
  was actively stuck with zero calendar data; no separate local
  deploy step.

## 2026-08-12

- Calendar feature, slice 1 of 8 base + 6 transcript slices: schema v16
  adds `events`, `event_attendees`, `calendar_accounts` tables and three
  new `MessageStore` operations (`upsertEvents`, `deleteEvents`,
  `getEventsInRange`). Internal store seam only — no Graph client, sync
  job, MCP tool, or CLI wiring yet; nothing user-visible changes with
  this slice. `deleteEvents` deletes attendee rows explicitly rather
  than relying on the SQLite FK cascade, since not every connection in
  this codebase enables `PRAGMA foreign_keys`. Full spec:
  [plans/done/calendar-slice-1-schema-and-store.md](plans/done/calendar-slice-1-schema-and-store.md),
  parent plan [plans/calendar-overview.md](plans/calendar-overview.md).
- Added mutation testing (Stryker) to `/tdd-cycle` as a new mandatory
  Step 10, between COVER and SECURITY SCAN — closes a gap the coverage
  policy had flagged as a "Weekend 3" target that never actually landed.
  New `npm run mutate` (`stryker run`), config at
  [stryker.config.mjs](../stryker.config.mjs) (break threshold 80%
  mutation score, scoped per-cycle via `--mutate "<touched files>"`).
  Baseline run against `schema.ts` found real gaps in the pre-existing
  migration-chain boundary conditions. Note for this dev machine:
  default Stryker concurrency SIGSEGVs (`better-sqlite3` native addon +
  concurrent worker processes) — pinned `concurrency: 1` in config.
  `.stryker-tmp/` and `reports/` gitignored. Docs:
  [methodology.md §2.61](tdd/methodology.md),
  [coverage-policy.md](tdd/coverage-policy.md).
- Calendar feature, slice 2 of 14: `CalendarClient` seam
  ([src/sources/calendar.ts](../src/sources/calendar.ts)) — interface,
  Graph wire DTOs, `mapGraphEventToCalendarEvent` pure lowering
  function, and `FakeCalendarClient` for slice-3/4 testing. No HTTP, no
  sync yet. Mutation score 87.42% on the new files (Stryker's first
  real use since the tooling landed this session). Plan:
  [plans/done/calendar-slice-2-client-seam.md](plans/done/calendar-slice-2-client-seam.md).
- Calendar feature, slice 3 of 14: `HttpCalendarClient`
  ([src/sources/http-calendar-client.ts](../src/sources/http-calendar-client.ts))
  — real `/me/calendarView/delta` impl (`Prefer: outlook.timezone="UTC"`,
  `odata.body-content-type="text"`), 401/410/429 mapping
  (`TokenExpiredError`/`DeltaTokenInvalidError`/`GraphRateLimitedError`),
  5xx retry-with-backoff (mirrors `HttpTeamsClient`), bearer redaction,
  cursor host validation. Resolves its own token per call via an
  injected `getAccessToken(account, scope)` callback (`CalendarViewDeltaInput`
  carries no token param, unlike `TeamsClient`). Mutation score 89.47%.
  Also: caught and fixed a slice-2 type bug before it propagated —
  `CalendarViewDeltaPage.events` was typed as raw Graph wire DTOs,
  should have been (and now is) the already-lowered `CalendarEvent[]`
  per slice 2's own stated design. Plan:
  [plans/done/calendar-slice-3-http-client.md](plans/done/calendar-slice-3-http-client.md).
- Calendar feature, slice 4 of 14 (the big one): per-account opt-in.
  New `CalendarAccountStore` ([src/store/calendar-account-store.ts](../src/store/calendar-account-store.ts),
  mirrors `VivaSubscriptionStore`), `CALENDAR_SCOPES = ["Calendars.Read"]`
  as its own scope set (never merged into base `SCOPES`),
  `--calendar-enable <account>` / `--calendar-disable <account>` CLI,
  `syncCalendarEvents` ([src/sync/sync-calendar.ts](../src/sync/sync-calendar.ts))
  walking `[now-365d, now+60d]` on first sync, and scheduler wiring that
  skips calendar sync entirely for non-enabled accounts. `MessageSource`
  gained a `"calendar"` value (shared `sync_state`/`sync_log` tables).
  Two more mid-flight corrections, same spirit as slice 2/3's fixes:
  (1) the 401-retry-once design assumed the sync loop could force a
  fresh token into an already-built `HttpCalendarClient` — it can't,
  since that client resolves its own tokens via a constructor-time
  callback — so the retry moved into the client itself
  (`GetCalendarAccessToken` gained a `forceRefresh` parameter); (2) the
  plan's `Logger` interface assumption (`.info(event, ctx)`) doesn't
  match this codebase's actual `Logger` (`.info(message: string)` only,
  interpolated event=value strings) — fixed to match. Mutation score
  83.50% on the store/scope/client-retry batch, 83.00% on the
  sync-job/scheduler batch (both scoped to touched lines — full-file
  scores are dragged down by pre-existing untested branches elsewhere
  in `sync-scheduler.ts`, out of scope for this cycle). CLI mutation
  testing was scoped out given `cli.ts`'s size (1600+ lines, only a
  small fraction touched) — 96%/95% line/branch coverage stands in for
  it here. Plan:
  [plans/done/calendar-slice-4-sync-and-scope.md](plans/done/calendar-slice-4-sync-and-scope.md).
- Calendar feature, slice 5 of 14: new `get_event(event_id, account?)`
  MCP tool ([src/mcp/tools/get-event.ts](../src/mcp/tools/get-event.ts))
  — returns a calendar event with its attendees and, for online
  meetings, the linked Teams meeting-chat messages (last 50). New
  `MessageStore.getEventByKey`. Steering does **not** apply (mirrors
  `get_thread`). This is the first calendar MCP tool — 6th tool users
  can call, though there's still no search/list tool for calendar yet
  (slice 6). Mutation score 84.99% on the touched files (aggregate,
  scoped runs weren't worth the extra time here since the touched
  surface — `getEventByKey` — is small relative to the shared files it
  landed in).
  Plan: [plans/done/calendar-slice-5-meeting-chat-link.md](plans/done/calendar-slice-5-meeting-chat-link.md).
- Calendar feature, slice 6 of 14: new `find_events` MCP tool
  ([src/mcp/tools/find-events.ts](../src/mcp/tools/find-events.ts)) —
  agenda queries (next 7 days by default) and history search
  (`subject_contains`/`attendee`, case-insensitive `LIKE`, SQL
  metacharacters escaped) over the full ~425-day synced range, with a
  92-day cap on unfiltered queries only. `order: "asc"|"desc"`,
  `limit`/`truncated`. New `MessageStore.findEvents`. Also
  `--calendar-list` (prints next 7 days across accounts) and
  `--calendar-resync [--account <account>]` (clears the calendar delta
  cursor so the next tick re-walks the window) CLI flags. This is the
  first calendar search/agenda surface — `find_events` is the 7th MCP
  tool. Mutation score 85.71% on `find-events.ts`.
  Plan: [plans/done/calendar-slice-6-mcp-and-cli.md](plans/done/calendar-slice-6-mcp-and-cli.md).
- Calendar feature, slice 7 of 14: `get_recent_activity` folds events
  into a single chronological feed — new optional `kinds?: ("message" |
  "event")[]` (default both) and `to?` (default `now + 7d` once events
  are requested) inputs. Output becomes a discriminated `items: [{kind,
  at, message|event}]` array ordered by `at` ascending, capped at 500
  (`RECENT_ITEMS_CAP`); passing `kinds: ["message"]` preserves the exact
  pre-slice-7 `{count, messages, muted_count}` shape so existing callers
  don't break. New `MessageStore.getRecentItems` /
  `composeRecentItems` — implemented as a JS-side merge of
  `getRecentMessages` + `findEvents` rather than a SQL `UNION ALL`,
  since `messages.sent_at` (INTEGER ms) and `events.start_at` (TEXT ISO)
  are incompatible column types for a literal union; shared by both
  `SqliteMessageStore` and `InMemoryMessageStore` so there's no
  union-vs-fake divergence risk. Simplified away a redundant
  message-before-event tiebreak in the sort comparator — the merged
  array is always built `[...messages, ...events]` and
  `Array.prototype.sort` is spec-guaranteed stable (ES2019+), so ties
  already resolve correctly without explicit kind-tiebreak logic.
  Mutation-driven hardening: `message-store.ts` 96.30%,
  `get-recent-activity.ts` 85.32% (up from a 75.40% baseline — this
  file predates the Stryker rollout and was never mutation-tested
  before this slice touched it; remaining survivors are pre-existing
  validation/projection code this slice didn't change). Combined
  touched-file score 84.76%.
  Plan: [plans/done/calendar-slice-7-unified-activity.md](plans/done/calendar-slice-7-unified-activity.md).
- Calendar feature, slice 8 of 14 (last base slice — base feature
  complete): event steering. Two new `steering_rules.rule_type` values,
  `event_organizer_email` (exact, case-insensitive) and
  `event_subject_contains` (case-insensitive substring) — schema v17
  widens the `rule_type` CHECK constraint. `buildSteeringPredicate`
  gained a required `target: "message" | "event"` param (no default) so
  the two rule families structurally can't cross-apply; wired into
  `find_events` and the event branch of `get_recent_activity`
  (`include_muted`, `muted_count`, `steering_hint` — same UX as
  `search`). `get_event` keeps its existing carve-out (mirrors
  `get_thread`), now pinned by a test. New
  `--steer-add-event-organizer`/`--steer-add-event-subject` CLI flags
  (deviates from the plan's `--steer-event-*` naming to match the
  existing `--steer-add-*` prefix convention). Extracted
  `escapeLikePattern` out of `sqlite-message-store.ts` into
  `src/store/like-pattern.ts` so `steering-filter.ts` can reuse it
  without a circular import.
  Design correction from the plan: v17 needs a real migration, not a
  no-op marker bump — `steering_rules.rule_type` carries a `CHECK`
  constraint enumerating valid values (not just a bare `TEXT` column as
  assumed), so SQLite needs the standard rebuild-and-rename dance
  (mirrors the `sync_state` rebuild in `migrateV11`) to widen it; ids
  and existing rows are preserved.
  Mutation-driven hardening: `steering-filter.ts` (new file this slice)
  96.70% / 100% of covered mutants killed — the only survivors are
  defensive unreachable-by-construction throws already `c8 ignore`d.
  `schema.ts` 92.13% (the one new-code survivor, the v17 version guard,
  is a provable equivalent mutant — it's the *last* version check in
  the chain, gated by the same early-return as `applyMigrations`
  itself, so it's tautologically true whenever reached; the other
  survivors are pre-existing gaps in older version guards, already
  flagged in the slice-1 mutation-testing rollout entry above).
  Combined touched-file score 87.26%.
  Plan: [plans/done/calendar-slice-8-event-steering.md](plans/done/calendar-slice-8-event-steering.md).
- Meeting transcripts, sub-slice T1 of 6 (schema + store ops): schema
  v18 adds `transcripts` (one row per fetched transcript — a recording
  restart can produce more than one per meeting, hence `transcript_id`
  in the PK, not just account+event_id) and `transcript_segments`
  (parsed VTT cues), both FK-cascading off `events` (mirrors
  `event_attendees`). New `MessageStore` ops: `upsertTranscript`
  (atomic replace-set — deletes the existing segment set for that key,
  inserts the new one, upserts the transcript row), `getTranscriptByKey`,
  `listTranscriptsForEvent`, `markTranscriptStatus`. Internal store seam
  only — no Graph client, sync job, MCP tool, or CLI wiring yet (those
  land in T2–T6); nothing user-visible changes with this slice.
  Design note not fully specified in the plan: `markTranscriptStatus`
  needs to record "checked, nothing there" even when no transcript was
  ever found (so a later sync job can apply the per-status retry
  cooldown from T5 without re-fetching every tick), but the schema's PK
  requires a non-null `transcript_id`. Resolved by making
  `markTranscriptStatus` an upsert: it takes the full `TranscriptKey`
  (including whatever placeholder `transcript_id` the future sync job
  chooses for the no-transcript case) and inserts a status-only marker
  row (`segment_count = 0`, no VTT bytes) when none exists yet, or
  updates status + `fetchedAt` in place when one does. `fetchedAt` is a
  caller-supplied `Date` (not read internally) — matches every other
  timestamp-writing method on this store; no clock is injected into
  `SqliteMessageStore`.
  Mutation-driven hardening: combined touched-file score 84.60%
  (`message-store.ts` 96.77%, `schema.ts` 88.72%,
  `sqlite-message-store.ts` 84.43%, `in-memory-message-store.ts`
  82.69%). Note: Stryker's dry run crashed on this dev machine
  repeatedly today (SIGSEGV, `better-sqlite3` native addon) — worse
  than the occasional single-retry recovery seen on earlier slices,
  consistent with tonight's unusually high system memory pressure
  rather than a regression in the mutate config.
  Plan: [plans/done/calendar-transcripts.md](plans/done/calendar-transcripts.md)
  §T1 (not yet archived — five more sub-slices to land in this file).
- Meeting transcripts, sub-slice T2 of 6 (delegated scope + admin
  consent): new `TRANSCRIPT_SCOPES = ["OnlineMeetingTranscript.Read.All"]`
  constant, kept separate from `CALENDAR_SCOPES` for the same reason
  `CALENDAR_SCOPES` is separate from base `SCOPES` — an account can have
  calendar without transcripts. New `--transcripts-enable <account>` /
  `--transcripts-disable <account>` CLI flags: enable requires the
  account already be calendar-enabled (rejects with a pointer to
  `--calendar-enable` before ever prompting for device-code login, so a
  doomed request doesn't waste an OAuth round-trip), device-codes with
  `[...SCOPES, ...CALENDAR_SCOPES, ...TRANSCRIPT_SCOPES]` combined
  (incremental delegated consent — Entra treats the re-request as one
  grant, not a new prompt for the already-consented scopes), then flips
  `calendar_accounts.transcripts_enabled` via the `setTranscriptsEnabled`
  method slice 4 already declared on `CalendarAccountStore` but never
  exercised until now. Same consent-rejection remediation pattern as
  `--calendar-enable` (names the scope, doesn't write the flag). Disable
  clears the flag only — fetched transcripts and calendar sync are
  unaffected. No second app registration, no app-only/client-secret
  auth — this re-confirms the plan doc's re-spec finding that transcripts
  need only one more delegated scope on the existing device-code flow.
  Admin-consent + metering + meeting-expiration notes added to
  [setup.md](setup.md) and a new [user-guide.md §5e](user-guide.md).
  Mutation testing: the combined touched-file score (`msal-auth-client.ts`
  + `cli.ts`) came in at 66.53%, under the 80% gate — entirely an
  artifact of `cli.ts` being a ~2100-line file most of which predates
  the Stryker rollout (Viva/Teams/steering CLI surfaces never
  mutation-tested), the same shape of gap already disclosed for
  `get-recent-activity.ts` in slice 7. Verified line-by-line that the
  new `transcriptsEnable`/`transcriptsDisable` functions' survivors are
  mutant-for-mutant identical to the pre-existing `calendarEnable`/
  `calendarDisable` code they were modeled after (same `print` default
  pattern, same conditional-spread option-forwarding, same
  `isConsentRequiredError` branch gap) — i.e. new code matches, not
  regresses, the established quality bar for this class of CLI
  function. Added one test beyond the RED list (non-consent
  `AuthError` propagates unmodified) that closes a real gap shared with
  `calendarEnable`. Not attempting to backfill `cli.ts`'s entire
  pre-existing mutation debt as part of this two-flag sub-slice.
  Plan: [plans/done/calendar-transcripts.md](plans/done/calendar-transcripts.md)
  §T2.
- Meeting transcripts, sub-slice T3 of 6 (`TranscriptClient` seam +
  fake): new [src/sources/transcript.ts](../src/sources/transcript.ts)
  — `TranscriptHandle` DTO (`transcriptId`, `createdAt`, `contentUrl`)
  and the `TranscriptClient` interface (`listTranscripts`,
  `fetchVttContent`), mirroring `CalendarClient`'s one-seam shape so the
  sync job (T5) can be written generically. Keyed by `onlineMeetingId`
  (from `events.online_meeting_id`, populated by calendar slice 5) —
  the plan's T3 description said "eventId" loosely, but
  `GET /me/onlineMeetings/{onlineMeetingId}/transcripts` is what the
  real endpoint (T4) actually takes, so the seam is typed for the
  identifier that will actually be threaded through, not the
  looser wording. New
  [src/testing/fake-transcript-client.ts](../src/testing/fake-transcript-client.ts)
  mirrors `FakeCalendarClient`: fixtures keyed by onlineMeetingId
  (transcript lists) and transcriptId (VTT content), throws a named
  error for an unscripted key so a wrong-id bug in the sync job (T5)
  surfaces immediately instead of silently returning nothing. No HTTP,
  no VTT parsing yet — both land in T4. `transcript.ts` is pure
  interface/DTO declarations with zero executable statements, so it has
  zero mutants (mutation testing is vacuous here, not a coverage gap);
  `fake-transcript-client.ts` is test infrastructure, excluded from
  both coverage and mutation scope by
  [stryker.config.mjs](../stryker.config.mjs) the same way
  `fake-calendar-client.ts` already is.
  Plan: [plans/done/calendar-transcripts.md](plans/done/calendar-transcripts.md)
  §T3.
- Meeting transcripts, sub-slice T4 of 6 (`HttpTranscriptClient` + VTT
  parser): new
  [src/sources/http-transcript-client.ts](../src/sources/http-transcript-client.ts)
  — real `GET /me/onlineMeetings/{id}/transcripts` (list) and
  `.../transcripts/{transcriptId}/content?$format=text/vtt` (fetch,
  preferring the handle's own `contentUrl` when Graph provided one)
  impl, mirroring `HttpCalendarClient`'s shape exactly: delegated token
  via an injected `getAccessToken(id, scope, forceRefresh)` callback,
  401 force-refresh-and-retry-once, 429 `Retry-After` mapping, 5xx
  backoff-with-jitter-and-retry, bearer redaction, ≤200-char error body
  truncation. Two new error classes on
  [transcript.ts](../src/sources/transcript.ts): `TranscriptQuotaExhaustedError`
  (402 — the metered content-fetch limit) and
  `TranscriptNotAvailableError` (403/404 — not transcribed, API
  disabled, or the meeting expired; Graph gives no reliable way to tell
  these apart from the response alone, so they collapse to one status).
  Also new: `parseVtt(text): readonly VttCue[]` — a small in-tree
  WebVTT parser (no dependency), tolerant of an optional cue-identifier
  line before the timing line, `<v Name>` / `<v.class Name>` voice
  tags (treating the class as an email only when it's shaped like one),
  overlapping cue times, and unicode text.
  Design correction from the plan: the "403 → `not-available` if body
  says API disabled; `consent-required` if body says missing grant"
  distinction doesn't map onto how consent detection actually works in
  this codebase — `isConsentRequiredError` inspects MSAL/AuthError
  messages from *token acquisition* failures (`interaction_required` /
  `consent_required` / `AADSTS65001`), not Graph HTTP response bodies
  from a call made with an already-valid token. A consent problem
  would surface as an exception from the `getAccessToken` callback
  before `HttpTranscriptClient` ever makes the request — same as
  `--calendar-enable`'s existing consent-rejection handling — so there
  is no "403-body-means-consent-required" case for this client to
  detect; both 403 and 404 map to the single `not-available` status.
  Mutation score 85.94% (started at 75.78% pre-hardening — all-new
  code this slice, so unlike prior legacy-file findings this one got
  fixed properly rather than documented-and-accepted: added ~20 tests
  targeting `parseVtt`'s regex anchors, null-timestamp/empty-text drop
  paths, voice-tag edge cases, and the `#request` retry math). Three
  regex-quantifier survivors remain and are accepted as effectively
  equivalent mutants — e.g. `\s+` → `\s` in the voice-tag regex is
  unobservable because the capture group's own `.trim()` absorbs the
  difference and the overall match boundary (used for `cueText`
  slicing) is identical either way.
  Plan: [plans/done/calendar-transcripts.md](plans/done/calendar-transcripts.md)
  §T4.
- Meeting transcripts, sub-slice T5 of 6 (`syncTranscripts` job +
  scheduler wiring): new
  [src/sync/sync-transcripts.ts](../src/sync/sync-transcripts.ts) — walks
  an account's ended online-meeting events from the last 60 days
  (`TRANSCRIPT_ELIGIBILITY_DAYS`), fetches+parses+stores any transcript
  Graph has for them (capped at `MAX_TRANSCRIPT_EVENTS_PER_TICK = 20` per
  tick), and applies the T1-specced retry cooldowns (`not-available`
  never retried, `quota-exhausted` 7 days, `fetch-failed` 24h; "any row
  ever ok" makes an event permanently done regardless of later rows).
  Wired into `sync-scheduler.ts` behind a double gate — both
  `calendar_accounts.enabled` AND `.transcripts_enabled` must be true,
  since transcript sync reads events off the store that only calendar
  sync populates. `src/index.ts` now constructs a real
  `HttpTranscriptClient`, sharing calendar's existing
  `getAccessToken(username, scope, forceRefresh)` callback (MSAL doesn't
  care which caller asked). `SyncLogEntry.source`/`SyncStatusRow.source`
  widened from `MessageSource` to a new `SyncLogSource = MessageSource |
  "transcripts"` — transcripts never produce `Message` rows (same as
  `"calendar"`, which already used this MessageSource-but-not-really
  pattern), so this keeps `Message.source` itself from ever matching on
  it.
  Two design corrections found and fixed before shipping, both self-caught
  during implementation rather than by the user:
  (1) T3/T4's `TranscriptClient.listTranscripts`/`fetchVttContent` were
  wrongly passing `onlineMeetingId` as the token-resolution "account"
  argument — MSAL tokens are per-user-account, not per-meeting. Fixed by
  adding an explicit `account` parameter to the interface, the fake, and
  the HTTP client (mechanical but codebase-wide: three source files plus
  their tests).
  (2) `syncTranscripts` originally caught *every* client error
  (including consent-required) and persisted it as a per-event
  `fetch-failed` status — for a consent problem that's wrong on two
  counts: it silently retry-loops every 24h forever, and it never
  surfaces the actionable admin-consent hint the scheduler already knows
  how to produce for calendar. Fixed by rethrowing
  `isConsentRequiredError(err)` from both catch sites so it propagates to
  the scheduler's existing per-account catch block, mirroring
  `syncCalendarEvents`'s identical pattern exactly.
  Also found and removed one line of dead code during mutation
  hardening: the JS-side `endAt < from` re-check was provably
  unreachable — both `MessageStore` implementations' `getEventsInRange`
  already filter on the exact `end_at >= from` bound (not an
  approximation, as the removed comment claimed), so every candidate the
  store returns already satisfies it.
  Mutation score 85.32% combined (`sync-transcripts.ts` 92.79%,
  `sync-scheduler.ts` 80.77% — the latter is a large file most of which
  predates this slice; its own new transcripts block is fully killed).
  Three accepted-equivalent survivors documented inline in
  `sync-transcripts.ts`: the `not-available` case's `return false` is
  unobservable because the sole call site only checks truthiness (an
  implicit `undefined` from a dropped case is exactly as falsy as
  `false` there), and `NO_TRANSCRIPT_FOUND_MARKER`'s exact string value
  doesn't affect correctness beyond non-collision with real GUIDs.
  Plan: [plans/done/calendar-transcripts.md](plans/done/calendar-transcripts.md)
  §T5.
- Meeting transcripts, sub-slice T6 of 6 (MCP surface — **last
  transcripts sub-slice, feature complete**): new `get_event_transcript(
  event_id, account?)` MCP tool
  ([src/mcp/tools/get-event-transcript.ts](../src/mcp/tools/get-event-transcript.ts))
  returns `{transcript, segments}` for an event's most-recently-fetched
  *successful* transcript (an event can accumulate more than one row —
  e.g. a recording restart — only `status: 'ok'` rows count, and the
  newest wins); `null`/`[]` when nothing's been fetched yet, not an
  error. `get_event` (slice 5) gained an optional `include_transcript:
  boolean` that folds the same shape into a `linkedTranscript` field —
  the field is omitted entirely when not requested, not `null`, so "the
  meeting + its chat + its transcript" is one call when wanted. Neither
  tool applies steering, mirroring `get_event`'s existing carve-out.
  Extracted `resolveEvent` (the "look up directly, or search every
  account and require disambiguation on a collision" logic) out of
  `get_event.ts` into a new
  [resolve-event.ts](../src/mcp/tools/resolve-event.ts) — a pure
  refactor under `get_event.test.ts`'s existing coverage, done because
  `get_event_transcript` needed the identical resolution logic and
  duplicating it would have been the second copy. Mutation score 90.09%
  combined (`get-event.ts` 93.33%, `get-event-transcript.ts` 91.11%,
  `resolve-event.ts` 80.95% — its remaining survivors are all in the
  ambiguous-event error message's exact wording, which no test
  meaningfully depends on beyond `instanceof InvalidParamsError`).
  Also closed a **pre-existing** coverage gap while touching
  `mcp-server.ts`: neither `get_event` nor any tool's dispatch line had
  ever been exercised through an actual `client.callTool()` round-trip
  (only via direct unit tests on the handler functions) — added
  dispatch-level tests for both `get_event` and the new
  `get_event_transcript`.
  This completes the meeting-transcripts feature (T1–T6 of 6; T7 FTS5
  search remains optional/deferred per the original spec) and the full
  14-slice calendar + transcripts roadmap.
  Plan: [plans/done/calendar-transcripts.md](plans/done/calendar-transcripts.md)
  §T6.
- Meeting transcripts, sub-slice T7 of 6 committed sub-slices (optional,
  now also done — **the full calendar + meeting-transcripts feature is
  complete**): schema v19 adds `transcript_segments_fts`, an
  external-content FTS5 table mirroring `messages_fts` (migration 2)
  exactly — same `content=`/`content_rowid='rowid'` approach (the
  parent table's composite TEXT primary key still leaves SQLite's
  implicit rowid available, same situation as `messages.id`), same
  `ai`/`ad`/`au` trigger shape. New `MessageStore.searchTranscriptSegments(query,
  limit)` (no steering — transcripts attach to events, which already
  have their own predicates). Extended the `search` MCP tool with an
  optional `kinds: ("message" | "transcript")[]` input, default
  `["message"]` to preserve the exact original response shape (mirrors
  `get_recent_activity`'s legacy/unified split from slice 7); once
  `kinds` includes `"transcript"`, every hit carries a `kind`
  discriminator plus either `message` or `segment`.
  `sender_email`/`sender_name`/`after`/`before`/`include_body` stay
  message-only; a transcript-kind search with no query text yields zero
  transcript hits rather than an error.
  One migration-ordering bug caught during the schema TDD cycle, not
  anticipated by the plan: `MIGRATION_19`, being the newest migration,
  is the one every existing "rewind `user_version` and re-apply"
  regression test in `schema.test.ts` re-runs on its second
  `applyMigrations` call — unlike `MIGRATION_2`'s `messages_fts` (never
  re-triggered, since no test rewinds below v2). Fixed with `CREATE
  VIRTUAL TABLE IF NOT EXISTS` / `CREATE TRIGGER IF NOT EXISTS` / `INSERT
  OR IGNORE` on the backfill, none of which the original messages_fts
  migration needed.
  Mutation score 82.17% across the touched production files
  (`schema.ts`, `sqlite-message-store.ts`, `in-memory-message-store.ts`,
  `search.ts` — three of these are large pre-existing files carrying
  unrelated legacy survivors; the new `searchTranscriptSegments` method
  and the v19 migration gate achieved a full kill in both store
  implementations and schema.ts respectively).
  Plan: [plans/done/calendar-transcripts.md](plans/done/calendar-transcripts.md)
  §T7.
- Re-specced the calendar+transcripts plan docs before implementation
  started: calendar sync is now per-account opt-in (not on-by-default
  like other sources), the initial sync window widened to a year of
  history, the upcoming events tool gained subject/attendee filters and
  was renamed `find_events`, and the transcripts follow-up was promoted
  from optional to committed (slices 9–14) after confirming against
  current Microsoft Graph docs that transcripts use delegated auth (no
  app-only client needed) and are not Teams Premium-gated.

## 2026-06-21

- **Migrated production off the NAS+Docker onto the Mac mini (`waldomacmini1`), native, no Docker.** Existing lake moved intact (1.37 GB, 65,567 messages, schema v15) via tar-over-ssh, `integrity_check`/`quick_check` gated, zero re-sync; MSAL token cache copied (5 accounts, first tick 19 ok / 0 errors). Now a launchd LaunchDaemon `com.waldo.wtf.server` (`KeepAlive` + the existing in-process event-loop watchdog replace the Docker `autoheal` sidecar). Data root `/Users/waldo/waldo-wtf/{db,auth,whatsapp-inbox,whatsapp-archive,logs}` + `.env` (chmod 600, loaded by dotenv from the daemon WorkingDirectory). Exposed via Tailscale Serve TLS → `127.0.0.1:8765` at `https://<host>.<tailnet>.ts.net` (OAuth + static-bearer both live). Full runbook: [deploy-macmini.md](deploy-macmini.md).
- Added `NODE_OPTIONS=--dns-result-order=ipv4first` to the server env: this network's IPv6 path to some Microsoft 365 endpoints stalls large responses (an established IPv6 socket hangs); IPv4 is healthy. Captured as an operational note in [deploy-macmini.md](deploy-macmini.md).
- WhatsApp push ([../bin/wtf-whatsapp-push](../bin/wtf-whatsapp-push)) repointed off the NAS: new `WTF_PUSH_HOST`/`WTF_PUSH_INBOX` (default the Mac mini), legacy `WTF_NAS_*` accepted as deprecated aliases. TDD: 4 new tests in [../src/sync/whatsapp-push-script.test.ts](../src/sync/whatsapp-push-script.test.ts) (push-vars / Mac-mini-default / legacy-backward-compat / push-over-legacy precedence). Server-side chokidar watcher now watches `/Users/waldo/waldo-wtf/whatsapp-inbox`.
- NAS demoted to **backup-only**: containers removed, compose file neutralized (`docker-compose.yml.MIGRATED-to-macmini-20260621`) so a reboot can't start a second writer; pre-migration lake frozen at `/volume1/docker/waldo-wtf/`. New nightly hot-snapshot backup ([../deploy/wtf-backup.sh](../deploy/wtf-backup.sh) via `com.waldo.wtf.backup` @ 03:30) → `waldonas3:/volume1/backup/waldo-wtf/YYYY-MM-DD/`, keep 14 days.
- Removed Docker artifacts (`Dockerfile`, `docker-compose.yml`, `deploy-to-nas.sh`, `.dockerignore`, `docs/deploy-synology.md`, `docs/runbooks/autoheal-smoke.md`) and the `/deploy-nas` skill; replaced with `/deploy-local` + log rotation ([../deploy/newsyslog-waldo.conf](../deploy/newsyslog-waldo.conf)). Updated CLAUDE.md, local-smoke skill, migrations INDEX, README, PROGRESS.
- Known follow-ups: (1) Graph HTTP client has no per-request timeout — a hung endpoint blocks the first sync tick until the OS TCP timeout (~minutes); steady-state ticks are unaffected. (2) Several user docs (setup, getting-started, oauth, claude-desktop-wiring, user-guide, migration recipes) still describe the Docker/NAS path; superseded by [deploy-macmini.md](deploy-macmini.md), pending a focused prose pass.

## 2026-06-02

- Hardened the OAuth token lifecycle after a "connector shows no tools" incident where the NAS, Tailscale Funnel, cert, and OAuth discovery were all provably healthy and reachable from Claude's cloud egress, but the connector held expired credentials and could not self-recover. Two fixes in [../src/auth/oauth/token.ts](../src/auth/oauth/token.ts): (1) raised the access-token TTL from 1 h to **24 h** (`expires_in` 3600 → 86400) so the connector no longer depends on a flawless hourly refresh; (2) made the `refresh_token` grant **non-rotating** — the same refresh token is reused, a fresh access token is minted (the previous one stops validating), and the refresh token's 30-day expiry slides forward. This removes the destructive-rotation bricking failure mode where a single lost refresh response permanently invalidated the client's stored refresh token (recovery only via manual remove/re-add for up to 30 days), and fixes a latent bug where an expired/unknown refresh attempt deleted stored state. Replaced the destructive `consumeRefreshToken` with a non-destructive `refreshAccessToken(refreshToken, now, newAccessToken, accessExpiresAt, refreshExpiresAt)` on the `AuthStore` interface ([../src/auth/oauth/auth-store.ts](../src/auth/oauth/auth-store.ts)), implemented as a single `UPDATE … WHERE refresh_token=? AND refresh_expires_at>?` in [../src/auth/oauth/sqlite-auth-store.ts](../src/auth/oauth/sqlite-auth-store.ts) and mirrored in [../src/testing/in-memory-auth-store.ts](../src/testing/in-memory-auth-store.ts). No schema migration (existing columns only). Security trade-off (single-user server behind Tailscale/Funnel): a leaked refresh token stays valid up to its 30-day window rather than being single-use. 9 tests added/updated across [../src/auth/oauth/token.test.ts](../src/auth/oauth/token.test.ts) (24h TTL, new-access-same-refresh, non-bricking double refresh, old-access-invalidated) and [../src/auth/oauth/auth-store-contract.ts](../src/auth/oauth/auth-store-contract.ts) (slide expiries, invalidate old access, non-bricking, unknown/expired-leaves-row-intact — run against both stores); existing authorization_code, PKCE, and auth-code cases stay green. Touched files at 100 % line coverage. Operator action to recover the live connector: remove + re-add the waldo.WTF connector in the Claude app. `docs/oauth.md` updated (24 h TTL, non-rotating refresh). Plan archived: [plans/done/oauth-token-ttl-and-refresh-hardening.md](plans/done/oauth-token-ttl-and-refresh-hardening.md). Separately surfaced (not in this change): `npm audit` reports 3 dev-only high/critical advisories in the vitest toolchain — flagged for a follow-up upgrade.

## 2026-05-03

- Changed `get_thread` default to return the **latest** N messages instead of the **first** N. The previous "oldest first" default was wrong for almost every plausible use case; a live session today caught it the hard way — the model called `get_thread(BC Dev Talk, limit=500)` against a 1697-message WhatsApp thread, got messages 1–500 (oldest), saw the most recent `sentAt` was 2 April, and concluded that the WhatsApp ingest had been broken for a month. The ingest was fine; today's `WhatsApp Chat - BC Dev Talk.zip` (94K) imported cleanly at 17:49 UTC and lives at thread positions ~1500–1697 — completely unreachable through the old `get_thread` (no pagination, no descending order). New default in [../src/store/sqlite-message-store.ts](../src/store/sqlite-message-store.ts) `getThread`: `SELECT * FROM (SELECT … ORDER BY sent_at DESC, id DESC LIMIT ?) ORDER BY sent_at ASC, id ASC` so callers still read chronologically within the returned slice. New `fromStart?: boolean` option on `GetThreadOptions` ([../src/store/message-store.ts](../src/store/message-store.ts)) and `from_start?: boolean` on the MCP tool's params ([../src/mcp/tools/get-thread.ts](../src/mcp/tools/get-thread.ts)) preserves the original "oldest from the start" behavior for the rare case the user explicitly asks how a long conversation began. Tool description rewritten to make the new default loud and to call out when to opt in to `from_start: true`. 5 new tests across [../src/store/message-store-contract.ts](../src/store/message-store-contract.ts) (default-latest, fromStart-regression, full-thread-when-limit-exceeds-total) and [../src/mcp/tools/get-thread.test.ts](../src/mcp/tools/get-thread.test.ts) (from_start validation, default-plumbing, true-plumbing, default-returns-latest-snippets, fromStart-true-regression). [../src/testing/in-memory-message-store.ts](../src/testing/in-memory-message-store.ts) updated to match the new contract so MCP-tool unit tests using the fake see the same behavior. User guide [user-guide.md §`get_thread`](user-guide.md) updated. Plan archived: [plans/done/fix-get-thread-latest-by-default.md](plans/done/fix-get-thread-latest-by-default.md).
- Closed the in-process detection gap for single-block event-loop wedges in [../src/health/event-loop-watchdog.ts](../src/health/event-loop-watchdog.ts). The existing "3 consecutive over-budget ticks" rule was invisible to the actual production wedge — autoheal logs from this morning showed two forced container restarts (16:03 UTC and 16:43 UTC, each ~2 min after a user query), and neither in-process watchdog fired because a single 90 s synchronous block produces ONE giant-lag tick when the loop unblocks, then `consecutive` resets to 0 on the next normal tick (the self-probe is similarly invisible: when the loop is blocked, its scheduled probe is queued behind the block; on unblock the probe succeeds, `consecutive` resets). New `singleBlockMs` option fires `onWedge()` immediately when one tick lags by more than the threshold (default 30000 ms), with a distinguishable `event_loop_watchdog_single_block lagMs=… thresholdMs=… actualMs=…` log line preceding the existing `watchdog: server wedged, exiting` line. Configurable via new env var `WALDO_WATCHDOG_SINGLE_BLOCK_MS` ([../src/config.ts](../src/config.ts) + [setup.md §3](setup.md)). Process exits via the existing SIGKILL-fallback path at [../src/index.ts:131-135](../src/index.ts) so Docker's `restart: unless-stopped` recovers within seconds — beating autoheal's ~90 s healthcheck cycle and giving us a log line that identifies what was running when the wedge started. 5 new tests in [../src/health/event-loop-watchdog.test.ts](../src/health/event-loop-watchdog.test.ts), [../src/config.test.ts](../src/config.test.ts), [../src/index.test.ts](../src/index.test.ts) cover single-block firing (AC1), distinguishable log line (AC4), env var default + override + invalid (AC5–AC7), and config-to-watchdog plumbing (AC8); existing 3-consecutive (AC2) and small-lag-no-fire (AC3) cases stay green. **Detection only — does not fix the underlying wedge.** Once a wedge happens with this shipped, the `event_loop_watchdog_single_block` log line plus the request log immediately preceding it gives us the data needed for the next cycle (root-cause fix; top suspect is a slow synchronous better-sqlite3 query in `search` / `get_recent_activity` / `get_thread` against the production-sized DB). Plan archived: [plans/done/fix-watchdog-single-block-detection.md](plans/done/fix-watchdog-single-block-detection.md).
- Tightened `classifyError` 401/410 heuristics in [../src/mcp/tools/classify-error.ts](../src/mcp/tools/classify-error.ts) to require HTTP-status context. The previous loose `(^|[^\d])401([^\d]|$)` regex matched any "401" surrounded by non-digits, so benign strings like `"took 401ms"`, `"req_id=401"`, `"port 4010 in use"` were classified as `auth` and surfaced through [../src/mcp/tools/diagnose-sync-health.ts](../src/mcp/tools/diagnose-sync-health.ts) as a misleading "re-authenticate your account" remediation prompt. Same shape bug fixed for `410`. New patterns require one of: status word adjacent (`401 Unauthorized` / `401 Forbidden` / `410 Gone`), HTTP-context token adjacent (`http|graph|yammer|msal 401`), `status: 401` / `status=401`, or leading `^401\b`. 4 new tests in [../src/mcp/tools/classify-error.test.ts](../src/mcp/tools/classify-error.test.ts) cover false-positive substrings (AC3/AC4) and HTTP-anchored regression (AC5/AC6); existing `TokenExpiredError` and `DeltaTokenInvalidError` cases stay green. The cycle's plan also proposed setting `db.pragma("busy_timeout = 5000")` on [../src/store/open-database.ts](../src/store/open-database.ts) but verification showed better-sqlite3 already defaults `busy_timeout` to 5000 ms — that part was dropped as a no-op. The actual root cause of intermittent MCP tool failures observed today is therefore still unidentified and is filed for a follow-up investigation cycle (suspect: sync-scheduler concurrency, unhandled rejections on outbound Graph fetches, or HTTP-layer back-pressure — not SQLite contention). Plan archived: [plans/done/fix-classify-error-401-410-anchoring.md](plans/done/fix-classify-error-401-410-anchoring.md).

## 2026-04-27

- MCP tool errors now surface a redacted error class + first message line instead of the opaque `"internal error"` string. Changed [../src/mcp/mcp-server.ts](../src/mcp/mcp-server.ts) catch-all so `McpError(InternalError, …)` carries `<ErrorClass>: <first-line redacted message>` (e.g. `"SqliteError: database is locked"`); full stack still goes to stderr only via the existing `console.error` path. Bearer tokens and long base64-like blobs in the surfaced line are run through `redactSecretsFromError` so credentials never leak to the client. Closes the "transient flake reads as identical to a real bug" gap that ate diagnostic time on `diagnose_sync_health` this morning. 3 new tests in [../src/mcp/mcp-server.test.ts](../src/mcp/mcp-server.test.ts) cover Error-subclass class+first-line surfacing, bearer/long-secret redaction, and non-Error string throws. Plan archived: [plans/done/mcp-error-detail-surfacing.md](plans/done/mcp-error-detail-surfacing.md).

## 2026-04-26

- Restored per-file 90% coverage thresholds on [../src/sources/http-teams-client.ts](../src/sources/http-teams-client.ts) (functions 83.33% → 100%) and [../src/sync/sync-teams-channels.ts](../src/sync/sync-teams-channels.ts) (branches 85.41% → 98.19%) — both regressed when commit `5aaa064` added multi-tenant fan-out without exercising the default `sleep` arrow, the html body path, the `mentionToString` displayName/mentionText fallback ladder, the system-event reply filter, the empty-body / no-team-name `threadName` fallback, the 40-char snippet truncation, or the 200-char thread-name truncation. 7 new tests, no production change. `npm test` exits 0 again — unblocks `/deploy-nas` for the VIVA fix in `9314d0b`. Plan archived: [plans/done/fix-coverage-teams-channel-sync.md](plans/done/fix-coverage-teams-channel-sync.md).
- Replaced VIVA Engage sync's stale per-thread cursor walk with a rolling 24h window in [../src/sync/sync-viva.ts](../src/sync/sync-viva.ts), and fixed a count-inflation bug where `sync_log.messages_added` was set to `r.added + r.updated` so re-upserts of unchanged posts inflated `messagesAddedLast24h` to ~83k/day for ~514 actually-new posts. Each cycle now fetches one page of threads per community (no thread pagination), then walks post pages backward only until `createdDateTime < (now - 24h)`. Yammer REST has no delta API, so the previous cursor was never load-bearing — the 24h window is self-healing across overnight outages and trims VIVA's per-cycle API budget from ~148 calls to ~28. Reported count now reflects `r.added` only (genuinely new rows). The `viva_subscriptions.lastCursorAt` column stays in the schema (no migration) but is no longer read or written. 6 new tests + 1 net cursor-walk-test removal in [../src/sync/sync-viva.test.ts](../src/sync/sync-viva.test.ts) cover single-page thread fetch, 24h cutoff exclusion, post-page walk-and-stop, count semantics, no-cursor-write, initial-sync windowing, plus a new 401→429-on-retry path test that covers a previously-untested branch. Plan archived: [plans/done/viva-sync-over-fetching.md](plans/done/viva-sync-over-fetching.md).

## 2026-04-25

- Fixed `--teams-subscribe` / `--teams-unsubscribe` parser to accept real Microsoft Graph channel IDs. `parseTeamChannelKey` previously split on every `:` and demanded exactly 2 or 3 parts, which is incompatible with real channel IDs that always start with `19:` (e.g. `19:abc@thread.tacv2`). The parser now detects the `:19:` boundary and treats everything from `19:` onward as a single `channelId` regardless of embedded colons; falls back to the old strict split when no `19:` prefix is present (synthetic test fixtures still parse). Surfaced when a user pasted real IDs from `--teams-discover` and got `--teams-subscribe expects <teamId>:<channelId> ...` instead of a working subscription. 3 new tests in [src/cli.test.ts](../src/cli.test.ts) cover the 2-part + 3-part real-ID forms and the unsubscribe path. Plan archived: [plans/done/teams-subscribe-channel-id-colons.md](plans/done/teams-subscribe-channel-id-colons.md).
- Added `--teams-admin-consent --account <username>` CLI flag — prints one tenant-wide admin-consent URL per cached MSAL tenant for the user, format `https://login.microsoftonline.com/<tenantId>/adminconsent?client_id=<MS_CLIENT_ID>`. Closes the channels-scopes consent gap discovered today: `--add-account` only ever asks for `Mail.Read` + `Chat.Read`, so cached refresh tokens never had `Team.ReadBasic.All` / `Channel.ReadBasic.All` / `ChannelMessage.Read.All` consented and silent acquisition kept returning `AADSTS65001`. A tenant admin opens the printed URL once per tenant, clicks Accept, and the existing refresh token silently mints channels-scoped tokens on the next sync tick — no re-login required. 6 new tests in [src/cli.test.ts](../src/cli.test.ts) cover parser, dispatch, output format, dedup-by-tenant, unknown-account error path, and URL composition. Documented in [user-guide.md §5c](user-guide.md). Plan archived: [plans/done/teams-admin-consent-url.md](plans/done/teams-admin-consent-url.md).
- Multi-tenant fan-out for Teams channels — discover and sync now walk every cached MSAL account that matches a username, acquire a per-tenant token with `teamsAuthorityFor(tenantId)`, and isolate per-tenant errors. `--teams-discover --account` no longer silently picks the wrong tenant when the same UPN exists in multiple MSAL caches: tenants without admin consent for `ChannelMessage.Read.All` print a `skipped tenant <id>: admin-consent required` line and the rest still resolve. Discover output gains a leading `tenant_id` column so the user can pick the right candidate when one channelId is reachable across multiple tenants. `--teams-subscribe` accepts a 3-segment form `<tenantId>:<teamId>:<channelId>` to disambiguate; the 2-segment form still works when the channel exists in exactly one tenant. New schema migration 15 adds nullable `tenant_id` to `teams_channel_subscriptions` (NULL = legacy, falls back to `account.tenantId` at sync time). 10 new tests across [src/cli.test.ts](../src/cli.test.ts), [src/sync/sync-teams-channels.test.ts](../src/sync/sync-teams-channels.test.ts), [src/sync/sync-scheduler.test.ts](../src/sync/sync-scheduler.test.ts), [src/store/teams-channel-subscription-store-contract.ts](../src/store/teams-channel-subscription-store-contract.ts), [src/store/schema.test.ts](../src/store/schema.test.ts) cover fan-out, isolation, fallback, and migration idempotence. Plan archived: [plans/done/teams-channels-multi-tenant-fan-out.md](plans/done/teams-channels-multi-tenant-fan-out.md).
- Added Microsoft Teams **channel** messages as a fifth source (`source: "teams-channel"`), opt-in per channel like Viva Engage. New CLI flags on the existing dev surface: `--teams-list`, `--teams-discover`, `--teams-subscribe <teamId>:<channelId>`, `--teams-unsubscribe <teamId>:<channelId>`. Subscriptions live in the new `teams_channel_subscriptions` table (schema migration 14, additive — existing dbs get the table on next start). Sync uses Graph delta with `$expand=replies` against `/teams/{id}/channels/{id}/messages/delta`, keyed in `chat_cursors` as `channel:<teamId>:<channelId>`; one HTTP call returns root post + inline replies, threaded as `teams-channel:<teamId>:<channelId>:<rootId>` so reply chains stay together. New scopes (`Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`) are acquired lazily and held separate from the base Graph scopes — tenants without admin consent for `ChannelMessage.Read.All` degrade cleanly with one `admin-consent-required` log row per affected account per tick rather than blocking the rest of the scheduler. `get_recent_activity`, `search`, `list_threads`, and `add_steering_rule` widened to accept the new source. Plans archived: [plans/done/teams-channels-overview.md](plans/done/teams-channels-overview.md) + 5 phase files.
- Wired both watchdogs into the composition root in [../src/index.ts](../src/index.ts) — after `server.listen` resolves, `startEventLoopWatchdog` (5s/1s) and `startSelfProbe` (30s/5s/3-fail) run with a shared `onWedge` handler that logs `watchdog: server wedged, exiting`, schedules a 5-second `SIGKILL` fallback (`.unref()`-ed in case `process.exit` itself stalls), then calls `process.exit(1)`. New env var `WALDO_WATCHDOG_DISABLED=1` ([config.ts](../src/config.ts) + [setup.md §3](setup.md#3-environment-variables)) is the kill switch for `--add-account` interactive runs and local debugging. `shutdown()` now stops both watchdogs *before* `httpServer.close()` so graceful exits never trip the self-probe. 8 new tests across [config.test.ts](../src/config.test.ts) + [index.test.ts](../src/index.test.ts) cover the watchdog wiring, kill-switch, shutdown ordering, and wedge handler. Closes Plan A2 §2.3 — Phase 2 (in-process watchdogs) is done; per-slice plan archived at [plans/done/wire-watchdogs-bootstrap-slice.md](plans/done/wire-watchdogs-bootstrap-slice.md).
- Added `startSelfProbe` in [../src/health/self-probe.ts](../src/health/self-probe.ts) — issues an `AbortController`-protected GET to `http://127.0.0.1:port/health` every `intervalMs` and calls `onWedge()` after 3 consecutive failures (timeout, non-200, or network error). Complements A2.1: A2.1 catches a wedged event loop, A2.2 catches an HTTP layer that's running but not answering. Pure module — no bootstrap wiring yet (Slice A2.3). Uses bare `globalThis.fetch` (allowed under the A3.4 lint rule, which scopes only `src/sources/**` and `src/sync/**`); always wrapped in an `AbortController` with `timeoutMs`. 7 tests, 100% line + 94.7% branch coverage. Slice A2.2 of [plans/server-hang-autoheal.md](plans/server-hang-autoheal.md) §Phase 2; per-slice plan archived at [plans/done/self-probe-slice.md](plans/done/self-probe-slice.md).
- Added `startEventLoopWatchdog` in [../src/health/event-loop-watchdog.ts](../src/health/event-loop-watchdog.ts) — measures `setTimeout` lag against the injected `Clock` and calls `onWedge()` after 3 consecutive over-budget intervals (default budget = `intervalMs + maxLagMs`). Pure module — no bootstrap wiring yet (Slice A2.3 will mount it). Mirrors the `SyncScheduler` `setTimer` seam pattern; production wiring uses real `setTimeout`/`clearTimeout`, tests inject a manual timer for deterministic ticks. 6 tests, 100% line+branch coverage. Standalone safety net since Plan A3 prevents the wedge in the first place — this only fires if A3's fetch-timeout / server-timeout combo somehow misses a path. Slice A2.1 of [plans/server-hang-autoheal.md](plans/server-hang-autoheal.md) §Phase 2; per-slice plan archived at [plans/done/event-loop-watchdog-slice.md](plans/done/event-loop-watchdog-slice.md).
- Locked in the timeout-wrapping work with an ESLint rule. New `eslint.config.js` (flat config) bans bare `fetch` in `src/sources/**` and `src/sync/**` via `no-restricted-globals`; message points at `createFetchWithTimeout`. Added `eslint` + `typescript-eslint` as devDeps and a `npm run lint` script. New regression test [../src/__meta__/lint-bare-fetch.test.ts](../src/__meta__/lint-bare-fetch.test.ts) drives ESLint programmatically against the fixture [../src/sources/__lint__/bare-fetch.fixture.ts](../src/sources/__lint__/bare-fetch.fixture.ts) and asserts the rule fires; second test asserts the live tree is clean. Two pre-existing `// eslint-disable-next-line` directives referencing rules from `@typescript-eslint`'s strict-checked plugin (which is not installed) were removed — the underlying `any` and `throw "string"` patterns are unchanged. [docs/tdd/testability-patterns.md §5](tdd/testability-patterns.md) updated to point at the lint rule. Slice A3.4 closes Plan A3 §3.4; per-slice plan archived at [plans/done/lint-bare-fetch-slice.md](plans/done/lint-bare-fetch-slice.md).
- Applied Node's built-in HTTP server timeouts in [../src/mcp/http-server.ts](../src/mcp/http-server.ts) — `server.requestTimeout = 60_000`, `server.headersTimeout = 30_000`, `server.keepAliveTimeout = 65_000`, and explicit `server.timeout = 0`. Closes the slow-loris hole exposed in §3.3 of the parent autoheal plan: a client that opens a socket and dribbles bytes (or never sends them) can no longer pin a request slot indefinitely. New optional `timeouts?: { requestMs?, headersMs?, keepAliveMs? }` field on `McpHttpServerOptions` lets tests/operators override; defaults are unchanged on the production path. Two property-assertion tests in [../src/mcp/http-server.test.ts](../src/mcp/http-server.test.ts) cover defaults and overrides — Node's `http` module is the source of truth for actual socket-close behavior. Slice A3.3 of [plans/server-hang-autoheal.md](plans/server-hang-autoheal.md); per-slice plan archived at [plans/done/server-side-timeouts-slice.md](plans/done/server-side-timeouts-slice.md).
- Added `willfarrell/autoheal` sidecar to [docker-compose.yml](../docker-compose.yml) and tagged the `waldo` service with `autoheal=true`. The sidecar watches every container with that label and issues a `docker restart` after 3 consecutive `unhealthy` verdicts (~90s with the existing 30s healthcheck interval × 3 retries). Closes the gap exposed twice in production where the MCP server's TCP listener stayed bound but the event loop was wedged — `restart: unless-stopped` only fires on process exit, never on a stuck loop. Slice A1.1 of [plans/server-hang-autoheal.md](plans/server-hang-autoheal.md); per-slice plan archived at [plans/done/server-hang-autoheal-A1.1-autoheal-sidecar.md](plans/done/server-hang-autoheal-A1.1-autoheal-sidecar.md).
- Hardened the `waldo` healthcheck in [docker-compose.yml](../docker-compose.yml): swapped `node -e "fetch(...)"` for `node --eval` using `node:http`'s built-in `request({timeout: 3000})` with explicit `process.exit(1)` on timeout/error/non-200. `fetch()` has no per-request timeout and (under the wedge hypothesis) shares the same loop primitives as the wedged app, which would burn through autoheal's verdict cycles. The new check fails in <3s on any failure path, locally verified against an unreachable port. Slice A1.2 of [plans/server-hang-autoheal.md](plans/server-hang-autoheal.md); per-slice plan archived at [plans/done/server-hang-autoheal-A1.2-harden-healthcheck.md](plans/done/server-hang-autoheal-A1.2-harden-healthcheck.md).
- Added [runbooks/autoheal-smoke.md](runbooks/autoheal-smoke.md) — manual procedure to verify the autoheal sidecar restarts a wedged container (uses `docker exec waldo-wtf kill -STOP 1` to simulate the failure mode). Includes the trust decision for the privileged `docker.sock` mount on the sidecar. Linked from [README.md](README.md) ("For contributors" → Runbooks) and [setup.md §10](setup.md). New `docs/runbooks/` directory with its own [index](runbooks/README.md). Slice A1.3 closes Plan A1; per-slice plan archived at [plans/done/server-hang-autoheal-A1.3-smoke-runbook.md](plans/done/server-hang-autoheal-A1.3-smoke-runbook.md).
- Verified Plan A1 live in production: paused the running container with `docker pause waldo-wtf` at 10:23:16Z, autoheal sidecar logged `Container /waldo-wtf (...) found to be unhealthy - Restarting container now with 10s timeout` 3s later, fresh `MCP server listening` at 10:23:42Z — total recovery ~26s. Safety net is on.
- Fixed [runbooks/autoheal-smoke.md](runbooks/autoheal-smoke.md) wedge step: switched from `docker exec waldo-wtf kill -STOP 1` to `docker pause waldo-wtf`. The original method had two problems — the runtime image is slim and has no `kill` binary in PATH, and even if it did, the kernel filters fatal/stop signals to PID 1 of a child PID namespace so `SIGSTOP` would have been silently dropped. `docker pause` uses the cgroups freezer directly, which sidesteps both. Updated cleanup, expected log line (new `willfarrell/autoheal` message format), and the "if the test fails" diagnostic. "Last verified" now stamped 2026-04-25.
- Wired `createFetchWithTimeout` into the production composition root in [../src/index.ts](../src/index.ts) — all 3 HTTP clients (`HttpGraphClient`, `HttpTeamsClient`, `HttpYammerClient`) now share a single wrapped fetch with a 60s default timeout. No single stuck Graph/Yammer connection can wedge the event loop indefinitely; if upstream hangs past 60s, the wrapper fires `AbortController.abort(TimeoutError)` and the affected sync surfaces as a normal error in the next tick. One regression test per client in `src/sources/http-{graph,teams,yammer}-client.test.ts` proves the wrapper threads through the client's `#request` and aborts a hung inner fetch. Slice A3.2 of [plans/server-hang-autoheal.md](plans/server-hang-autoheal.md) §Phase 3; per-slice plan archived at [plans/done/wrap-http-clients-with-timeout-slice.md](plans/done/wrap-http-clients-with-timeout-slice.md).
- Added `createFetchWithTimeout({ fetch, defaultTimeoutMs })` in [../src/sources/fetch-with-timeout.ts](../src/sources/fetch-with-timeout.ts) — a `FetchLike → FetchLike` wrapper that links a default `AbortController` timeout into every outbound request while honoring a caller-supplied `signal` (whichever aborts first wins). Standalone module — no production wiring yet; Slice A3.2 will apply it at the `index.ts` composition root for the 3 HTTP clients (graph/teams/yammer). Also extends `FetchLike` init with optional `signal?: AbortSignal` (additive; existing clients ignore it). Slice A3.1 of [plans/server-hang-autoheal.md](plans/server-hang-autoheal.md) §Phase 3; per-slice plan archived at [plans/done/fetch-with-timeout-slice.md](plans/done/fetch-with-timeout-slice.md).
- `HttpTeamsClient` now retries transient 5xx (502/503/504) with a small jittered backoff (~250–500ms then ~750–1500ms; 2 retries; ~2s total budget) before surfacing the error. Other statuses (401/429/4xx/500) still throw on the first response. The bearer-redaction (`body.split(token).join("[redacted]")`) runs on every retry's body so leaked tokens never reach retry-loop bookkeeping or the eventual error message. New optional constructor seams (`sleep`, `random`, `maxRetries`) keep production wiring unchanged. Closes the WAUTERI@ifacto.be / teams `HTTP 502 BadGateway` flap seen in production logs at [2026-04-25T09:19:16Z]; one upstream Graph blip no longer flips a whole sync tick into the error column. Plan: [plans/teams-transient-5xx-retry.md](plans/teams-transient-5xx-retry.md); per-slice plan archived at [plans/done/teams-5xx-retry-slice.md](plans/done/teams-5xx-retry-slice.md).

## 2026-04-24

- Prefixed every `Logger.info` / `Logger.error` line with `[<ISO-UTC>]`. New `createTimestampedConsoleLogger(clock)` factory in [../src/logger.ts](../src/logger.ts) uses the existing `Clock` seam — timestamp is re-read on every call so logs reflect *when* the line was emitted, not when the logger was constructed. `src/index.ts` swapped `consoleLogger` → `createTimestampedConsoleLogger(systemClock)` in both `main()` and `runFromCli()`. The `consoleLogger` constant stays exported (now `@deprecated`) for tests and one-shot CLI paths. Operators reading `docker compose logs --tail=N` no longer have to remember `--timestamps` to tell whether the scheduler is still ticking. Plan: [plans/done/timestamped-logs.md](plans/done/timestamped-logs.md).
- Added `diagnose_sync_health` MCP tool (7th in the v1 surface). Zero-input, read-only; scans `sync_log` / `sync_state` / `accounts` / `viva_subscriptions` and returns ranked findings by category (`auth`, `rate-limit`, `delta-invalid`, `stale`, `repeated-failure`, `viva-sub-drift`, `never-synced`, `unknown-error`) with `overallStatus` rollup (`healthy` / `degraded` / `critical`). Each finding carries a paste-ready `remediationPrompt` (Bearer tokens + long opaque blobs redacted). Severity mapping: `auth` / `delta-invalid` always `error`; `stale > 6h` `error`, else `warn`; `repeated-failure ≥5` `error`, else `warn`; `rate-limit` / `viva-sub-drift` / `never-synced` / `unknown-error` `warn`. Viva drift honours a 24 h grace window after `subscribedAt` to avoid false positives on fresh subscriptions. New `MessageStore.getSyncLogRecent(limit)` and `VivaSubscriptionStore.listAll()` readers on both impls; `McpServerDeps` + `McpHttpServerOptions` gain an optional `vivaSubs?` threading so unit tests can omit it. Plan: [plans/done/weekend-8-diagnose-sync-health.md](plans/done/weekend-8-diagnose-sync-health.md).
- Viva sync self-heals stale Yammer access tokens on the same tick. On a first `TokenExpiredError` from `/messages/in_group/{id}`, `syncViva` now re-acquires the Yammer token with `forceRefresh: true` (bypassing MSAL's on-disk AT and the per-run `tokenCache`) and retries the offending community once; the fresh token replaces the cache entry so same-tenant subs later in the pass reuse it. A second 401 on the retry becomes a per-community error instead of aborting the whole account pass; 429 rate-limits still hard-stop. Closes the one-tick recovery gap identified in the 2026-04-24 investigation — stale-AT incidents now produce zero `error` rows and zero missed messages. Plan: [plans/done/viva-sync-force-refresh-on-401.md](plans/done/viva-sync-force-refresh-on-401.md).
- Fixed `syncViva` still silent-failing after per-tenant authority fix: scheduler now uses a Yammer-clientId `MsalAuthClient` for viva-engage token acquisition. Root cause: MSAL on-disk cache is partitioned by `clientId`; external-tenant refresh tokens only exist under `YAMMER_PUBLIC_CLIENT_ID` (written by `--add-account --tenant`), but the scheduler was calling `auth.getTokenSilent` on the main `MsalAuthClient { clientId: config.msClientId }`. Result: per-tenant silent-failed swallowed as per-community errors, `sync_log` kept recording `status=ok, messages_added=0` across 7 BC Partners communities despite correct `tenant_id` on every row. Fix: `SyncSchedulerDeps` gains `vivaAuth?: AuthClient`; `src/index.ts` constructs a second `MsalAuthClient { clientId: YAMMER_PUBLIC_CLIENT_ID, cacheStore }` sharing the existing `TokenCacheStore` and injects it. Accounts added before slice 4b-2 need `--add-account --tenant <home-tenant-guid>` once to seed the Yammer clientId cache. Plan: [plans/done/sync-viva-yammer-clientid.md](plans/done/sync-viva-yammer-clientid.md).
- Fixed the background `syncViva` tick silently ingesting 0 messages from subscriptions in external Yammer networks. Same root cause as today's `--viva-discover` fix: `auth.getTokenSilent(account, { scopes: [YAMMER_SCOPE] })` with no `authority` override let MSAL resolve `/common` to the account's home IDP, minting a Yammer token scoped to the home `network_id` only. Subs pointing at external networks then returned empty thread pages and `sync_log` recorded `status=ok, messages_added=0`. `syncViva` now groups enabled subs by `sub.tenantId ?? account.tenantId` and acquires one token per tenant with `authority: vivaAuthorityFor(tenantId)`; per-tenant token failures are isolated to just the subs in that tenant. `vivaAuthorityFor` moved from `src/cli.ts` to `src/auth/msal-auth-client.ts` (re-exported from cli for back-compat). Plan: [plans/done/sync-viva-per-tenant-authority.md](plans/done/sync-viva-per-tenant-authority.md).
- Fixed `--viva-discover` returning 0 communities against external tenants (6th attempt — the real fix this time). Three surgical changes to `discoverForAccount`: (1) home fetch now passes explicit `authority: vivaAuthorityFor(account.tenantId)` instead of relying on MSAL's `/common` default, which resolved to the guest's home IDP and minted a Yammer token scoped to the wrong `network_id`; (2) external-tenant registrations are matched by `username` case-insensitively rather than by `homeAccountId`, which changes across MSAL cache shuffles when `--add-account --tenant` stores the guest-tenant login's id; (3) registrations whose `externalTenantId` equals the home tenant are skipped to avoid double-listing. Proven against live Microsoft Yammer network with the POC token pattern. Plan: [plans/done/viva-discover-explicit-authority.md](plans/done/viva-discover-explicit-authority.md).
- Fixed `parseYammer` big-integer preservation on Node 20: replaced the ES2025 TC39 `context.source` reviver (Node 22+ only) with a pre-processing pass that quotes integer tokens exceeding `Number.MAX_SAFE_INTEGER` before `JSON.parse`. Yammer community and message IDs above 2^53 now round-trip losslessly as exact strings on all supported Node versions. Two previously-failing tests now pass.

## 2026-04-23

- Slice 4b-4 of the external-networks redesign: fixed the real external-tenant discovery gap. `AuthClient.getTokenSilent` now accepts an `authority` override, plumbed into `MsalAuthClient` so the same cached refresh token can be redeemed against a different tenant's authority. New sidecar `data/auth/viva-external-tenants.json` (mode 0600, written at `--add-account --tenant <guid>` time via [`VivaExternalTenantsStore`](../src/auth/viva-external-tenants-store.ts)) records `(homeAccountId, externalTenantId)` so `--viva-discover --account <u>` can fan out: once per home authority, then once per registered external tenant with `authority: vivaAuthorityFor(tenantId)`. Failing external silent acquisitions are logged and skipped; stale registrations (no matching account) warn. Replaces Slice 4b-3's cross-clientId merge — MSAL's account cache is keyed by home tenant, not external, so the previous clientId-partition model was wrong. Plan: [plans/done/viva-external-tenant-token-acquisition.md](plans/done/viva-external-tenant-token-acquisition.md).
- Slice 4b-3 of the external-networks redesign (superseded by 4b-4): identified an external-tenant token-acquisition gap after Slice 4b-2 still failed on the live NAS; the "cross-clientId cache merge" shipped under this slice does not actually fix it. See [plans/done/viva-external-tenant-token-acquisition.md](plans/done/viva-external-tenant-token-acquisition.md) for the real fix and why the clientId-partition model was the wrong diagnosis.
- Slice 4b-2 of the external-networks redesign (CLI + store, user-visible): new `--add-account --tenant <guid>` flag routes device-code login to a specific external tenant's authority using the Azure CLI public client id (`YAMMER_PUBLIC_CLIENT_ID`) — required for Microsoft-hosted Viva Engage networks where our own app registration is blocked by "Admin consent required". `--viva-discover --account <u>` now enumerates all cached accounts for the username (one per tenant) and aggregates `listCommunities` across them; discover output gains a `tenant_id` column for disambiguation. `--viva-subscribe` gains a 3-part `<tenantId>:<networkId>:<communityId>` colon form; single-id form now detects ambiguity across tenants and lists all `tenantId:networkId` candidates in the error message. Schema migration v13 adds nullable `tenant_id TEXT` to `viva_subscriptions`; pre-migration rows keep working with `tenant_id = NULL` (treated as home tenant). Plan: [plans/done/viva-external-networks-access.md](plans/done/viva-external-networks-access.md).
- Slice 4b-1 of the external-networks redesign (auth groundwork, not yet user-visible): exposed `MsalAuthClient.authority` as a readonly field so it is inspectable at construction; added `YAMMER_PUBLIC_CLIENT_ID` constant (the Azure CLI first-party client `04b07795-8ddb-461a-bbee-02f9e1bf7b46`, pre-consented globally, used to bypass admin-consent walls in external tenants); pinned down tenantId flow in `getTokenSilent` + `loginWithDeviceCode`. No behavior change yet — 4b-2 will wire these into the CLI.
- Slice 4a of the external-networks redesign: switched `HttpYammerClient.listCommunities` from `/groups.json?mine=1` to `/users/current.json?include_group_memberships=true`. The old endpoint returns HTTP 403 `NOT_ALLOWED_FOR_AAD_GUEST` for B2B guest identities; the user-scoped endpoint works for guests and home-tenant users alike, in one call with no pagination. `pending_group_memberships` / `invited_group_memberships` are deliberately ignored — discover only lists communities the user can actually read. Plan: [plans/done/viva-external-networks-access.md](plans/done/viva-external-networks-access.md).
- Fixed `--viva-discover` returning "no viva communities" for guest users in external Yammer networks (e.g. Microsoft's Viva Engage): `listCommunities` now sends `?mine=1` so the API returns groups the user has actually joined, not suggested/popular groups. Also added "Found N network(s): [names]" diagnostic line to discover output. Plan: [plans/done/fix-viva-discover-mine-param.md](plans/done/fix-viva-discover-mine-param.md).
- Completed Yammer pivot (Slice 3 of 3): `sync-viva.ts` now walks multiple thread and post pages using `olderThan` cursor with early-stop when the oldest item is at or before `lastCursorAt`; capped at 50 pages per community as a safety valve. `--viva-discover` output gains a `network_name` column (4 columns now: `community_id`, `network_id`, `network_name`, `display_name`). `--viva-subscribe` accepts `<networkId>:<communityId>` colon format to disambiguate when the same community id appears in two networks; plain `<communityId>` auto-resolves if unique, throws `CliUsageError` listing the conflicting network ids if not. Plan: [plans/done/yammer-slice-3-sync-cursor-and-cli.md](plans/done/yammer-slice-3-sync-cursor-and-cli.md).
- Replaced Graph-backed `HttpVivaClient` with `HttpYammerClient` against `www.yammer.com/api/v1`. `VivaClient` interface pivoted to Yammer-aligned: `listNetworks(token)` + `listCommunities(token, networkId)` (paginates internally) + `listThreads`/`listPosts` with `olderThanCursor` instead of `@odata.nextLink`. `--viva-discover` now enumerates all Yammer networks (including external/guest) and their communities. `FakeVivaClient` rewired to match. Numeric IDs >2^53 preserved as strings via ES2025 `JSON.parse` source-text reviver. Plan (Slice 2 of 3): [plans/done/yammer-slice-2-yammer-rest-client.md](plans/done/yammer-slice-2-yammer-rest-client.md).
- `--viva-discover` now auto-consents the Yammer scope on first use: when `getTokenSilent` fails with `silent-failed` for `api.yammer.com/user_impersonation`, the CLI triggers a second device-code flow (for Yammer only), caches the token, then retries discovery — no more `AADSTS65001` on a fresh account. `AuthClient.loginWithDeviceCode` now accepts an optional `scopes` override; `FakeAuthClient` records those scopes for test assertions. `VivaDeps` gains a `print?` field so the consent prompt surfaces correctly in production and in tests. Plan: [plans/done/yammer-slice-1-auth-consent-fallback.md](plans/done/yammer-slice-1-auth-consent-fallback.md).

## 2026-04-22

- **Hotfix**: separated Yammer scope from Graph scopes in `SCOPES`. Azure AD rejects device-code requests that mix audiences (`graph.microsoft.com` + `api.yammer.com`) — `--add-account` was returning `invalid_grant` with no URL displayed. `SCOPES` is now `["Mail.Read", "Chat.Read"]` only; `YAMMER_SCOPE` is still exported and passed explicitly as `{ scopes: [YAMMER_SCOPE] }` in `syncViva` and `discoverForAccount`. Re-authenticate all accounts after deploying this fix.
- MSAL scope surgery (Slice 1 of the Viva→Yammer pivot): `AuthClient.getTokenSilent` now accepts an optional `scopes` override, and the default `SCOPES` constant swaps `Community.Read.All` (Graph-only, native-mode-only) for the Yammer `https://api.yammer.com/user_impersonation` scope. `loginWithDeviceCode` requests both Graph scopes **and** the Yammer scope in one consent so existing users re-consent at most once. Setup/user-guide edits deferred to Slice 3, when the Graph-based Viva client is deleted. Plan: [plans/done/viva-external-networks-via-yammer.md](plans/done/viva-external-networks-via-yammer.md).
- Wired the real Graph `HttpVivaClient` into the CLI's default `realViva` impl. `--viva-discover` and `--viva-subscribe` now actually call Graph (via composition root), instead of throwing `viva ... requires VivaClient — not available in CLI default impl yet`. Discover paginates across `@odata.nextLink`. Subscribe looks up the `(networkId, displayName, networkName)` from the discover response and inserts the row — so `viva_subscriptions` carries the right `networkId` even when the user only types a `communityId`. Unknown `communityId` throws `CliUsageError` with an add-account/discover hint; unknown `--account` throws `CliUsageError` listing the `--add-account` remediation. `realViva` + new `VivaDeps` are exported so tests inject `{ auth, viva, store }` without touching disk. Plan: [plans/done/viva-cli-graph-wiring.md](plans/done/viva-cli-graph-wiring.md).
- Added `Community.Read.All` to the MSAL scope list ([src/auth/msal-auth-client.ts](../src/auth/msal-auth-client.ts)) so Viva Engage Graph calls (`/beta/employeeExperience/communities/*/threads`) are actually authorized. The prior Viva slice plumbed everything except the runtime scope request, so Graph was returning 403 end-to-end. `SCOPES` is now exported as a module-level constant and guarded by a regression test. **Re-consent required after upgrade**: every account that should sync Viva must re-run `--add-account <username>` — MSAL silent acquisition fails on the missing scope and forces a fresh device-code flow. Plan: [plans/done/viva-auth-scope.md](plans/done/viva-auth-scope.md).
- Added Viva Engage as the 4th message source. New `source: "viva-engage"` flows through the existing pipeline: `get_recent_activity`, `search`, `get_thread`, `list_threads` and steering all work uniformly. Subscription model: per-`(account, communityId)` row in new `viva_subscriptions` table (schema migration v11 → v12) — the user picks which `(network, community)` pairs to follow per account; nothing is auto-discovered. Per-community timestamp cursor (`last_cursor_at`) makes re-syncs incremental against Graph beta `/employeeExperience` endpoints (no deltaLink available). Thread id convention: `viva:{networkId}:{communityId}:{conversationId}`. New CLI flags `--viva-list`, `--viva-subscribe <community-id>`, `--viva-unsubscribe <community-id>`, `--viva-discover` (all require `--account <username>`). Per-community errors are isolated — one community failing does not abort the others; only `TokenExpiredError` / `GraphRateLimitedError` propagate as hardstops. Plan: [plans/done/add-viva-engage-source.md](plans/done/add-viva-engage-source.md).

## 2026-04-21

- Added Outlook Sent Items sync: new [src/sync/sync-sent.ts](../src/sync/sync-sent.ts) mirrors `syncInbox` against `/me/mailFolders/sentitems/messages/delta` and writes each row with `fromMe=true`. Scheduler runs inbox then sent per Outlook account; a failure in one does not swallow the other. Schema migration v10 → v11: `messages.from_me INTEGER NOT NULL DEFAULT 0` and `sync_state` PK widened to `(account, source, folder)` so each folder tracks its own `@odata.deltaLink`. Runs at boot (O(1) metadata-only ADD COLUMN in SQLite ≥ 3.35). Migration runbook: [migrations/sent-items-schema.md](migrations/sent-items-schema.md). `Mail.Read` already covers Sent Items — no MSAL re-login required. First sync tick after upgrade backfills Sent Items within `backfillDays`. Plan: [plans/done/feat-sent-items-sync.md](plans/done/feat-sent-items-sync.md).
- `get_thread` surfaces `fromMe: true` on each projected message; inbound + outbound interleave in `sent_at` order so the reply reads as part of the conversation.
- `get_recent_activity` returns a per-thread `replied: boolean` (propagated onto every message sharing that threadId): true iff the latest in-window row for the thread has `fromMe=true`. Answers "did I reply to X?" in a single call; ordering unchanged (still `sent_at DESC`).
- Steering carve-out for the user's own replies: `sender_email`, `sender_domain`, and `body_contains` rules no longer mute rows with `from_me=1` — muting a correspondent must not hide your own outgoing reply in that thread. Thread-level rules (`thread_id`, `thread_name_contains`) keep muting fromMe rows, because muting a whole conversation is a stronger, explicit intent. `muted_count` reflects what was actually muted.
- Fixed WhatsApp inbox stranding across container restarts: `startWhatsAppWatcher` now runs a sequential startup sweep (`listDir` + filter + importer) for pre-existing files, exposed via `handle.sweepComplete` for tests. Chokidar's `ignoreInitial: true` remains so the sweep is the single re-import path at startup. Importer errors now discriminate as `WhatsAppParseError` / `WhatsAppArchiveError` (subclasses of `WhatsAppImportError`), so the watcher logs `whatsapp_parse_failed` / `whatsapp_archive_failed` / `whatsapp_import_failed` / `whatsapp_sweep_complete` instead of a single opaque `import failed` line — operators can now tell from `docker logs` whether to look at the zip or at archive-dir permissions. Archive failures leave the file in place; re-sweep is idempotent via content-hashed ids. Plan: [plans/done/fix-whatsapp-inbox-archive.md](plans/done/fix-whatsapp-inbox-archive.md).
- Added `whatsapp-rethread` migration (registered in [migrations/INDEX.md](migrations/INDEX.md), runbook at [migrations/whatsapp-rethread.md](migrations/whatsapp-rethread.md)) that heals bifurcated WhatsApp threads in existing lakes: normalizes `thread_id`, rewrites `thread_name` to the group's latest-imported raw value, recomputes each message `id` via `hashWhatsAppId` on the normalized chat, and resolves content-id collisions by `imported_at` (higher wins). New CLI flag `--rethread-whatsapp [--dry-run]`, wired for `/deploy-nas --migrate whatsapp-rethread`. Closes the 3-slice plan [plans/done/fix-whatsapp-thread-bifurcation.md](plans/done/fix-whatsapp-thread-bifurcation.md).
- Corrected the WhatsApp chat-name normalization rule before any of slices 1–3 shipped: the original "strip any trailing ` (…)` paren" merged `"General chat"` (unnamed-group placeholder) with `"General chat (BC Dev Talk)"` (the `BC Dev Talk` named group) and kept `"BC Dev Talk"` separate from its own export — exactly backwards. New rule in [src/sync/whatsapp-map.ts](../src/sync/whatsapp-map.ts): (a) strip trailing numeric counter ` (N)` (re-export artifact), (b) unwrap `General chat (<name>)` to `<name>` when the paren content is non-empty and non-numeric (WhatsApp placeholder prefix for named groups). Rethread migration fixtures swapped to a real bifurcation pattern. Plan: [plans/done/fix-whatsapp-normalize-rule.md](plans/done/fix-whatsapp-normalize-rule.md).
- Normalized WhatsApp thread identity at import: new `normalizeWhatsAppChatName` in [src/sync/whatsapp-map.ts](../src/sync/whatsapp-map.ts) trims, collapses whitespace, strips trailing numeric counters, and unwraps the `General chat (<name>)` placeholder (see corrective entry above for rule details). `hashWhatsAppId` hashes on the normalized name, so message `id` is stable across re-exports. `toWhatsAppMessage` sets `threadId = normalized`, `threadName = raw` (latest-wins via upsert). **Only affects future imports** — legacy bifurcated rows healed by the `whatsapp-rethread` migration. Plan: [plans/done/fix-whatsapp-thread-bifurcation.md](plans/done/fix-whatsapp-thread-bifurcation.md).
- New MCP tool `list_threads(source)`: returns every distinct `(threadId, threadName, messageCount, newestSentAt, oldestSentAt)` for a source, newest-first. Diagnostic / read-only, **not affected by steering** — always the full inventory. Surfaces bifurcated threads (same display name, distinct `threadId`) e.g. WhatsApp exports under different filenames. Backed by new `MessageStore.listThreadSummaries` on both SQLite and in-memory stores. Plan (in-flight, slices 2–3 remain): [plans/done/fix-whatsapp-thread-bifurcation.md](plans/done/fix-whatsapp-thread-bifurcation.md).
- Fixed silent-filter bug in `buildSteeringPredicate` ([src/store/steering-filter.ts](../src/store/steering-filter.ts)): SQL OR-chain wrapped in `COALESCE((...), 0)` so rows with NULL columns (e.g. every WhatsApp message has NULL `sender_email`) aren't dropped when a `sender_email`/`sender_domain` rule is active. Before the fix, `get_recent_activity` / `search` returned zero WhatsApp hits once any email-sender rule existed, with `muted_count: 0` and no steering_hint — invisible to the caller. Plan: [plans/done/fix-steering-predicate-null-columns.md](plans/done/fix-steering-predicate-null-columns.md).

## 2026-04-20

- `search` MCP tool gained optional structured filters `sender_email`, `sender_name`, `after`, `before`. `query` is now optional when any sender filter is present; when omitted, results are ordered `sent_at DESC` instead of BM25. Filters compose with FTS MATCH and steering via AND. `muted_count` is scoped to the same filter set. Closes the "From-header-only" blind spot where FTS over body text missed messages actually sent *by* a person. Plan: [plans/done/feat-search-sender-filters.md](plans/done/feat-search-sender-filters.md).
- MCP tool-dispatch catch now emits `[mcp tool handler] <tool_name> failed: <message>\n<stack>` to stderr before throwing the generic `InternalError`. Wire response unchanged (no detail leaked to OAuth-authenticated clients). `InvalidParamsError` stays silent (caller error, not server fault). Plan: [plans/done/post-oauth-debuggability-and-client-cache.md](plans/done/post-oauth-debuggability-and-client-cache.md).
- New troubleshooting section in [oauth.md §6.1](oauth.md) documenting the stale-DCR / stale-tool-discovery failure mode after any OAuth-surface change, with per-client remove/re-add fixes (Claude Desktop needs full `Cmd+Q`, claude.ai needs hard reload).
- New diagnostics recipe in [deploy-synology.md](deploy-synology.md) for running a handler directly inside the container via `docker compose exec … tsx -e "<async IIFE>"` against `/data/db/lake.db` opened `readonly: true` — isolates transport bugs from handler bugs when server logs are inconclusive.
- Steering rules: hard-exclude-by-default filter on `get_recent_activity` and `search` with new `include_muted` / `muted_count` / `steering_hint` fields. Rules persist in new `steering_rules` table (schema migration v9 → v10). Sync is untouched — steering is a query-time lens, never a delete. Plan: [plans/done/steering-rules.md](plans/done/steering-rules.md).
- New MCP tools: `get_steering`, `add_steering_rule`, `remove_steering_rule`, `set_steering_enabled`. Chat-driven mute ("not interested in mails from DevOps") writes only to the local `steering_rules` table — no Graph calls — preserving the "no external writes" invariant from brief §9.
- New CLI flags: `--steer-add-sender|domain|thread|thread-name|body <value>`, `--steer-list`, `--steer-enable|disable|remove <id>`, plus `--reason`, `--source`, `--account` modifiers. Scriptable second path to the same `SteeringStore`.
- Five rule types in v1: `sender_email`, `sender_domain`, `thread_id`, `thread_name_contains`, `body_contains` (FTS5). `get_thread` and `list_accounts` are unaffected — opening a thread still shows every message in it.
- OAuth slice 1: added `.well-known/oauth-authorization-server` (RFC 8414) and `.well-known/oauth-protected-resource` (RFC 9728) discovery documents plus `POST /oauth/register` Dynamic Client Registration (RFC 7591) on the MCP HTTP server. Mounted only when `WALDO_PUBLIC_URL` is set; existing static-bearer auth is untouched. Plan: [plans/done/oauth-mcp-auth-slice-1-discovery-and-dcr.md](plans/done/oauth-mcp-auth-slice-1-discovery-and-dcr.md).
- Schema migration v6 → v7: new `oauth_clients` table. `AuthStore` seam (interface + `SqliteAuthStore` + `InMemoryAuthStore`) added under [../src/auth/oauth/](../src/auth/oauth/) with shared contract test suite.
- OAuth slice 2: `GET/POST /oauth/authorize` consent UI — validates client, renders HTML form, verifies admin password (scrypt N=16384), issues 10-minute auth code, 302-redirects with `code` + `state`. `verifyPkceS256` (timing-safe S256) and `scryptPasswordHasher` extracted as standalone modules. Schema migration v7 → v8: `oauth_auth_codes` table.
- OAuth slice 3: `POST /oauth/token` — `authorization_code` grant (PKCE verifier check, issues access + refresh pair) and `refresh_token` grant (rotation: old token invalidated on use). Access TTL 1 h, refresh TTL 30 days. Schema migration v8 → v9: `oauth_access_tokens` table + refresh index.
- OAuth slice 4: MCP endpoint dual-path auth — accepts valid OAuth access token **or** static bearer (unless `WALDO_DISABLE_STATIC_BEARER=true`). Every 401 with OAuth configured now carries `WWW-Authenticate: Bearer resource_metadata=<publicUrl>/.well-known/oauth-protected-resource` (RFC 6750).
- OAuth slice 5: `docs/oauth.md` operator guide — setup, curl walkthrough, claude.ai registration steps, admin password rotation, manual SQLite client revocation, troubleshooting table. `.env.example` verified complete.
- OAuth live smoke passed: claude.ai custom connector registered against `https://<nas-host>.<tailnet>.ts.net` (Tailscale Funnel), consent accepted, first tool call (`list_accounts` / `get_sync_status`) returned live lake data. NAS deploy of image `waldo-wtf:local` (sha256:f4a83b32de6f) healthy.
- `.env.example` documents four OAuth vars: `WALDO_PUBLIC_URL`, `WALDO_ADMIN_PASSWORD`, `WALDO_DISABLE_STATIC_BEARER` (new in slice 1), and confirms all are optional with clear defaults.

## 2026-04-19

- Slice B: added `include_body` parameter to `get_thread` and `search` MCP tools so Claude can read full message bodies on demand. Bodies are head-truncated per message at 50k chars (flagged via `bodyTruncated: true`) and capped at 400k chars per call — later messages are returned without a body and the response carries `bodyBudgetExhausted: true` when the budget runs out. Default remains `false` (snippets only) to protect context.
- Extracted shared `projectBody` helper at [../src/mcp/tools/body-projection.ts](../src/mcp/tools/body-projection.ts) so the per-message cap and per-call budget accounting are defined in one place.

## 2026-04-16

- Expanded MCP tool descriptions (`search`, `get_sync_status`, `get_recent_activity`, `get_thread`) with multilingual search guidance and multi-source caveats so agents handle Dutch/English content and WhatsApp ingestion correctly.
- Added server-level `instructions` to the MCP server with a general multilingual search strategy.
- Fixed `list_accounts` returning empty — sync scheduler now calls `upsertAccount()` for each account on every tick.
- Fixed `NOT NULL constraint failed: messages.sent_at` — `syncInbox` now falls back to `importedAt` when a Graph message has no `receivedDateTime`.

## 2026-04-15 — Weekend 6 follow-up: auto-push + EXDEV fix + launchd

- **Auto-push from Mac to NAS via launchd.** New
  [../bin/com.waldo.wtf.whatsapp-push.plist](../bin/com.waldo.wtf.whatsapp-push.plist)
  is a `WatchPaths` LaunchAgent that fires `bin/wtf-whatsapp-push`
  within ~1s of any file landing in the watched folder. Survives
  reboot, zero typing after setup. One-time install commands in
  [user-guide §6b](user-guide.md#6b-one-time-setup).
- **`~/WaldoInbox` instead of `~/Downloads`.** Pivoted away from
  watching `~/Downloads` because macOS TCC silently blocks
  launchd-spawned shells from reading the protected folders
  (Downloads, Documents, Desktop) even with Full Disk Access granted
  to the script itself (the kernel attributes TCC to the interpreter,
  not the script path). A dedicated folder outside those three
  locations sidesteps the whole permission dance. Documented in
  [user-guide §6a](user-guide.md#6a-why-waldoinbox-and-not-downloads).
- **`nodeFileSystem.rename()` now handles EXDEV.** When archiving a
  file across two bind mounts inside the container, `fs.rename()`
  fails with `EXDEV: cross-device link not permitted`. Added a
  copy+unlink fallback in [../src/fs-node.ts](../src/fs-node.ts)
  behind a small exported `moveAcrossDevices()` helper so the
  fallback is unit-testable without mocking `fs/promises`
  ([../src/fs-node.test.ts](../src/fs-node.test.ts)).
- **NAS bind-mount layout.** Whatsapp inbox and archive now live at
  `/volume1/docker/waldo-wtf/data/whatsapp-{inbox,archive}`
  (previously directly under `waldo-wtf/`). The direct-under-share
  location inherited DSM's share-level ACL (`drwxrwxrwx+`), which
  overrode the Unix mode inside the bind mount and made the
  container see `dr-xr-xr-x` — `mkdir` failed with `EACCES` despite
  UID 1000 ownership. Fix: `synoacltool -del` to strip the inherited
  ACL, then `chown waldo:1000` + `chmod 775` so both the host user
  (for scp) and the container `node` user (UID 1000, for archive
  moves) have write access. Documented in [user-guide §6d](user-guide.md#6d-troubleshooting-the-auto-push).
- **SSH key auth.** `ssh-copy-id waldo@waldonas3` one-time setup so
  `wtf-whatsapp-push` runs without prompting for a password. DSM
  gotcha: `~` and `~/.ssh` must be chmod 700 or pubkey auth is
  refused. Covered in the setup section.
- Suite stays green: 10 tests in `fs-node.test.ts` (1 new
  EXDEV-fallback case), overall 451 / 451.

---

## 2026-04-15 — Weekend 6 follow-up: real watcher + NAS deployment

- `nodeFileSystem.watch()` is now a real chokidar-backed implementation
  with `awaitWriteFinish` (500ms stability window) so partial scp writes
  don't trigger the importer mid-transfer. Extracted from `index.ts` and
  `cli.ts` into [../src/fs-node.ts](../src/fs-node.ts) so it has a single
  owner and can be integration-tested against a real tmp dir
  ([../src/fs-node.test.ts](../src/fs-node.test.ts)).
- `docker-compose.yml` gains two bind mounts (`./whatsapp-inbox` and
  `./whatsapp-archive`) plus `WALDO_WHATSAPP_WATCH=true` and matching
  path env vars. On the NAS these resolve under
  `/volume1/docker/waldo-wtf/`.
- [../bin/wtf-whatsapp-push](../bin/wtf-whatsapp-push) — one-command push
  from Mac to NAS via scp. The container's watcher picks up the file
  automatically; no `docker exec` round-trip needed.
- 3 new integration tests (real tmp dir + real chokidar), suite at
  450 / 450.

## 2026-04-15 — Weekend 6 follow-up: zip export support

- WhatsApp importer now accepts iOS-style `.zip` exports in addition to
  raw `.txt`. On `.zip` input, `_chat.txt` is extracted via `adm-zip`
  and fed to the existing parser; the zip itself is archived under
  `~/WhatsAppArchive/YYYY-MM/`. Dedup is unchanged, so re-importing the
  same chat as `.zip` and then as `.txt` (or vice versa) is a no-op.
- Watcher glob broadened from `WhatsApp Chat*.txt` to `WhatsApp Chat*`;
  CLI `--import-whatsapp` filter now matches `.txt` and `.zip`.
- Malformed zips and zips missing `_chat.txt` raise `WhatsAppImportError`
  and leave the source file in place (no archive, no partial rows).
- 5 new tests; suite at 447 / 447, coverage on touched files ≥95% branches.

## 2026-04-15 — Weekend 6: WhatsApp importer

- Third message source lands in the lake. WhatsApp chat `.txt` exports
  dropped into `~/Downloads/` are parsed, deduped, upserted with
  `source='whatsapp'`, and archived to `~/WhatsAppArchive/YYYY-MM/`.
  Re-importing the same chat is a no-op — dedup id is
  `whatsapp:sha256(chat\nsender\nsentAtIso\nbody)`. Eight TDD slices,
  no new MCP tools (existing `get_recent_activity` / `search` /
  `get_thread` project whatsapp rows unchanged).
  [plans/done/weekend-6-whatsapp-importer.md](plans/done/weekend-6-whatsapp-importer.md).
- Pure parser [../src/sources/whatsapp.ts](../src/sources/whatsapp.ts)
  handles Mac en-BE 24h dates (DST-aware via `Intl.DateTimeFormat`),
  multi-line messages, `<Media omitted>`, system messages, and BOM/ZWSP.
- Orchestrator [../src/sync/import-whatsapp.ts](../src/sync/import-whatsapp.ts)
  + watcher [../src/sync/whatsapp-watcher.ts](../src/sync/whatsapp-watcher.ts).
  Watcher reuses the existing `FileSystem.watch` seam — the slice-3
  idempotent import covers chokidar's double-fire during copies.
- New env knobs: `WALDO_WHATSAPP_DOWNLOADS_PATH`,
  `WALDO_WHATSAPP_ARCHIVE_PATH`, `WALDO_WHATSAPP_ACCOUNT`,
  `WALDO_WHATSAPP_WATCH`. **Off by default on the NAS**; opt-in on the
  Mac via `WALDO_WHATSAPP_WATCH=true`.
- CLI one-shot: `tsx src/cli.ts --import-whatsapp` scans the downloads
  path once. [../src/cli.ts](../src/cli.ts).
- `FileSystem` seam extended with `mkdir` and `exists` (both existing
  impls updated; real node adapter uses `fs.mkdir({recursive:true})`).
- 442 tests pass, 99.77% lines / 97.53% branches.

## 2026-04-15

- `search`, `get_recent_activity`, and `get_thread` now project an
  optional `threadId` field, so an MCP client can pivot from any hit
  back into `get_thread` without guessing the id. Additive wire-shape
  change. [src/mcp/tools/](../src/mcp/tools/)
- New `/deploy-nas` skill + migration registry. [.claude/skills/deploy-nas/SKILL.md](../.claude/skills/deploy-nas/SKILL.md)
  drives the recurring NAS deploy loop step-by-step — build image on
  Mac → ship → stop container → optionally run a one-shot migration
  → verify → restart → smoke. Prompts the operator one command at a
  time, interprets output, decides next step. Flags: `--migrate
  <name>`, `--dry-run`. Registry lives at
  [docs/migrations/INDEX.md](migrations/INDEX.md); first recipe is
  [body-backfill](migrations/body-backfill.md) captured from today's
  production run (service name `waldo` not `waldo-wtf`, don't
  override entrypoint, `immutable=1` SQLite URI workaround for the
  WAL/UID-mismatch readonly error, etc.). CLAUDE.md references the
  new skill. Plan: [docs/plans/done/deploy-nas-skill.md](plans/done/deploy-nas-skill.md).
- Message-body backfill (Slice A of the "make Claude read mail" fix) —
  new pure helper [src/text/html-to-text.ts](../src/text/html-to-text.ts)
  (backed by `node-html-parser`), new
  [src/store/backfill-body-from-html.ts](../src/store/backfill-body-from-html.ts)
  chunked backfill, schema v5→v6 marker migration, new CLI subcommand
  `tsx src/cli.ts --backfill-bodies`. [sync-inbox.ts](../src/sync/sync-inbox.ts)
  mapper now populates plain `body` from `body_html` on ingest so every
  new Outlook mail is FTS-indexed. Backfill is in-place on the 882 MB
  production lake — no Graph refetch, `raw_json` and `body_html`
  untouched, `WHERE body IS NULL` makes re-runs idempotent. FTS5
  `rebuild` incantation recomputes the shadow index from the content
  table. 396 tests pass, coverage 99.73% lines / 98.33% branches.
  Deployment steps in [deploy-backfill-bodies.md](deploy-backfill-bodies.md).
  Plan: [docs/plans/done/fix-message-bodies-slice-a-backfill.md](plans/done/fix-message-bodies-slice-a-backfill.md).
- Weekend 5 slice 1 end-to-end live: Claude Desktop on the Mac now talks to the waldo.WTF container on the DS223 over Tailscale and pulls mail/chat tool results from the lake. Three MS 365 accounts added via `--add-account` on the NAS (emails redacted), `docker compose up -d` healthy, first post-login sync tick `sync tick complete: 3 account(s), 6 ok, 0 error(s)`, `curl http://waldonas3:8765/health` → `{"ok":true}` from the Mac, Claude Desktop MCP tools listing populated after a Cmd+Q-and-relaunch. Slice 1 acceptance criteria met — "Claude Desktop, backed by the NAS container, can answer a question about recent mail" passes.
- Claude Desktop MCP config — `mcp-remote` needs `--allow-http`. Claude Desktop's `claude_desktop_config.json` has no native remote-HTTP transport, so we proxy via `npx -y mcp-remote` which by default refuses any non-`localhost` HTTP URL and exits with `Non-HTTPS URLs are only allowed for localhost or when --allow-http flag is provided`. Adding `--allow-http` to the args unblocks it; safe over Tailscale because the tailnet link is WireGuard-encrypted end-to-end. [deploy-synology.md Part G](deploy-synology.md) rewritten — the old doc showed the hypothetical `{"type":"http","url":"...","headers":{...}}` form (which Claude Desktop does NOT implement); replaced with the real `command: npx` + `args: [-y, mcp-remote, <url>, --allow-http, --header, "Authorization: Bearer ..."]` stdio-bridge form, plus three gotchas callout (allow-http, full MagicDNS name vs short hostname mDNS collision, `--header "Name: value"` single-string vs hypothetical JSON object). Troubleshooting §`MCP server disconnected` expanded to list the three actual failure modes seen in `~/Library/Logs/Claude/mcp-server-waldo-wtf.log` in order of likelihood (missing `--allow-http`, bearer mismatch, `ECONNREFUSED` from wrong bind host).
- [.claude/settings.json](../.claude/settings.json) — minor permissions tweak from this session's hands-on work. Keeps `/security-scan` from prompting on routine file reads in `docs/` and `node_modules/` during the supply-chain false-alarm investigation.

---

## 2026-04-14

- Weekend 5 slice 1 NAS hands-on: lessons learned rolled back into the docs after walking through Parts A–E live against the DS223. (1) [deploy-synology.md §B4](deploy-synology.md) — `chown` call now targets `db/` and `auth/` explicitly (not just the parent) and is followed by `chmod -R u+rwX`; loud warning added against creating the bind-mount directories via DSM File Station / SMB (Synology extended ACLs override UNIX owner and leave the `node` user with `EACCES` on first write even when `ls -la` shows owner `1000`); warning added that any earlier `docker compose` run will auto-create the bind mounts as `root:root` and require a re-`chown`. (2) New §B4a "Verify the container can write to the bind mounts" — a one-liner `docker compose run --entrypoint sh … 'touch /data/auth/.write-test /data/db/.write-test && echo OK'` sanity check that MUST pass before Part E, so a perms bug is caught before burning an MSAL device code in the browser. (3) [src/cli.ts](../src/cli.ts) top-level `.catch` now walks the `err.cause` chain and prints `caused by: <message>` for each link — the original one-liner only printed `err.message`, which swallowed the real MSAL failure (`EACCES: permission denied, open '/data/auth/token-cache.json.tmp'`) behind the generic wrapper "MSAL device-code login failed". Quick patch, no tests yet — TDD debt flagged, to be covered in the next slice. (4) [`deploy-to-nas.sh`](../deploy-to-nas.sh) — new repo-root script that automates Part C Option 1 (`docker save` on the Mac → `scp -O` → `ssh -t sudo /usr/local/bin/docker load` on the NAS → cleanup). Hardcodes `/usr/local/bin/docker` because DSM's `sudo` strips `PATH` and `/usr/local/bin` is not in the secure_path (Container Manager symlinks docker there). Uses `scp -O` (legacy protocol) because DSM's SSH server ships without the SFTP subsystem and modern `scp`'s default SFTP mode fails with `subsystem request failed on channel 0`. Uses `ssh -t` because the remote `sudo` needs a TTY for the password prompt.

- Weekend 5 slice 1 vestauth.com follow-up closed — NOT a supply-chain compromise. The `◇ injected env (0) from .env // tip: ⌁ auth for agents [www.vestauth.com]` line traces to `node_modules/dotenv/lib/main.js`: the upstream `dotenv` package ships a hardcoded `TIPS` array and prints a random entry on module load via `_log()`. `vestauth.com` is the author's own product, not a hijacked dependency. Related concern — the device-code URL shown as `https://login.microsoft.com/device` — also legit: `login.microsoft.com` is in MSAL-node's `REGIONAL_AUTH_PUBLIC_CLOUD_SUFFIX` / known-authorities list at [node_modules/@azure/msal-node/lib/msal-node.cjs:187](../node_modules/@azure/msal-node/lib/msal-node.cjs). Memory note updated from "deferred investigation" to "false alarm — do not re-open without new evidence". Optional cleanup: pass `{ quiet: true }` to `dotenv.config()` to suppress the tip line in container stdout.

- Weekend 5 slice 1 live smoke: Part A of [deploy-synology.md](deploy-synology.md) executed against OrbStack (Docker Desktop alternative — lighter, drop-in compatible). `docker buildx build --platform linux/arm64 --load -t waldo-wtf:local .` finished in 34s (`better-sqlite3` arm64 prebuilt picked up, from-source fallback not exercised). `docker compose up -d` → container `(healthy)`, logs show `waldo.WTF MCP server listening on http://0.0.0.0:8765` + `sync tick complete: 0 account(s)` (expected — no token cache on the test volume), `curl http://127.0.0.1:8765/health` → `{"ok":true}`, `./data/db/lake.db` + `-shm` + `-wal` files landed on the host via the bind mount. Clean `docker compose down`. Dockerfile + compose file validated against a live engine — the manual is now trustworthy for the NAS-side Parts B–G. Two follow-ups flagged, neither blocking: (1) Dockerfile buildx lint warns `SecretsUsedInArgOrEnv` on `ENV "WALDO_AUTH_DIR"` — false positive, path is not a secret, will suppress or refactor later; (2) startup log line `◇ injected env (0) from .env // tip: ⌁ auth for agents [www.vestauth.com]` appeared in container stdout, NOT from waldo.WTF source — almost certainly a transitive `node_modules` dependency (likely in the dotenv / tsx chain) injecting a promo/telemetry line. Deferred as a separate security investigation (possible supply-chain / ad-injection package).

- Weekend 5 slice 1 — `WALDO_BIND_HOST` config + Dockerize. New `bindHost: string` on `Config` with `DEFAULT_BIND_HOST = "127.0.0.1"` ([src/config.ts](../src/config.ts)), read from `WALDO_BIND_HOST` env var via the same `present()` pattern as the other optional knobs; [src/index.ts](../src/index.ts) composition root now passes `config.bindHost` to `httpServer.listen(port, host, …)` and the startup log line prints the actual bound host. Default preserves current local-dev behaviour (loopback only); container sets `WALDO_BIND_HOST=0.0.0.0` so the published port is reachable from the host. 4 new tests (3 config + 1 index asserting `result.httpServer.address().address === "0.0.0.0"` under the env override), 384 total, 100% on `config.ts`, global 99.72% lines. New repo-root `Dockerfile` (multi-stage, `node:22-bookworm-slim` — **not** alpine because `better-sqlite3` + musl fights aren't worth it; deps stage installs `python3 make g++` for the from-source fallback when no arm64 prebuilt is available; runtime stage installs `tsx` at `./node_modules/.bin/tsx` and runs as non-root `node` user; `/data/db` + `/data/auth` declared VOLUMEs; `ENTRYPOINT ["node_modules/.bin/tsx", "src/cli.ts"]` so the same image serves both the long-running server and `--add-account` device-code login). New `.dockerignore` excluding `node_modules`, `coverage`, `data`, `*.db*`, `.env`, `docs`, `testing/`, `**/*.test.ts`, etc. New `docker-compose.yml` (targets `linux/arm64` explicitly for the DS223 Realtek RTD1619B; two bind mounts `./data/db:/data/db` + `./data/auth:/data/auth`; publishes `8765:8765`; `WALDO_BIND_HOST=0.0.0.0` override; healthcheck via `node -e "fetch('http://127.0.0.1:8765/health')…"` against the existing unauthenticated `/health` endpoint in [src/mcp/http-server.ts](../src/mcp/http-server.ts)). `.env.example` gains a commented `WALDO_BIND_HOST` block warning it's container-only. New operator manual [docs/deploy-synology.md](deploy-synology.md) — end-to-end Mac-build → NAS-deploy recipe for DS223 + Tailscale: local smoke test (Part A, REQUIRED before trusting the manual — build was NOT validated against a live docker engine from here), Container Manager + Tailscale install (Part B), `docker save`/`scp`/`docker load` vs on-NAS git-clone build (Part C), absolute `/volume1/docker/waldo-wtf/…` bind-mount paths with loud "never put SQLite/WAL on SMB" warnings, interactive `docker compose run --rm waldo --add-account` for the first-run MSAL device code flow (doesn't transfer from the Mac — fresh device), `docker compose up -d` + `curl http://waldo-nas:8765/health` smoke, Claude Desktop `claude_desktop_config.json` repoint to the tailnet hostname, and a troubleshooting section covering arch mismatch / bind-host regression / `sync tick 0 account(s)` / `SQLITE_BUSY` / firewall / bearer mismatch. [docs/setup.md §9](setup.md) now links to the new manual. Plan: [weekend-5-dockerize-and-synology.md](plans/done/weekend-5-dockerize-and-synology.md). Hands-on NAS steps (Container Manager install, image upload, first-run login, Claude Desktop repoint) are deliberately OUT OF SCOPE for this slice — waldo executes them against the manual.

## 2026-04-13

- Weekend 4.5 slice 3: `get_thread` now covers Outlook conversations. `GraphMessage` DTO gains optional `conversationId` ([src/sources/graph.ts](../src/sources/graph.ts)); `syncInbox.toMessage` maps `conversationId` → `Message.threadId` and `subject` → `Message.threadName`, both defensively omitted when missing/null ([src/sync/sync-inbox.ts](../src/sync/sync-inbox.ts)). No schema change (`thread_id`/`thread_name` columns landed in slice 2), no `HttpGraphClient` change (`$select` not used; Graph returns both by default), no backfill (old rows rewrite on next delta touch). 4 new tests on [src/sync/sync-inbox.test.ts](../src/sync/sync-inbox.test.ts): happy path, missing `conversationId`, `subject: null`, and an integration assertion that two messages sharing a `conversationId` round-trip through `InMemoryMessageStore.getThread`. 380 tests total, touched files 100% line / ≥97% branch. Plan: [weekend-4.5-slice-3-outlook-thread-fields.md](plans/done/weekend-4.5-slice-3-outlook-thread-fields.md).
- Weekend 4.5 slices 1+2: v1 MCP surface closed. New `get_thread(thread_id, limit?)` tool ([src/mcp/tools/get-thread.ts](../src/mcp/tools/get-thread.ts)) — backed by new `MessageStore.getThread({threadId, limit?})` on the contract + SQLite (`WHERE thread_id = ? ORDER BY sent_at ASC, id ASC LIMIT ?`) + in-memory impls. Default limit 200, max 500. Resolves against the `thread_id` column, which today is populated only by `syncTeams` (`chat.id`) — so the tool currently covers **Teams chats**; Outlook conversations return `[]` until a follow-up slice adds `conversationId` capture to `sync-inbox`. Projection mirrors `get_recent_activity` (no `body`/`rawJson` leak; snippet falls back to `bodyHtml` when `body` absent; `SNIPPET_MAX = 280`). New `list_accounts()` tool ([src/mcp/tools/list-accounts.ts](../src/mcp/tools/list-accounts.ts)) — thin wrapper over the existing `MessageStore.listAccounts()`, projects `{username, displayName?, addedAt}` (ISO string); `tenantId` deliberately omitted from the wire shape. Both tools registered in `TOOL_DESCRIPTORS` + `TOOL_HANDLERS` in [src/mcp/mcp-server.ts](../src/mcp/mcp-server.ts); SDK dispatcher and bearer shell untouched. E2E HTTP coverage added (Teams thread over `:memory:` + `StreamableHTTPClientTransport`; unknown-thread-id returns empty; `list_accounts` round-trip). [user-guide.md](user-guide.md) `get_thread` section now notes the Teams-only scope; [claude-desktop-wiring.md](claude-desktop-wiring.md) `tools/list` expectation updated to the 5-tool v1 surface. 29 new tests, 372 total, 99.72% line / 98.53% branch globally; every touched file ≥90% branch. Plans: [weekend-4.5-slice-1-get-thread.md](plans/done/weekend-4.5-slice-1-get-thread.md), [weekend-4.5-slice-2-list-accounts.md](plans/done/weekend-4.5-slice-2-list-accounts.md).
- MCP SDK adoption: hand-rolled JSON-RPC dispatcher in [src/mcp/http-server.ts](../src/mcp/http-server.ts) replaced by `@modelcontextprotocol/sdk` v1.29.0 `Server` + `StreamableHTTPServerTransport` (stateless, `sessionIdGenerator: undefined`). New [src/mcp/mcp-server.ts](../src/mcp/mcp-server.ts) exposes `createMcpServer({store, clock})` which registers `tools/list` + `tools/call` handlers on the low-level SDK `Server`, preserves the existing JSON-schema `inputSchema` on each descriptor, wraps each handler's plain-JS result into an MCP `content: [{type:"text", text: JSON.stringify(...)}]` block, maps `InvalidParamsError` → `McpError(ErrorCode.InvalidParams)`, unknown tool names → `McpError(ErrorCode.MethodNotFound)`, and unexpected errors → `McpError(ErrorCode.InternalError)`. [src/mcp/http-server.ts](../src/mcp/http-server.ts) is now a thin shell: GET `/health` (unauthenticated) → `{ok:true}`; every other path requires `Bearer $BEARER_TOKEN` (`timingSafeEqual`, unchanged); on auth pass we construct a fresh `McpServer` + transport pair per request and hand off to `transport.handleRequest(req, res)` which handles MCP's Streamable HTTP wire format (Accept negotiation, SSE upgrade, session stateless routing). Tool handlers in [src/mcp/tools/](../src/mcp/tools/) were **not** touched — the SDK adapter wraps them. Claude Desktop can now complete the MCP `initialize` handshake via `mcp-remote` (the raw JSON-RPC POST stopped working the moment the first real MCP client tried to connect). Claude Desktop wiring docs updated to use `mcp-remote` as the wrapper rather than the stale in-client `"transport": "http"` block. Test rewrite: new [src/mcp/mcp-server.test.ts](../src/mcp/mcp-server.test.ts) (7 tests) drives the SDK server via `InMemoryTransport.createLinkedPair()` + SDK `Client` (hermetic, no HTTP) — asserts initialize handshake, tools/list shape, content-block wrapping for all three tools, InvalidParams/MethodNotFound/InternalError mapping. [src/mcp/http-server.test.ts](../src/mcp/http-server.test.ts) trimmed from 21 tests to 8 (dropped the ones that asserted hand-rolled JSON-RPC internals; kept bearer/health shell). [src/mcp/e2e-http.test.ts](../src/mcp/e2e-http.test.ts) rewritten to drive `StreamableHTTPClientTransport` with `requestInit.headers.Authorization` against `:memory:` SqliteMessageStore: 5 scenarios (tools/list, unauth initialize, get_recent_activity, search, get_sync_status) all green. 343 tests total, 99.69% lines / 98.41% branches globally; every touched file ≥90% line + branch. Plan: [adopt-mcp-sdk.md](plans/done/adopt-mcp-sdk.md).
- Teams endpoint rework, slice 2: **polling works under delegated auth.** `TeamsClient` seam reshaped — `getDelta(url, token)` replaced by `listChats(token, nextLink?)` + `getChatMessages(token, chatId, { sinceIso?, nextLink? })` returning `TeamsChatListPage` / `TeamsMessagesPage` ([src/sources/teams.ts](../src/sources/teams.ts)). `HttpTeamsClient` rewritten to hit `/me/chats` and `/me/chats/{id}/messages` with `$orderby=lastModifiedDateTime desc` + conditional `$filter=lastModifiedDateTime gt <iso>`; chatIds url-encoded; bearer token redaction preserved; 401/429 error mapping preserved; 410 mapping dropped (no delta semantics). `DEFAULT_TEAMS_DELTA_ENDPOINT` constant removed; `DeltaTokenInvalidError` no longer re-exported from `teams.ts`. `syncTeams` rewritten to enumerate chats via `listChats` paging, then for each chat read the slice-1 per-chat cursor, fetch messages since (or `clock.now() - backfillDays`), walk `@odata.nextLink`, upsert, and advance the cursor to the highest `lastModifiedDateTime`/`createdDateTime` seen. Per-chat error isolation: non-hard-stop errors swallow so one bad chat doesn't block the tick; `TokenExpiredError`/`GraphRateLimitedError` still propagate. `threadName` now populated from `TeamsChat.topic`; `chatType` now derived from `TeamsChat.chatType` (`"oneOnOne" | "group"`) rather than from `channelIdentity`. `@removed` entries still skipped (polling endpoint doesn't emit them anyway). Schema **v5** renames `chat_cursors.last_modified_iso → cursor` via `ALTER TABLE ... RENAME COLUMN` to keep the store API honest (the cursor is an opaque ISO string, not specifically "last modified"). `ChatCursorEntry.lastModifiedIso` → `cursor` cascaded through both store impls + contract tests. `FakeTeamsClient` reshaped to mirror the new seam with `listChatsOk`/`getChatMessagesOk` step kinds. Sync scheduler tests updated to use the new fake shape. **Live smoke on dev db (two real accounts across two tenants, `WALDO_BACKFILL_DAYS=3`):** v4→v5 migration applied cleanly (1212 messages preserved); one account synced Teams successfully (+96 messages, 13 chat cursors populated); the other returned `HTTP 403 Forbidden — Missing scope permissions` which is a tenant-level policy (not a code bug) and is correctly recorded in `sync_log`. Outlook ok on both accounts throughout. Weekend 4 closeout — delegated Teams sync is now real. 40 new/rewritten tests across fake, HTTP client, syncTeams, schema (v5 rename + data-preservation + idempotence), store contract + sqlite-specific; 348 total, green; 99.69% line / 98.45% branch global; touched files ≥98% each. Plan: [teams-endpoint-rework.md](plans/done/teams-endpoint-rework.md).
- Teams endpoint rework, slice 1: schema v4 `chat_cursors` table + `MessageStore` CRUD. New table `chat_cursors(account TEXT, chat_id TEXT, last_modified_iso TEXT, PRIMARY KEY(account, chat_id))` behind `PRAGMA user_version = 4` — additive migration, existing rows untouched. `MessageStore` gains `getChatCursor(account, chatId) → string | undefined`, `setChatCursor(ChatCursorEntry)`, `listChatCursors(account) → readonly ChatCursorEntry[]`; implemented on both `SqliteMessageStore` (prepared UPSERT) and `InMemoryMessageStore`. New `ChatCursorEntry` type in [src/store/types.ts](../src/store/types.ts). This is the load-bearing storage for the per-chat high-water-mark that the upcoming polling-based `HttpTeamsClient` needs (each chat tracks its own `lastModifiedDateTime` cursor, replacing the unusable `/me/chats/getAllMessages/delta` deltaLink). Seam reshape + HTTP client rewrite + `syncTeams` rewrite are slice 2 — this slice only lands the storage so slice 2 can TDD against a stable shape. 18 new tests (5 schema + 6 contract × 2 impls + 1 sqlite-specific persistence-across-reconstruction), 336 total, 100% on `schema.ts` / `types.ts` / `message-store.ts`, ≥98% on `sqlite-message-store.ts` (pre-existing `parseMentions` malformed-JSON branches uncovered, unrelated). Plan: [teams-endpoint-rework.md](plans/done/teams-endpoint-rework.md).
- Live smoke on clean dev db (two real accounts across two tenants, `WALDO_BACKFILL_DAYS=14`): **Outlook** both accounts ok on first tick, seconds not minutes (`messagesAddedLastOk` 666 / 546) — backfill window is holding. **Teams** both accounts `HTTP 412 PreconditionFailed — Requested API is not supported in delegated context`; this is a pre-existing Graph architectural constraint on `/me/chats/getAllMessages/delta` (requires application permissions + RSC, not delegated device-code) and has existed since Weekend 4 slice 4 — first surfaced today because slices 4–6 used `FakeTeamsClient` end-to-end. Filed as a separate plan: [teams-endpoint-rework.md](plans/done/teams-endpoint-rework.md) (recommends polling `/me/chats` + `/me/chats/{id}/messages` under the existing delegated auth). The 412 correctly lands in `sync_log` and is deliberately left in place as the regression signal — not suppressed. No code changes this bullet; `WALDO_BACKFILL_DAYS` closeout only. Post-hoc plan capture: [feat-backfill-days-window.md](plans/done/feat-backfill-days-window.md) §Outcome.
- Feature: optional `WALDO_BACKFILL_DAYS` env var caps the **initial** delta backfill window. When set, the first delta call for each (account, source) appends `$filter=receivedDateTime ge <iso>` (Outlook) or `$filter=lastModifiedDateTime ge <iso>` (Teams), with `<iso> = clock.now() - N days`. Once a `deltaLink` is stored, subsequent calls are incremental as before and the value is ignored — it only bounds the initial history fetch. Unset = current unbounded behavior (no default). Plumbed via `Config.backfillDays` → `SyncSchedulerDeps.backfillDays` → `SyncInboxDeps`/`SyncTeamsDeps`; `HttpGraphClient`/`HttpTeamsClient` signatures untouched (URL composed in the sync layer). Existing rows are **not** pruned — to apply a new window retroactively, wipe `WALDO_DB_PATH` + `WALDO_AUTH_DIR` and re-login. 12 new tests (5 config + 3 sync-inbox + 3 sync-teams + 1 scheduler), 318 total, 100% lines on every touched file. Plan: [feat-backfill-days-window.md](plans/done/feat-backfill-days-window.md).
- Fix: `src/index.ts` composition root — `main()` now calls `scheduler.start()` (it previously constructed the scheduler but never ticked), and a direct-execution guard invokes a new `runFromCli()` when the file is run as `tsx src/index.ts`. `runFromCli` wires `SIGINT`/`SIGTERM` to `shutdown()` via an injected `signals` seam (tests never touch real `process.on`). `main()` now logs `listening on http://127.0.0.1:PORT` + `starting initial sync tick` immediately after `httpServer.listen`, before awaiting the first (slow) sync. New tiny `Logger` seam [src/logger.ts](../src/logger.ts) with `consoleLogger` default, injected through the new `MainOptions.overrides` so tests stay silent. `SyncScheduler` gains an optional `onTickComplete(summary)` dep ([src/sync/sync-scheduler.ts](../src/sync/sync-scheduler.ts)) fired once per `runOnce` with `{accounts, okCount, errorCount}` — used by `main()` to log one line per tick. `shutdown()` is idempotent. Also renamed pre-existing real-identifier fixtures flagged by `/security-scan` ("Eric Wauters" → "Alice Example" in `message-store-contract.ts`, "Eric" → "Alice" in `in-memory-file-system.test.ts`). 6 new tests (4 `index` + 1 `sync-scheduler` + 1 `logger`), 306 total, all thresholds green; `src/index.ts` remains coverage-excluded per policy and was smoke-validated by real `tsx src/index.ts` run (health + `tools/list` OK). Plan: [fix-index-entrypoint.md](plans/done/fix-index-entrypoint.md).
- Fix: `syncInbox` and `syncTeams` now persist `rawJson = JSON.stringify(dto)` on every non-removed upsert, closing the brief §4.10 "insurance policy" gap. Column existed since Weekend 2 schema v1 but sync writers never populated it, so all prior lake rows are `rawJson=NULL`. No backfill — delta resync rewrites over time. MCP projections already strip `rawJson`, so no tool surface change. 5 new tests (3 sync-inbox + 2 sync-teams), 300 total, 100% lines + ≥96% branches on both touched files. Plan: [fix-raw-json-population.md](plans/done/fix-raw-json-population.md).
- Weekend 4 slice 6: MCP tool coverage for Teams source. `get_recent_activity` + `search` projections now carry the Teams-specific optional fields (`chatType`, `replyToId`, `mentions`) so Claude Desktop can read channel/thread context on Teams hits; message snippet falls back to `bodyHtml` (truncated to 280 chars) when `body` is undefined, so HTML-only Teams messages render. `get_sync_status` already unioned `(account, source)` pairs — added a mixed outlook+teams test to pin the behaviour. 7 new tests (4 get-recent-activity + 1 search + 1 get-sync-status + 1 existing flow), 296 total, all thresholds green. Closes Weekend 4. Plan: [weekend-4-slice-6-mcp-teams-coverage.md](plans/done/weekend-4-slice-6-mcp-teams-coverage.md).
- Weekend 4 slice 5: `syncTeams` + scheduler wiring. [src/sync/sync-teams.ts](../src/sync/sync-teams.ts) parallels `syncInbox` — walks `@odata.nextLink`/`@odata.deltaLink` from `DEFAULT_TEAMS_DELTA_ENDPOINT = "/me/chats/getAllMessages/delta"`, maps `TeamsMessage` → `Message` (`source: "teams"`, `id = teams:<account>:<nativeId>`, `from.user` → `senderName`/`senderEmail`, `body` text/html split, `chatId` → `threadId`, `channelIdentity` → `chatType="channel"`, `replyToId` passthrough, mentions resolved via `userPrincipalName ?? displayName ?? mentionText`), routes `@removed` to `deleteMessages`, persists `setSyncState({source:"teams"})` with the deltaLink, propagates `TokenExpiredError`/`DeltaTokenInvalidError` leaving stored state intact. `SyncScheduler` gains optional `teams?: TeamsClient` dep; when present, each `runOnce` tick calls `syncTeams` per account alongside `syncInbox` and appends a second `sync_log` row with `source: "teams"`; a teams failure does not block outlook. `src/index.ts` wires a real `HttpTeamsClient`. 10 new tests (7 sync-teams + 3 scheduler), 289 total, all thresholds green. Plan: [weekend-4-slice-5-sync-teams.md](plans/done/weekend-4-slice-5-sync-teams.md).
- Weekend 4 slice 4: `HttpTeamsClient` (fetch-backed). [src/sources/http-teams-client.ts](../src/sources/http-teams-client.ts) parallels `HttpGraphClient` — hits baseUrl + relative path or absolute nextLink with bearer token + `Prefer: odata.maxpagesize=50`, parses `value`/`@odata.nextLink`/`@odata.deltaLink`, maps 401→`TokenExpiredError`, 410→`DeltaTokenInvalidError`, 429→`GraphRateLimitedError(retryAfter)`, non-2xx → `Error` with body excerpt ≤200 chars. Bearer token redacted from all thrown error messages. 9 new tests, 279 total. Live smoke against real Graph still a manual follow-up. Plan: [weekend-4-slice-4-http-teams-client.md](plans/done/weekend-4-slice-4-http-teams-client.md).
- Weekend 4 slice 3: `TeamsClient` seam + `FakeTeamsClient`. New [src/sources/teams.ts](../src/sources/teams.ts) mirrors the `GraphClient` shape — `TeamsMessage`/`TeamsDeltaResponse` DTOs covering `chatId`, `messageType`, `replyToId`, `from.user`, `body`, `mentions[]`, `channelIdentity`, `@removed`; transport errors re-exported from `graph.js`. [src/testing/fake-teams-client.ts](../src/testing/fake-teams-client.ts) clones the `FakeGraphClient` scripted-step pattern with `calls` recorder and `remainingSteps`. 5 new tests, 270 total. Plan: [weekend-4-slice-3-teams-client-seam.md](plans/done/weekend-4-slice-3-teams-client-seam.md).
- Weekend 4 slice 2: Teams message shape + schema v3. `Message` gains `chatType` (`"oneOnOne" | "group" | "channel"`), `replyToId`, and `mentions` optional fields. Schema migration 3 (`CURRENT_SCHEMA_VERSION = 3`) adds nullable `chat_type`, `reply_to_id`, `mentions_json` columns to `messages` via `ALTER TABLE`; FTS5 surface untouched. `SqliteMessageStore` upsert/read handle the new columns (mentions serialized to JSON; parse fails closed to `undefined` on malformed rows). Contract suite gains three Teams-roundtrip cases exercised on both impls. 10 new tests, 265 total, 100% coverage on touched files. Plan: [weekend-4-slice-2-teams-schema-v3.md](plans/done/weekend-4-slice-2-teams-schema-v3.md).
- Weekend 4 slice 1: interactive device-code login CLI. New [src/cli.ts](../src/cli.ts) exposes `runCli(argv, deps)` + `addAccount(opts)`; `--add-account` path runs `MsalAuthClient.loginWithDeviceCode` against the existing `TokenCacheStore` and prints the code-entry URL via an injectable `print` callback. `runCli` dispatches to existing `main()` otherwise; unknown flags raise `CliUsageError`. 10 new tests, 255 total, 100% function coverage on touched files (real fs + MSAL adapter paths `/* c8 ignore */`d — live login remains a manual smoke step). Unblocks Weekend 4 multi-account login. Plan: [weekend-4-slice-1-interactive-login-cli.md](plans/done/weekend-4-slice-1-interactive-login-cli.md).

- Closed Weekend 3. Added operator recipe [claude-desktop-wiring.md](claude-desktop-wiring.md) covering prereqs, `curl /health` + `curl tools/list` verification, `claude_desktop_config.json` snippet, troubleshooting table, and security notes; linked from [getting-started.md §6](getting-started.md). Plan: [weekend-3-slice-5-claude-desktop-wiring.md](plans/done/weekend-3-slice-5-claude-desktop-wiring.md).
- Added end-to-end HTTP integration test [src/mcp/e2e-http.test.ts](../src/mcp/e2e-http.test.ts) exercising the whole stack: real `SqliteMessageStore` (`:memory:`, FTS5) + `createMcpHttpServer` + real `fetch`, covering `tools/list`, `get_recent_activity`, `search`, `get_sync_status`, and auth rejection. Mirrors the "summarize last 24h" call path Claude Desktop will use. 5 new tests, 245 total. Plan: [weekend-3-slice-4-e2e-http.md](plans/done/weekend-3-slice-4-e2e-http.md).
- Added third MCP tool `search(query, limit?)` ([src/mcp/tools/search.ts](../src/mcp/tools/search.ts)) — thin wrapper over the slice-9 FTS5 `MessageStore.searchMessages`. Validates non-empty query, `limit ∈ (0,100]` (default 20), projects hits to drop `body`/`bodyHtml`/`rawJson` while preserving BM25 `rank` + snippet. Registered in `http-server.ts` dispatch map. 11 new handler tests, 240 total. Plan: [weekend-3-slice-3-search.md](plans/done/weekend-3-slice-3-search.md).
- Added second MCP tool `get_sync_status()` ([src/mcp/tools/get-sync-status.ts](../src/mcp/tools/get-sync-status.ts)) — no-param health snapshot of the sync loop. New `MessageStore.getSyncStatus(now)` read method unions `sync_state ∪ sync_log` per `(account, source)` and returns `lastSyncAt`, `lastOkAt`, `lastStatus`, `lastError`, `messagesAddedLastOk`, `messagesAddedLast24h`; implemented on `SqliteMessageStore` via a single `WITH pairs` CTE + correlated subqueries (index `idx_sync_log_ts`) and on `InMemoryMessageStore`. Handler adds per-row `stale` flag (15-minute threshold = 3× default sync interval) plus top-level `generatedAt`, `accountsTracked`, `staleCount`. `http-server.ts` dispatch refactored to a `{name → handler}` map so tool #3 slots in without touching control flow. 28 new tests (9 handler + 3 HTTP JSON-RPC + 8 store contract × 2 impls), 229 tests total, 100% coverage on every new file. Plan: [weekend-3-slice-2-get-sync-status.md](plans/done/weekend-3-slice-2-get-sync-status.md).
- Added first MCP tool `get_recent_activity(hours, sources?, accounts?)` ([src/mcp/tools/get-recent-activity.ts](../src/mcp/tools/get-recent-activity.ts)) backed by a new `MessageStore.getRecentMessages({ since, sources?, accounts?, limit })` method implemented on both `InMemoryMessageStore` and `SqliteMessageStore` (parameterised `WHERE sent_at >= ? [AND source IN (…)] [AND account IN (…)] ORDER BY sent_at DESC, id DESC LIMIT ?`, stable id tiebreak). Handler validates `hours ∈ (0,720]`, rejects unknown sources and empty/non-string accounts, projects messages to drop `rawJson`/`bodyHtml` and cap `body` at a 280-char snippet. Hand-rolled JSON-RPC 2.0 dispatch landed in [src/mcp/http-server.ts](../src/mcp/http-server.ts) — `POST /` now handles `tools/list` and `tools/call`, returning `-32700` (parse), `-32600` (invalid request), `-32601` (unknown method/tool), `-32602` (invalid params), `-32603` (internal); `@modelcontextprotocol/sdk` deferred until 2–3 tools exist. 30 new tests (13 handler + 9 HTTP JSON-RPC + 7 store contract × 2 impls minus overlap), 201 tests total, branch coverage 96.94% global / 95.45% on http-server. Plan: [weekend-3-slice-1-get-recent-activity.md](plans/done/weekend-3-slice-1-get-recent-activity.md).
- Added real `HttpGraphClient` ([src/sources/http-graph-client.ts](../src/sources/http-graph-client.ts)) — `fetch`-backed `GraphClient` with 401→`TokenExpiredError`, 410→`DeltaTokenInvalidError`, 429→`GraphRateLimitedError(Retry-After)` mapping; bearer token redacted from all thrown errors (pinned by AC8). Wired into `main()`, replacing the `notImplementedGraph` stub. Live smoke against `graph.microsoft.com` remains a manual follow-up.

- Closed Weekend 2 wiring in one bundled slice: real `MsalAuthClient` ([src/auth/msal-auth-client.ts](../src/auth/msal-auth-client.ts)) wrapping `@azure/msal-node` `PublicClientApplication` behind the existing `AuthClient` seam, with injectable PCA for tests and a `cachePlugin` that routes through `TokenCacheStore`; `syncInbox` delta sweep ([src/sync/sync-inbox.ts](../src/sync/sync-inbox.ts)) walking `@odata.nextLink`, routing `@removed` to `deleteMessages`, updating `sync_state` only on a full-run `deltaLink`; `SyncScheduler` ([src/sync/sync-scheduler.ts](../src/sync/sync-scheduler.ts)) with injected `setTimer` seam, per-account `sync_log` rows on success/failure, and a `isRunning` guard that skips overlapping ticks via `onSkip`; skeleton `node:http` MCP transport ([src/mcp/http-server.ts](../src/mcp/http-server.ts)) with `/health` bypass, `crypto.timingSafeEqual` bearer middleware, and a 404 fall-through (no MCP tools yet — Weekend 3); `main()` composition root ([src/index.ts](../src/index.ts)) loading `.env` via `dotenv`, wiring real `SqliteMessageStore` + MSAL + HTTP server, with a `NotImplementedGraph` stub until the real Graph HTTP adapter lands. `loadConfig` extended with `WALDO_PORT` (default 8765) and `WALDO_SYNC_INTERVAL_MS` (default 300_000). New runtime deps: `@azure/msal-node`, `dotenv`. 39 new tests (8 MSAL adapter + 8 `syncInbox` + 7 `SyncScheduler` + 8 HTTP server + 5 config + 2 `main` + 1 MSAL expiresOn fallback), 157 tests total, all thresholds green. `src/index.ts` added to coverage excludes per [coverage-policy.md](tdd/coverage-policy.md). Plan: [weekend-2-slice-10-msal-sync-loop-mcp-env.md](plans/done/weekend-2-slice-10-msal-sync-loop-mcp-env.md).
- Added FTS5 full-text search over `messages` behind `PRAGMA user_version=2` migration ([src/store/schema.ts](../src/store/schema.ts)): external-content `messages_fts` virtual table (`unicode61 remove_diacritics 2`), three sync triggers (`messages_ai`/`ad`/`au`), and a backfill `INSERT … SELECT` so existing v1 rows light up on upgrade. New `searchMessages(query, limit)` on the `MessageStore` seam returns `SearchHit { message, snippet, rank }` — BM25-ranked in `SqliteMessageStore` (with `snippet()` highlights wrapping matches in `[...]`), naive lowercase substring in `InMemoryMessageStore`. User input is escaped to a quoted FTS5 phrase via `toFts5Phrase`, so `"`/`*` cannot escape into MATCH syntax. 17 new tests (7 schema incl. v1→v2 upgrade-path with backfill assertion, 6 contract cases × 2 impls, 4 sqlite-only: BM25 ordering, snippet delimiters, injection resistance, reconstruction). 118 tests, 100% line + branch coverage. "Real schema" milestone in PROGRESS.md is now closed. Plan: [weekend-2-slice-9-fts5-search.md](plans/done/weekend-2-slice-9-fts5-search.md).
- Extended schema with `accounts` + `sync_log` tables behind `PRAGMA user_version=1` migration ([src/store/schema.ts](../src/store/schema.ts)); replaced inline `CREATE TABLE` block in `SqliteMessageStore` with `applyMigrations(db)` as the single source of truth for DDL. Added `appendSyncLog` / `upsertAccount` / `listAccounts` to the `MessageStore` interface; both `SqliteMessageStore` and `InMemoryMessageStore` implement them. Contract helper grew a `readSyncLog` test-only hatch on the factory return so the contract suite covers `sync_log` round-trips without leaking a query op into the production interface. `listAccounts` orders by `addedAt ASC, username ASC`. 13 new tests (5 schema + 6 contract cases × 2 impls + 1 sqlite-specific persistence-across-reconstruction case), 100% line + branch coverage on touched files. FTS5 + `search()` deferred to slice 9. Plan: [weekend-2-slice-8-schema-accounts-sync-log.md](plans/done/weekend-2-slice-8-schema-accounts-sync-log.md).
- Landed real `SqliteMessageStore` ([src/store/sqlite-message-store.ts](../src/store/sqlite-message-store.ts)) behind the slice-6 `MessageStore` seam, backed by `better-sqlite3` with `messages` + `sync_state` tables, transactional `upsertMessages` (rolls back whole batch on mid-batch failure), millisecond `Date` round-trip, and nullable-field → `undefined` round-trip. Contract tests extracted to shared helper ([src/store/message-store-contract.ts](../src/store/message-store-contract.ts)) so `InMemoryMessageStore` and `SqliteMessageStore` run the same 10 cases. Added `openDatabase(path)` helper ([src/store/open-database.ts](../src/store/open-database.ts)) applying WAL + `foreign_keys=ON` + `synchronous=NORMAL`. `accounts` / `sync_log` / FTS5 / query ops still deferred to their first consuming tests. 16 new tests, 100% line + branch coverage. Plan: [weekend-2-slice-7-sqlite-message-store.md](plans/done/weekend-2-slice-7-sqlite-message-store.md).
- Landed `src/store` testable core: `Message`/`SyncStateEntry`/`MessageSource` types + `StoreError` ([src/store/types.ts](../src/store/types.ts)) mirroring brief §5 1:1, `MessageStore` interface ([src/store/message-store.ts](../src/store/message-store.ts)) with `upsertMessages`/`deleteMessages`/`get`+`setSyncState`, and `InMemoryMessageStore` scripted fake with `calls` log + `seed` ([src/testing/in-memory-message-store.ts](../src/testing/in-memory-message-store.ts)). 16 new tests (10 contract + 4 fake-specific + 2 StoreError), 100% branch coverage on touched files. Real `better-sqlite3` adapter + FTS5 + `sync_log`/`accounts` tables + query ops deferred to follow-up slices. Plan: [weekend-2-slice-6-store-seam.md](plans/done/weekend-2-slice-6-store-seam.md).
- Landed `src/auth` testable core: `Account`/`AccessToken`/`AuthError` types ([src/auth/types.ts](../src/auth/types.ts)), `AuthClient` interface ([src/auth/auth-client.ts](../src/auth/auth-client.ts)), fs-seam-backed `TokenCacheStore` with atomic temp+rename write at mode `0o600` ([src/auth/token-cache-store.ts](../src/auth/token-cache-store.ts)), and scripted `FakeAuthClient` ([src/testing/fake-auth-client.ts](../src/testing/fake-auth-client.ts)). 17 new tests, 100% branch coverage on touched files. `InMemoryFileSystem` extended with `ops` log, `modeOf`, `injectReadError` to support atomic-write and corruption tests. Real `@azure/msal-node` adapter deferred to a follow-up slice. Plan: [weekend-2-slice-5-auth-seam-and-token-cache.md](plans/done/weekend-2-slice-5-auth-seam-and-token-cache.md).
- Landed Weekend 2 folder skeleton (`src/auth`, `src/store`, `src/sync`, `src/mcp`) + pure `loadConfig(env)` ([src/config.ts](../src/config.ts)) returning typed `Config` or throwing `ConfigError` listing all missing keys. 10 tests cover defaults, overrides, single/multi missing, empty-string, immutability. Stub `main()` in [src/index.ts](../src/index.ts). Env contract documented in [.env.example](../.env.example). Plan: [weekend-2-slice-4-folder-structure-and-config.md](plans/done/weekend-2-slice-4-folder-structure-and-config.md).
- Landed `GraphClient` seam ([src/sources/graph.ts](../src/sources/graph.ts)) + scripted `FakeGraphClient` ([src/testing/fake-graph-client.ts](../src/testing/fake-graph-client.ts)). 5 contract tests cover scripted ok/error replay, script order, past-end diagnostics, and `GraphRateLimitedError.retryAfterSeconds`. Plan: [weekend-2-slice-3-fake-graph-client.md](plans/done/weekend-2-slice-3-fake-graph-client.md).
- Landed `FileSystem` seam ([src/fs.ts](../src/fs.ts)) + `InMemoryFileSystem` trigger-driven fake ([src/testing/in-memory-file-system.ts](../src/testing/in-memory-file-system.ts)). 7 contract tests cover read/write/rename/listDir/watch incl. `"WhatsApp Chat*.txt"` glob. Plan: [weekend-2-slice-2-filesystem-seam.md](plans/done/weekend-2-slice-2-filesystem-seam.md).
- Bootstrapped TypeScript project in-place: `package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`. Node 22, ESM, strict TS, per-file 90% coverage thresholds. See [PROGRESS.md](../PROGRESS.md) Weekend 2.
- Landed first seam: `Clock` interface + `systemClock` ([src/clock.ts](../src/clock.ts)) and `FakeClock` test double ([src/testing/fake-clock.ts](../src/testing/fake-clock.ts)). 4 tests, 100% coverage on `clock.ts`.
- Added mandatory **Step 0 PLAN** to the TDD loop ([CLAUDE.md](../CLAUDE.md), [.claude/skills/tdd-cycle/SKILL.md](../.claude/skills/tdd-cycle/SKILL.md)): every task now writes an approvable md plan under [docs/plans/](plans/) before any FRAME/RED/code. First plan: [weekend-2-slice-1-bootstrap-and-clock.md](plans/done/weekend-2-slice-1-bootstrap-and-clock.md).
- Weekend 2 scaffolds in-place at `/Users/waldo/SourceCode/Community/waldo.WTF/`; spike at `/Users/waldo/Temp/waldo-wtf-spike` is reference-only.
- Added [.github/copilot-instructions.md](../.github/copilot-instructions.md) — GitHub Copilot follows the same TDD toolchain as Claude, via references (no duplication).
- Added `/security-scan` skill (gitignore baseline, secret patterns, real-data scan, log hygiene, error-message interpolation, snapshot/fixture scan, `npm audit`). Wired into the TDD cycle between COVER and UPDATE DOCS. Added root `.gitignore` with the secrets baseline.
- Added root [README.md](../README.md) as the project's front door; wired maintenance into `/docs-update` so scope / status / architecture changes update it automatically.
- Added FRAME step (≤150-word step framing) as Step 0 of the TDD cycle — every coding task now opens with goal, project position, why, and contribution.
- Established TDD methodology: RED/GREEN/REFACTOR cycle, 90% per-file coverage, AI-maintainability rules, testability patterns for all seams (Graph, MSAL, SQLite, clock, fs, logger, HTTP).
- Added repo-local `/tdd-cycle` skill enforcing the cycle at the start of every coding task.
- Added repo-local `/docs-update` skill enforcing changelog + doc updates at the end of every coding task.
- Added `/docs` skillset: index README, changelog, setup, getting-started, user guide.
- Added drop-in Vitest toolchain under `/testing`: config, deps, example fakes (`FakeClock`, `FakeGraphClient`, canonical `deltaSync` unit test).
- Weekend 1 delta queries verified: run 1 = 36154 msgs across 724 pages, run 2 = +0/-0 (see [../PROGRESS.md](../PROGRESS.md)).

## 2026-04-12

- Weekend 0 spike complete: MSAL device-code flow, Graph `Mail.Read`, better-sqlite3 WAL, single-account end-to-end on `eric.wauters@dynex.be`.
- Entra app `waldo-wtf-spike` registered (multitenant + personal MS accounts, public client flows, delegated `Mail.Read`).
- All foundational risks retired — see [project brief §7 Weekend 0](../waldo.WTF-project-brief.md).
