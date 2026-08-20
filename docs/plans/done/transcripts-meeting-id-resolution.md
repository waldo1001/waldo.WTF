# Transcripts fix — resolve the real onlineMeeting id from joinUrl

**Status:** spec approved-pending-review, not yet implemented.
**Severity:** the transcripts feature (T1–T7, shipped 2026-08-12) is
effectively dead in production — it has never fetched a transcript and,
as built, almost never can. Calendar sync itself is fine.

## Root cause (verified 2026-08-20, production lake + Microsoft Learn)

Three findings, each confirmed against the live lake on `waldomacmini1`
and current Microsoft Graph docs — not inferred:

1. **`events.online_meeting_id` holds the wrong identifier.**
   `mapGraphEventToCalendarEvent` ([src/sources/calendar.ts:147](../../../src/sources/calendar.ts))
   populates it from `onlineMeeting.conferenceId` in the calendarView
   payload. Production data shows that field is (a) almost never present
   — 9 of 1,264 ifacto events — and (b) when present, it is the
   **audio-conferencing dial-in id** (short numeric: `713055563`,
   `304603547`, …), NOT an onlineMeeting resource id (long base64,
   `MSp…`). Passing it to
   `GET /me/onlineMeetings/{id}/transcripts` can only 404 — which is
   exactly what produced the one `not-available` marker row in prod
   (event "Frontier Consultancy voor D365 F&O", 2026-07-02).

2. **The field that IS reliably populated is `onlineMeeting.joinUrl`.**
   Verified: 401 ifacto events carry `online_meeting_url`; the real
   transcript-candidate pool for the last 60 days is **44 meetings on
   ifacto + 2 on dynex**, vs the 1 the current id-based gate found.
   Graph documents an alternate-key lookup for exactly this
   ([onlinemeeting-get](https://learn.microsoft.com/graph/api/onlinemeeting-get?view=graph-rest-1.0),
   fetched 2026-08-20):

   ```http
   GET /me/onlineMeetings?$filter=JoinWebUrl eq '{joinWebUrl}'
   ```

   - Least-privileged **delegated** permission: `OnlineMeetings.Read`.
     Application permission is *not supported* on the `/me` variant.
   - Per the [permissions reference](https://learn.microsoft.com/graph/permissions-reference):
     `OnlineMeetings.Read` delegated → **AdminConsentRequired: No**.
     Re-consent is a plain per-user device-code re-run, no tenant admin.
   - Doc notes: *"joinWebUrl must be URL encoded"* and *"The format of
     joinWebUrl might differ … These variations don't affect how
     joinWebUrl is used in the API"* — so the `?context=…`-suffixed URL
     we store is expected to match.
   - **Open question (docs are explicit only for the by-id variant):**
     the by-id GET "accept[s] both the organizer's and the invited
     attendee's user token"; the JoinWebUrl-filter variant carries no
     such sentence either way. Worst case, resolution works only for
     meetings the account organized. Resolved empirically in R4's live
     probe; the design below degrades gracefully either way.

3. **Bonus casualty of the same sparse `onlineMeeting` object:
   `chat_id`.** Slice 5's meeting-chat join reads
   `onlineMeeting.chatInfo.threadId`, which is as absent as
   `conferenceId`: **470 events have a joinUrl but NULL `chat_id`**, so
   `get_event.linkedChat` is null for nearly every online meeting. The
   joinUrl itself embeds the thread id
   (`…/l/meetup-join/19%3ameeting_XXX%40thread.v2/0?...` →
   URL-decode → `19:meeting_XXX@thread.v2`), which is precisely the
   chat id shape Teams sync stores. Derivable with zero extra Graph
   calls.

## Design

### R1 — derive `chatId` from joinUrl (independent, no new scope)

`src/sources/calendar.ts`, in `mapGraphEventToCalendarEvent`:

```ts
// chatInfo.threadId is rarely present in calendarView payloads (verified
// in production: 470 of ~480 joinUrl-bearing events had no chatInfo).
// The joinUrl path segment IS the meeting-chat thread id, URL-encoded:
//   /l/meetup-join/19%3ameeting_XXX%40thread.v2/0?...
const chatId =
  onlineMeeting?.chatInfo?.threadId ??
  chatIdFromJoinUrl(onlineMeeting?.joinUrl);
```

New pure helper (exported for tests):

```ts
export function chatIdFromJoinUrl(joinUrl: string | undefined): string | undefined {
  if (joinUrl === undefined) return undefined;
  const m = /\/l\/meetup-join\/([^/?]+)/.exec(joinUrl);
  if (m === null) return undefined;
  try {
    const decoded = decodeURIComponent(m[1]!);
    return decoded.startsWith("19:") ? decoded : undefined;
  } catch {
    return undefined;
  }
}
```

RED list:
- decodes a real-shaped joinUrl to `19:meeting_XXX@thread.v2`
- explicit `chatInfo.threadId` wins over derivation when both present
- non-meetup-join URL → undefined; malformed %-encoding → undefined
  (no throw); undefined joinUrl → undefined
- decoded value not starting `19:` → undefined
- `mapGraphEventToCalendarEvent` end-to-end: event with joinUrl and no
  chatInfo gets a chatId

### R2 — scope + `resolveOnlineMeetingId` on the client seam

- `src/auth/msal-auth-client.ts`:
  `TRANSCRIPT_SCOPES = ["OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"] as const;`
  (`--transcripts-enable` and the scheduler's consent-hint string pick
  this up with no further change; CLI consent-failure message keeps
  working via `TRANSCRIPT_SCOPES.join(", ")`.)
- `src/sources/transcript.ts` — extend the interface:

  ```ts
  resolveOnlineMeetingId(account: string, joinWebUrl: string): Promise<string | null>;
  ```

  `null` = Graph returned an empty value set / 404 (meeting expired, or
  not visible to this account). Errors keep the existing taxonomy.
- `src/sources/http-transcript-client.ts`:
  - New scope constant `RESOLVE_SCOPE = "OnlineMeetings.Read"`. The
    existing `#getAccessToken(account, scope, forceRefresh)` callback
    is called with `RESOLVE_SCOPE` for resolution and the existing
    transcript scope for list/content — MSAL mints per-scope tokens
    from the same refresh token; do NOT merge into one request.
  - `GET {baseUrl}/me/onlineMeetings?$filter=JoinWebUrl eq '{url}'`
    with the joinUrl single-quote-escaped (`'` → `''`) and the whole
    filter value `encodeURIComponent`-ed (doc: "joinWebUrl must be URL
    encoded").
  - Response: `value[0]?.id ?? null`; empty array → null; 404 → null.
    401 → force-refresh retry once; 429/5xx → existing backoff; consent
    errors propagate untouched (scheduler already renders the hint).
  - Bearer redaction + ≤200-char body truncation identical to the
    existing methods — copy the shape, don't re-derive it.
- `src/testing/fake-transcript-client.ts`: fixtures gain
  `meetingIdByJoinUrl: Record<string, string | null>`; unknown URL
  throws `UnknownTranscriptMeetingError` (loop-bug canary, mirrors the
  existing convention); calls recorded with `{method:
  "resolveOnlineMeetingId", account, joinWebUrl}`.

RED list: happy path returns id; empty value-set → null; 404 → null;
401 retry-once (second token forced); 429 maps to
`GraphRateLimitedError`; consent-shaped 4xx propagates; filter is
correctly encoded (assert on the fake fetch's URL — kills the
encodeURIComponent mutant); bearer never in thrown messages.

### R3 — sync job switches to joinUrl eligibility

`src/sync/sync-transcripts.ts`:

- Candidate gate becomes `event.onlineMeetingUrl !== undefined`
  (`onlineMeetingId` is no longer read anywhere in the transcripts
  path — the column stays, documented as the dial-in id, wrong for
  this API).
- Per eligible event, before listing:

  ```ts
  const meetingId = await transcripts.resolveOnlineMeetingId(
    account.username, event.onlineMeetingUrl!);
  if (meetingId === null) {
    await store.markTranscriptStatus({ …, transcriptId: NO_TRANSCRIPT_FOUND_MARKER },
      "not-available", now);   // never retried — same policy as "zero transcripts"
    continue;
  }
  ```

  then `listTranscripts(account.username, meetingId)` /
  `fetchVttContent(account.username, meetingId, handle)` exactly as
  today. Consent errors from resolution rethrow (same
  `isConsentRequiredError` guard already on the other two call sites).
- Retry/cooldown policy, 20-events/tick cap, marker semantics: all
  unchanged. First healthy sweep will work through the ~46-candidate
  backlog in ~3 ticks; content fetches are the metered part
  (~600 free min/month/tenant) — a burst of 402s would surface as
  `quota-exhausted` rows with the existing ≥7-day retry, acceptable.

RED list: eligibility now selects joinUrl-bearing events (id-less event
IS a candidate; url-less event is NOT); resolution-null → marker row +
no list call; resolution feeds the returned id (not the stored column)
into list/fetch — pin with a fixture where the stored
`online_meeting_id` differs from the resolved id and assert the fake
saw the resolved one (kills the regression this whole plan exists for);
consent error from resolve propagates and writes no marker;
scheduler-level test updated for the new fake fixture shape.

### R4 — remediation migrations + ops rollout

Two registered one-shots under `docs/migrations/` (run via
`/deploy-local --migrate <name>`, writer stopped, lake snapshotted):

1. `clear-bogus-transcript-markers` — `DELETE FROM transcripts WHERE
   transcript_id = '__no-transcript-found__';` (markers written via the
   dial-in-id 404s are lies; segments FK-cascade is irrelevant, marker
   rows have none). Re-check then happens organically per tick.
2. `backfill-chat-id-from-join-url` — for rows `WHERE chat_id IS NULL
   AND online_meeting_url IS NOT NULL`, set `chat_id =
   chatIdFromJoinUrl(online_meeting_url)` (node one-shot importing the
   R1 helper; report updated/skipped counts).

Rollout order: deploy code → run both migrations → **user re-runs
`--transcripts-enable` for `WAUTERI@ifacto.be` and
`eric.wauters@dynex.be`** (device-code; adds `OnlineMeetings.Read`; no
admin consent — verified above) → live probe: one-shot script resolves
two joinUrls, one self-organized meeting + one organized by someone
else (e.g. "Distri update meeting", organizer Timmy Mesotten), and
records whether attendee-resolution works (answers the open question;
log result in the changelog) → watch two sync ticks and confirm
`transcripts` rows with `status='ok'` + segments land.

Until re-consent happens, resolution calls fail consent-shaped →
scheduler writes the existing "Transcript scope not consented" hint
row once per tick per account. Acceptable interim state; no code guard
needed.

## Out of scope

- Constructing onlineMeeting ids from organizer OID + thread id
  (undocumented format, fragile — rejected).
- App-only access policies, `/users/{id}` variants (delegated-only
  posture stands).
- Widening the 60-day eligibility window (bounded by Teams' own
  meeting-expiration; unrecoverable regardless).
- Repurposing/removing `events.online_meeting_id` (kept, documented as
  dial-in id).

## Risks

- **JoinWebUrl filter may be organizer-only** → attendee meetings
  resolve null → marked `not-available`. Feature still works for
  self-organized meetings; probe in R4 tells us which world we're in
  before we conclude anything about coverage.
- **Stored URL ≠ Graph's canonical JoinWebUrl** → docs explicitly say
  variations are tolerated; probe verifies with real data.
- **Metered-quota burst** on the first backlog sweep → existing
  `quota-exhausted` status + 7-day cooldown absorbs it.
- **chat_id derivation wrong for exotic URLs** (live events, external
  tenants) → helper returns undefined on anything not decoding to
  `19:…`; worst case is status quo (null chat_id).

## Definition of done

Per-slice `/tdd-cycle` (RED → GREEN → COVER ≥90% → MUTATE ≥80% →
security-scan → docs-update), then the R4 rollout executed on
`waldomacmini1` with a transcript actually fetched (or the
organizer-only limitation documented with probe evidence if zero
candidates carry transcripts).
