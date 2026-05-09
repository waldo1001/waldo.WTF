# Calendar — Optional follow-up: meeting transcripts

Parent: [calendar-overview.md](./calendar-overview.md). Hard
predecessor: [slice 4](./calendar-slice-4-sync-and-scope.md) (events
must already be in the lake). Strongly recommended:
[slice 5](./calendar-slice-5-meeting-chat-link.md) (so a transcript
joins to its meeting **and** its chat).

## Why this is a separate plan

Transcripts cross several lines the base feature deliberately does not:

- **Licensing.** Teams meeting transcripts are a **Teams Premium**
  feature. A transcript only exists if (a) the tenant has the
  license, and (b) the meeting was actually transcribed. Either
  condition failing means "no transcript" is the steady state, not
  an error.
- **Consent surface.** `OnlineMeetingTranscript.Read.All` is in
  practice an **application** permission, not delegated. Reading
  another user's meeting transcripts via delegated user creds is
  not supported (or is supported in narrow shapes that change). To
  consume it cleanly we'd run a parallel **app-only** auth path
  with **tenant admin consent**, which is structurally different
  from the existing delegated MSAL flow.
- **Data shape.** Transcripts come back as **VTT** (WebVTT) — a
  text format with timestamps and speaker tags. Storing them is
  fine, but searching them well wants a row-per-segment shape, not
  a single blob.
- **Volume.** A one-hour transcribed meeting is several hundred KB.
  At one-meeting-a-day across four accounts that's still small
  (~tens of MB / year), but it's bigger per item than messages and
  events.

Putting all of that behind a single plan that owns the licensing
gate, the parallel auth, the parser, and the storage shape keeps
the base feature's surface clean.

## Task

Sync, store, search, and surface meeting transcripts for online
meetings whose calendar events already live in the lake.

## High-level shape

```
              ┌─ events (slice 1)
              │
sync-tick ──► sync-transcripts ──► transcripts row + transcript_segments rows
              │     ▲
              │     │
              │     └── HttpTranscriptClient ── /me/onlineMeetings/{id}/transcripts
              │              │
              │              └── needs app-only token, scope OnlineMeetingTranscript.Read.All
              │
              └─ get_event(eventId) ──► linkedTranscript: { transcriptId, vttUrl, segments }
                                  ▲
                                  └── slice 5 already returns the event;
                                      this plan grows its return value
```

## Slicing

This follow-up itself is too big for one TDD cycle. Internal
slicing (still within this single plan file because the slices are
small and tightly bound):

| # | Sub-slice                               | What it lands |
|---|-----------------------------------------|---------------|
| T1 | Schema v18: `transcripts` + `transcript_segments`, `MessageStore` ops | tables, types, upsert/get readers |
| T2 | App-only auth path + scope            | second MSAL client (or client credentials flow), `Calendars.Read` admin consent doc, fixture-driven test |
| T3 | `TranscriptClient` seam + `FakeTranscriptClient` | interface, fake, no HTTP |
| T4 | `HttpTranscriptClient` + VTT parser   | Graph `/me/onlineMeetings/{id}/transcripts` + `/content`, VTT → segments |
| T5 | `syncTranscripts` job + scheduler tie-in | per-eligible-event walk, license-fail = silent skip, `sync_log` rows |
| T6 | `get_event_transcript(eventId)` MCP tool + extension of `get_event` | dedicated tool returning segments, optional `include_transcript` flag on `get_event` |
| T7 | FTS5 over transcript segments         | `transcript_segments_fts`, search integration |

T1 → T7 are sequential. T1 is mandatory; T2/T3 are sequential;
T4–T6 are sequential; T7 is optional (search adds real value but is
a strictly later add-on).

## Sub-slice details

### T1 — schema + store ops

- Schema bump v17 → v18 with two tables:
  ```sql
  CREATE TABLE transcripts (
    account TEXT NOT NULL,
    event_id TEXT NOT NULL,
    transcript_id TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    vtt_bytes INTEGER,        -- size of original VTT for diagnostics
    segment_count INTEGER NOT NULL,
    status TEXT NOT NULL,     -- 'ok' | 'license-missing' | 'fetch-failed'
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
  license-missing / fetch-failed cases, so we don't keep retrying.

**RED list highlights:** schema migration creates the tables
incl. cascade on `events`; upsert replaces segments; PK collision
across `(account, event_id, transcript_id)` correctly disambiguated;
status transitions persisted.

### T2 — app-only auth + admin consent

- New `src/auth/app-only-auth-client.ts` — wraps MSAL
  `confidentialClientApplication` with a `getAppOnlyAccessToken(scope)`
  method. Loads the client cert (preferred) or client secret from
  env (`MS_APP_ONLY_CLIENT_ID`, `MS_TENANT_ID`,
  `MS_APP_ONLY_CERT_PATH` **or** `MS_APP_ONLY_CLIENT_SECRET`).
- Configuration is **per-tenant** (app-only is single-tenant by
  design). Document one-app-registration-per-tenant in
  [docs/setup.md](../../docs/setup.md).
- New consent runbook in [docs/setup.md](../../docs/setup.md):
  - Register a second Entra app (or extend the existing one with an
    app-only credential).
  - Grant `OnlineMeetingTranscript.Read.All` application scope.
  - Tenant admin consent URL.
  - `MS_APP_ONLY_*` env vars.
  - Explicit security note: an app-only token has **tenant-wide**
    transcript read across all users; this plan only fetches
    transcripts for events already in the lake (i.e. the user's own
    or events they were invited to), but the credential itself
    grants more. Operator must rotate the cert on incident.
- Test seam: an `AppOnlyAuthClient` interface plus
  `FakeAppOnlyAuthClient` for the rest of the plan. The real impl
  is exercised only in the live smoke at end of T5.

**RED list highlights:** fake hands out tokens deterministically;
real impl loads cert vs secret as appropriate; missing config
surfaces a clear error before the first sync tick.

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
  to fetch. App-only token in `Authorization`.
- `parseVtt(text): VttCue[]` — small, in-tree parser. Each cue:
  `{ sequence, startMs, endMs, speakerName, speakerEmail, text }`.
  Speaker is encoded in VTT as a `<v Name>` voice tag with email
  available in some tenants via the `<v.email>` extension; parser
  tolerates either.
- Error mapping mirrors `HttpCalendarClient`:
  - **403 / `meetingTranscriptDisabled` body** → `'license-missing'`
    (the most common failure; recorded as a status row, never
    retried).
  - **404** → meeting wasn't transcribed; same as license-missing
    behavior.
  - **401** → app-only token refresh + retry once.
  - **429 / 5xx** → backoff + retry per existing pattern.

**RED list highlights:** VTT parser handles cues with and without
speaker tag, with overlapping cues (Teams sometimes emits these),
with unicode; HTTP client maps 403 to license-missing; bearer
redaction in errors.

### T5 — `syncTranscripts` job + scheduler

- New `src/sync/sync-transcripts.ts`:
  - Per scheduler tick, query `events` for online-meeting events
    whose `end_at < clock.now()` (the meeting has actually ended,
    so a transcript could exist), with no `transcripts` row yet
    or a `status='fetch-failed'` row from more than 24h ago.
  - Cap to 20 events per tick to bound runtime.
  - For each: list transcripts, fetch content, parse, upsert via
    T1 ops. Persist `status='ok'` or `status='license-missing'` /
    `'fetch-failed'`.
- Schedule wiring: gated by `WALDO_TRANSCRIPTS_ENABLED=1`. Default
  off — the licensing gate means most tenants will get nothing
  back, and we don't want noisy `sync_log` rows on tenants that
  don't have the feature.
- `sync_log` rows: `source='transcripts'`, status `ok` / `error`,
  with `messages_added` set to **transcript count** (not segment
  count) for this tick.

**RED list highlights:** per-tick cap; status transitions persisted;
license-missing event is **not** retried for at least 7 days;
disabled-by-default; live smoke in a Premium-licensed tenant.

### T6 — MCP surface

- New tool `get_event_transcript(eventId, account?)`:
  - Returns
    ```ts
    {
      transcript: TranscriptRow | null,
      segments: TranscriptSegment[]
    }
    ```
  - `null` transcript + empty segments when none exists (license
    missing, meeting not transcribed, sync hasn't run).
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

- **Default off.** `WALDO_TRANSCRIPTS_ENABLED` is `0` until the
  operator opts in.
- **Status rows over silent absence.** Every transcript fetch
  attempt persists a row, even for license-missing — so the user
  asking "why is there no transcript for this meeting" gets a
  diagnosable answer.
- **App-only token blast radius.** The credential reads transcripts
  tenant-wide. Cert preferred over secret; rotation runbook required
  in [docs/setup.md](../../docs/setup.md). The lake never logs the
  token; the existing redaction pattern applies.
- **Storage policy.** Transcripts kept indefinitely alongside their
  event (FK cascade — deleting the event deletes the transcript).
  Operator can prune via SQL if tenant policy demands it.
- **No write paths.** As ever, MCP cannot create, edit, or delete a
  transcript.

## Open questions

1. **Delegated path.** Microsoft has historically rotated the
   delegated-vs-application requirement on
   `OnlineMeetingTranscript.Read.All`. T2's FRAME re-checks the
   doc; if delegated works, the second auth path collapses and T2
   becomes a one-test scope-addition slice.
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

## Risks

- **License regression.** A tenant downgrades, and our cached
  transcripts go stale. Mitigation: `fetched_at` is on every row;
  the diagnose tool can flag transcripts older than `clock.now() -
  90d` if we ever need that.
- **Auth drift.** App-only credentials silently expire (cert) or
  are rotated by an admin (secret). Mitigation: fail-loud auth
  errors persist a `sync_log` row with `error_class='auth'` so
  `diagnose_sync_health` surfaces it.
- **Privacy.** Transcripts contain everyone's words verbatim,
  including external attendees. Mitigation: read-only by design,
  steering predicates prune at retrieval time, the
  `/security-scan` skill explicitly looks for transcript-shaped
  fixtures in commits.

## Out-of-scope follow-ups

- Recording (video/audio) attachments — much bigger storage
  question, separate plan if ever.
- Translation transcripts.
- Speaker analytics ("who talked most", "interruption count") —
  derivable from the segments table if needed.
- Real-time transcript streaming during a live meeting.
- Per-meeting opt-in/opt-out for transcript fetching beyond the
  global `WALDO_TRANSCRIPTS_ENABLED` flag.
