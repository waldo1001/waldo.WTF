# Calendar — Meeting transcripts (slices 9–14)

Parent: [calendar-overview.md](../calendar-overview.md). Hard
predecessor: [slice 4](./calendar-slice-4-sync-and-scope.md) (events
must already be in the lake, and this plan reuses its
`CalendarAccountStore` opt-in + `--calendar-enable`-style CLI pattern).
Strongly recommended: [slice 5](./calendar-slice-5-meeting-chat-link.md)
(so a transcript joins to its meeting **and** its chat).

**Status:** committed, not merely optional — the user opted in on
2026-08-12 after this plan was re-specced against current Microsoft
Graph docs (see below). Only sub-slice T7 (FTS5 search) remains
genuinely optional.

**Implementation notes (post-hoc):** T1–T6 all shipped 2026-08-12; the
feature is complete except T7, which remains optional/deferred as
originally scoped. Two design corrections were found and fixed during
implementation, not anticipated by this plan: (1) T3/T4's
`TranscriptClient` interface resolved MSAL tokens by `onlineMeetingId`
instead of by account — fixed by adding an explicit `account`
parameter. (2) T5's `syncTranscripts` originally caught consent-required
errors the same way as per-meeting failures (persisting a misleading
`fetch-failed` status); fixed to rethrow them so they propagate to the
scheduler's existing admin-consent-hint handling, mirroring
`syncCalendarEvents`. See [changelog.md](../../changelog.md)'s
2026-08-12 entries for full detail per sub-slice.

## Why this is a separate plan (re-verified 2026-08-12)

Transcripts still cross lines the base feature deliberately does not —
but two of the original four reasons turned out to be wrong when
checked against current Microsoft Learn docs
([calltranscript-get](https://learn.microsoft.com/graph/api/calltranscript-get),
[teams-licenses](https://learn.microsoft.com/graph/teams-licenses)).
Corrected picture:

- **Licensing — NOT Teams Premium-gated.** This plan originally assumed
  Teams Premium was required. It isn't: Premium only affects
  *translated* transcript variants. The real gates are (a) the meeting
  was actually transcribed, and (b) tenant-admin transcript-API
  settings (the calltranscript-get doc describes "two independent
  tenant administrator settings" governing access — the auth sub-slice
  T2 verifies the exact toggle names during FRAME). Either condition
  failing still means "no transcript" is the steady state, not an
  error — that part of the original reasoning holds.
- **Consent surface — delegated works, no app-only auth needed.** This
  plan originally assumed `OnlineMeetingTranscript.Read.All` was
  effectively application-only. It isn't: the Graph docs explicitly
  list **Delegated (work or school account):
  `OnlineMeetingTranscript.Read.All`** as the least-privileged
  permission for `GET /me/onlineMeetings/{id}/transcripts` and its
  `/content`, and state the API "is also available to users who are
  part of the meeting calendar invite" — i.e. attendees, not just
  organizers. So the whole parallel app-only-auth-with-tenant-admin-
  consent path (originally sub-slice T2, the single biggest piece of
  this plan) collapses to: add `OnlineMeetingTranscript.Read.All` as
  one more scope on the *existing* delegated device-code flow, gated
  by the same per-account opt-in as calendar. The delegated scope still
  needs admin consent (`AdminConsentRequired: Yes` in the permissions
  reference) — but that's the same consent shape slice 4 and the
  existing Teams-channel scopes already handle, not a new auth system.
- **Metering — new finding, not in the original plan.** The `/content`
  endpoint is a **metered API**: evaluation mode gives roughly 600 free
  minutes per month per tenant per app; beyond that Graph returns
  **HTTP 402 (Payment Required)** unless the operator has linked an
  Azure subscription for billing, after which usage is
  ~$0.0022/minute. This needs its own error class and a documented cost
  implication — see the cross-cutting decisions below.
- **Meeting expiration — new finding, not in the original plan.** The
  transcript API "works for a meeting only if the meeting hasn't
  expired" per Teams' meeting-expiration limits. Concretely: this plan
  cannot retrieve transcripts for old meetings just because slice 4
  backfilled a year of calendar history. Transcript eligibility is
  capped to recently-ended events (a 60-day constant, see T5).
- **Data shape (unchanged).** Transcripts come back as **VTT**
  (WebVTT) — a text format with timestamps and speaker tags. Storing
  them is fine, but searching them well wants a row-per-segment shape,
  not a single blob.
- **Volume (unchanged).** A one-hour transcribed meeting is several
  hundred KB. At one-meeting-a-day across two opted-in accounts that's
  still small (~tens of MB/year), but it's bigger per item than
  messages and events.

Putting all of this behind a single plan that owns the licensing gate,
the metering/expiration edge cases, the VTT parser, and the storage
shape keeps the base feature's surface clean — that rationale for
keeping it a separate plan still holds even though the auth story got
much simpler.

## Task

Sync, store, search, and surface meeting transcripts for online
meetings whose calendar events already live in the lake, for accounts
that have opted in via `--transcripts-enable`.

## High-level shape

```
              ┌─ events (slice 1) — online_meeting_id populated by slice 5
              │
              ┌─ calendar_accounts.transcripts_enabled (T2, reuses slice 4's opt-in table)
              │
sync-tick ──► syncTranscripts ──► transcripts row + transcript_segments rows
              │     ▲               (only for enabled accounts, only for
              │     │                events ended within the last 60 days)
              │     └── HttpTranscriptClient
              │              GET /me/onlineMeetings/{id}/transcripts
              │              GET .../transcripts/{transcriptId}/content?$format=text/vtt
              │              │
              │              └── delegated token, scope OnlineMeetingTranscript.Read.All
              │                  (same device-code flow as calendar, one more scope —
              │                   NOT a second app-only auth client)
              │
              └─ get_event(eventId) ──► linkedTranscript: { transcriptId, vttUrl, segments }
                                  ▲
                                  └── slice 5 already returns the event;
                                      this plan grows its return value
```

## Slicing

This follow-up itself is too big for one TDD cycle. Internal
slicing (still within this single plan file because the slices are
small and tightly bound). These map to overview slices 9–14 (see
[calendar-overview.md](../calendar-overview.md)):

| # | Overview slice | Sub-slice                               | What it lands |
|---|---|-----------------------------------------|---------------|
| T1 | 9 | Schema v17→v18: `transcripts` + `transcript_segments`, `MessageStore` ops | tables, types, upsert/get readers |
| T2 | 10 | Delegated scope + admin consent      | `TRANSCRIPT_SCOPES` constant, `--transcripts-enable` CLI, admin-consent doc — reuses slice 4's `CalendarAccountStore` and CLI pattern; **no second auth client** |
| T3 | 11 | `TranscriptClient` seam + `FakeTranscriptClient` | interface, fake, no HTTP |
| T4 | 12 | `HttpTranscriptClient` + VTT parser   | Graph `/me/onlineMeetings/{id}/transcripts` + `/content`, VTT → segments, error mapping incl. 402 |
| T5 | 13 | `syncTranscripts` job + scheduler tie-in | per-eligible-event walk (60-day window), `transcripts_enabled` gate, `sync_log` rows |
| T6 | 14 | `get_event_transcript(eventId)` MCP tool + extension of `get_event` | dedicated tool returning segments, optional `include_transcript` flag on `get_event` |
| T7 | (optional) | FTS5 over transcript segments         | `transcript_segments_fts`, search integration |

T1 → T6 are sequential and all committed. T7 is optional (search adds
real value but is a strictly later add-on).

## Sub-slice details

### T1 — schema + store ops

- Schema bump **v17 → v18**. Slice 1 claims v16 for
  `events`/`event_attendees`/`calendar_accounts`, and
  [slice 8](./calendar-slice-8-event-steering.md) — part of the
  base 8 slices, which land before any transcript slice — claims v17
  for its own `steering_rules.rule_type` enum widening (a real
  table-rebuild migration, not a marker-only bump — the `rule_type`
  column carries a `CHECK` constraint). Transcripts land after slice 8,
  so this is the next available version, v18 (this matches the
  original pre-rewrite numbering; an earlier draft of this
  section mistakenly proposed v16→v17 without checking slice 8's
  existing claim on v17 — corrected here). Two tables:
  ```sql
  CREATE TABLE transcripts (
    account TEXT NOT NULL,
    event_id TEXT NOT NULL,
    transcript_id TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    vtt_bytes INTEGER,        -- size of original VTT for diagnostics
    segment_count INTEGER NOT NULL,
    status TEXT NOT NULL,     -- 'ok' | 'not-available' | 'quota-exhausted' | 'fetch-failed'
    raw_json TEXT,
    PRIMARY KEY (account, event_id, transcript_id),
    FOREIGN KEY (account, event_id)
      REFERENCES events(account, event_id) ON DELETE CASCADE
  );

  CREATE TABLE transcript_segments (
    account TEXT NOT NULL,
    event_id TEXT NOT NULL,
    transcript_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    speaker_email TEXT,
    speaker_display_name TEXT,
    start_offset_ms INTEGER NOT NULL,
    end_offset_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (account, event_id, transcript_id, sequence),
    FOREIGN KEY (account, event_id, transcript_id)
      REFERENCES transcripts(account, event_id, transcript_id)
        ON DELETE CASCADE
  );

  CREATE INDEX idx_segments_event
    ON transcript_segments(account, event_id, sequence);
  ```
- `MessageStore.upsertTranscript(transcript, segments)` — atomic
  replace-set: deletes existing segments for that
  `(account, event_id, transcript_id)`, inserts new ones, upserts
  the transcript row.
- `MessageStore.getTranscriptByKey({account, eventId, transcriptId})`
  → returns `null | { transcript, segments }`.
- `MessageStore.listTranscriptsForEvent({account, eventId})` → 0+
  transcript rows (a single meeting can in principle have multiple
  transcripts for multiple recordings).
- `MessageStore.markTranscriptStatus({..., status})` — for the
  `not-available` / `quota-exhausted` / `fetch-failed` cases, so we
  don't keep retrying on a schedule that ignores each status's own
  cooldown (see T5's retry policy).

**RED list highlights:** schema migration creates the tables
incl. cascade on `events`; upsert replaces segments; PK collision
across `(account, event_id, transcript_id)` correctly disambiguated;
status transitions persisted.

### T2 — delegated scope + admin consent

No second auth client. Verified against
[calltranscript-get](https://learn.microsoft.com/graph/api/calltranscript-get):
`GET /me/onlineMeetings/{id}/transcripts` and its `/content` support
**Delegated (work or school account) `OnlineMeetingTranscript.Read.All`**
as the least-privileged permission, and explicitly work for "users who
are part of the meeting calendar invite" — not just organizers. This
reuses the exact same `AuthClient` seam and device-code flow calendar
already uses in
[slice 4](./calendar-slice-4-sync-and-scope.md), one more scope.

- New scope constant in
  [src/auth/msal-auth-client.ts](../../../src/auth/msal-auth-client.ts),
  alongside `CALENDAR_SCOPES`:
  ```ts
  export const TRANSCRIPT_SCOPES = ["OnlineMeetingTranscript.Read.All"] as const;
  ```
  Kept separate from `CALENDAR_SCOPES` (not merged in) for the same
  reason `CALENDAR_SCOPES` is separate from base `SCOPES` — an account
  can have calendar enabled without transcripts, and requesting scopes
  the operator didn't ask for is exactly the mistake slice 4 avoided.
- `transcripts_enabled` column on `calendar_accounts` already exists
  from [slice 1](./calendar-slice-1-schema-and-store.md)'s DDL. This
  sub-slice adds `CalendarAccountStore.setTranscriptsEnabled` (already
  declared on the interface in slice 4; this is where it gets exercised
  for the first time) and a CLI flag:
  - `--transcripts-enable <account>` in
    [src/cli.ts](../../../src/cli.ts): requires the account already has a
    `calendar_accounts` row (errors with a pointer to
    `--calendar-enable` if not — you can't enable transcripts for
    calendar you never turned on). Runs
    `loginWithDeviceCode(onPrompt, { scopes: [...SCOPES,
    ...CALENDAR_SCOPES, ...TRANSCRIPT_SCOPES] })` (re-requesting the
    already-consented scopes alongside the new one is how incremental
    delegated consent works — Entra treats it as one combined grant),
    then `calendarAccounts.setTranscriptsEnabled(account, true)`.
  - `--transcripts-disable <account>`: sets the flag to `false`. Does
    not delete already-fetched transcripts.
  - Same `isConsentRequiredError` remediation-message pattern as
    `--calendar-enable`: on consent rejection, print the exact scope
    and tenant, don't write the flag.
- Admin-consent runbook in [docs/setup.md](../../../docs/setup.md)
  (replaces the old app-only runbook entirely): grant
  `OnlineMeetingTranscript.Read.All` delegated permission on the
  existing app registration (no second app), tenant admin consent URL
  if the tenant blocks user consent, and — new — a note on the metering
  behavior: evaluation mode gives ~600 free minutes/month/tenant/app;
  beyond that, transcript content fetches 402 until an Azure
  subscription is linked for billing
  ([teams-licenses](https://learn.microsoft.com/graph/teams-licenses)).
  No credential-rotation runbook is needed — there's no long-lived
  app-only secret or cert to rotate anymore.

**RED list highlights:** `TRANSCRIPT_SCOPES` is exactly
`["OnlineMeetingTranscript.Read.All"]` and is never merged into
`SCOPES` or `CALENDAR_SCOPES`; `--transcripts-enable` rejects an
account with no calendar row; `--transcripts-enable` device-codes with
all three scope sets combined; consent rejection leaves
`transcripts_enabled` unset.

### T3 — `TranscriptClient` seam + fake

- `src/sources/transcript.ts` defines:
  - `TranscriptClient.listTranscripts(eventId): TranscriptHandle[]`
    — handles include `transcriptId`, `createdAt`, `contentUrl`.
  - `TranscriptClient.fetchVttContent(handle): { vtt: string }`.
- Pure interface + DTO mapping. No HTTP.

### T4 — `HttpTranscriptClient` + VTT parser

- `src/sources/http-transcript-client.ts` — calls
  `GET /me/onlineMeetings/{onlineMeetingId}/transcripts` to list,
  then `GET .../transcripts/{transcriptId}/content?$format=text/vtt`
  to fetch. **Delegated** token (via `TRANSCRIPT_SCOPES`, from T2) in
  `Authorization` — same shape as `HttpCalendarClient`'s token usage,
  not a separate app-only credential. `onlineMeetingId` comes from
  `events.online_meeting_id`, populated by
  [slice 5](./calendar-slice-5-meeting-chat-link.md).
- `parseVtt(text): VttCue[]` — small, in-tree parser. Each cue:
  `{ sequence, startMs, endMs, speakerName, speakerEmail, text }`.
  Speaker is encoded in VTT as a `<v Name>` voice tag with email
  available in some tenants via the `<v.email>` extension; parser
  tolerates either.
- Error mapping mirrors `HttpCalendarClient`, with one new case:
  - **402** → `'quota-exhausted'` (NEW — the metered-API limit
    described in teams-licenses; recorded as a status row, retried no
    sooner than 7 days per T5's retry policy).
  - **403** → `'not-available'` if the body indicates the transcript
    API is disabled for the tenant/meeting; `'consent-required'`
    (surfaced like the existing Teams-channel consent canary, via
    `isConsentRequiredError`) if the body indicates a missing grant —
    these are distinguishable because a consent failure is a
    token/authorization-shaped error, not a 200-with-error-body.
  - **404** → `'not-available'` — meeting wasn't transcribed (or has
    expired past Teams' meeting-expiration window). Same non-retry
    behavior as before, renamed from `license-missing`.
  - **401** → delegated token refresh + retry once (mirrors
    `HttpCalendarClient`'s 401 handling exactly — no app-only-specific
    refresh logic needed).
  - **429 / 5xx** → backoff + retry per existing pattern.

**RED list highlights:** VTT parser handles cues with and without
speaker tag, with overlapping cues (Teams sometimes emits these),
with unicode; HTTP client maps 402 to `quota-exhausted` and 404/403
(disabled) to `not-available`; bearer redaction in errors (delegated
tokens are exactly as sensitive as any other Graph bearer already
handled by the existing redaction pattern — no new redaction logic).

### T5 — `syncTranscripts` job + scheduler

- New `src/sync/sync-transcripts.ts`:
  - Per scheduler tick, **per account with `transcripts_enabled = 1`**
    in `calendar_accounts` (from T2) — mirror the calendar per-account
    skip pattern in
    [sync-scheduler.ts](../../../src/sync/sync-scheduler.ts).
  - For each enabled account, query `events` for online-meeting events
    (`online_meeting_id IS NOT NULL`) where:
    - `end_at < clock.now()` (the meeting has actually ended, so a
      transcript could exist), **and**
    - `end_at > clock.now() - TRANSCRIPT_ELIGIBILITY_DAYS` (a new
      constant, **60**) — meetings older than this are excluded
      up front, because the transcript API stops working once a
      meeting expires (Teams limits-specifications). Without this
      bound, slice 4's 365-day calendar backfill would make the sync
      job attempt (and fail) hundreds of doomed fetches for old
      meetings on its very first tick.
    - and either no `transcripts` row yet, or the existing row's
      `status` is due for retry per the policy below.
  - Cap to 20 events per tick to bound runtime.
  - For each: list transcripts, fetch content, parse, upsert via
    T1 ops. Persist `status='ok'` / `'not-available'` /
    `'quota-exhausted'` / `'fetch-failed'`.
  - Retry policy: `'not-available'` — never retried (the meeting
    wasn't transcribed or the API is off; re-checking doesn't help).
    `'quota-exhausted'` — retried no sooner than **7 days** (the
    monthly free-tier resets; retrying sooner just burns more 402s).
    `'fetch-failed'` — retried after **24h** (transient-shaped
    failures, matches the existing pattern for other sources).
- Scheduler wiring: gated on `transcripts_enabled` **per account**
  (T2), not a global environment variable — there is no
  `WALDO_TRANSCRIPTS_ENABLED` flag. The per-account column already is
  the opt-in; a redundant global flag was dropped when the auth model
  simplified from app-only (tenant-wide) to delegated (per-account).
- `sync_log` rows: `source='transcripts'`, status `ok` / `error`,
  with `messages_added` set to **transcript count** (not segment
  count) for this tick.

**RED list highlights:** per-tick cap; 60-day eligibility window
excludes older events even when no transcript row exists yet; status
transitions persisted; `not-available` never retried; `quota-exhausted`
not retried within 7 days; `fetch-failed` retried after 24h; only
`transcripts_enabled` accounts are queried at all; live smoke against
a real tenant with a recently-ended, actually-transcribed meeting.

### T6 — MCP surface

- New tool `get_event_transcript(eventId, account?)`:
  - Returns
    ```ts
    {
      transcript: TranscriptRow | null,
      segments: TranscriptSegment[]
    }
    ```
  - `null` transcript + empty segments when none exists (not
    available, meeting not transcribed, sync hasn't run).
  - No steering applied (mirror `get_event`).
- Extend slice-5's `get_event` with optional `include_transcript:
  boolean` (default `false`); when `true`, the response gains a
  `linkedTranscript` field with the same shape as the dedicated
  tool's output. Lets a Claude conversation pull "the meeting + its
  chat + its transcript" in one call.

### T7 — FTS5 search

- New FTS5 table `transcript_segments_fts(text, content=...,
  content_rowid=...)` mirrored on `transcript_segments`, with
  `ai/ad/au` triggers consistent with `messages_fts`.
- Extend the existing `search` tool with an optional `kinds:
  ("message" | "transcript")[]` input. Default `["message"]` to
  preserve current behaviour.
- Steering: a separate predicate type for transcripts is **out of
  scope**; the carve-out for `get_event` extends to transcripts
  (transcripts attach to events, events have their own steering
  predicates).

## Cross-cutting decisions

- **Per-account opt-in, no global flag.** `transcripts_enabled` on
  `calendar_accounts`, set via `--transcripts-enable <account>` (T2).
  There is no `WALDO_TRANSCRIPTS_ENABLED` environment variable — see
  the overview's cross-cutting decisions for why a global gate would
  be redundant now that auth is per-account delegated, not tenant-wide
  app-only.
- **Status rows over silent absence.** Every transcript fetch attempt
  persists a row, even for `not-available` — so the user asking "why
  is there no transcript for this meeting" gets a diagnosable answer.
- **Metering cost is real and unbounded without a cap.** Past the
  ~600 free minutes/month/tenant/app, transcript content fetches cost
  ~$0.0022/minute (~$0.13 per meeting-hour). This plan does not impose
  its own spending cap — the 20-events-per-tick limit (T5) bounds
  *rate*, not *cost*, and a busy month of meetings across 2 accounts
  could exceed the free tier. The operator should link Azure billing
  deliberately (per the T2 setup doc) rather than be surprised by 402s;
  `quota-exhausted` status rows make it visible when the free tier is
  exhausted either way.
- **Transcript eligibility window (60 days).** Historical backfill
  cannot recover transcripts for old meetings — the Graph API stops
  working once a meeting expires. A user asking about a meeting from
  8 months ago will get calendar/event data (year of history) but
  never a transcript for it, even if one existed at the time. This is
  a hard Graph-side limitation, not a design choice this plan could
  relax.
- **Delegated token, no special blast-radius concern.** Unlike the
  original app-only design, the transcript token is scoped exactly
  like every other delegated Graph token this codebase already
  handles (same redaction pattern, same per-account refresh). No new
  credential class, no rotation runbook.
- **Storage policy.** Transcripts kept indefinitely alongside their
  event (FK cascade — deleting the event deletes the transcript).
  Operator can prune via SQL if tenant policy demands it.
- **No write paths.** As ever, MCP cannot create, edit, or delete a
  transcript.

## Open questions

1. **Resolved — delegated path confirmed.** Re-checked against
   [calltranscript-get](https://learn.microsoft.com/graph/api/calltranscript-get)
   on 2026-08-12: delegated `OnlineMeetingTranscript.Read.All` is the
   documented least-privileged permission and works for meeting
   attendees, not just organizers. T2 is a scope-addition slice, as
   originally hoped-for in this now-resolved question — no app-only
   auth client needed.
2. **Speaker email extraction from VTT.** Voice-tag formats vary
   across Teams versions. T4's FRAME records the canonical shape
   and the fallbacks.
3. **Per-meeting transcript multiplicity.** A recording-restart can
   produce multiple `transcript` rows for one meeting. T1's PK
   handles this, but the MCP tool default behavior (return all? the
   longest? the most recent?) needs a decision.
4. **Translation transcripts.** Teams Premium also surfaces
   translated variants. T4 fetches only the original; translations
   are an explicit non-goal.
5. **Exact tenant-admin toggles.** The calltranscript-get doc
   references "two independent tenant administrator settings" gating
   transcript access without naming them plainly in the excerpt
   fetched during this spec pass. T2's FRAME reads the doc's
   "Tenant administrator controls for transcript access" section in
   full and names the toggles in this doc before RED begins.

## Risks

- **Metering surprise.** A busy month could exceed the free tier and
  either 402 (no billing linked) or incur real cost (billing linked).
  Mitigation: `quota-exhausted` status rows are diagnosable via
  `get_event_transcript`; the setup doc calls out the cost model
  before the operator runs `--transcripts-enable`.
- **Expiration window surprise.** A user asking about an old meeting
  gets a `null` transcript with no indication that this is *expected*
  (too old) rather than *missing* (never transcribed). Mitigation:
  consider surfacing the eligibility window in `get_event_transcript`'s
  tool description so the calling Claude conversation can explain the
  distinction rather than imply the meeting simply wasn't recorded —
  pin the exact wording during T6's FRAME.
- **Privacy.** Transcripts contain everyone's words verbatim,
  including external attendees. Mitigation: read-only by design,
  steering predicates prune at retrieval time (via the event they
  attach to), the `/security-scan` skill explicitly looks for
  transcript-shaped fixtures in commits.

## Out-of-scope follow-ups

- Recording (video/audio) attachments — much bigger storage
  question, separate plan if ever.
- Translation transcripts.
- Speaker analytics ("who talked most", "interruption count") —
  derivable from the segments table if needed.
- Real-time transcript streaming during a live meeting.
- A configurable per-account transcript-eligibility window (currently
  a fixed 60-day constant) if 60 days ever proves wrong in practice.
