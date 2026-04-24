# Teams Channels — Phase 3: HTTP `TeamsChannelClient`

## Task

Implement the real HTTP client behind the Phase 2 `TeamsChannelClient`
interface. This is the *only* file in this slice allowed to touch
`fetch` and `graph.microsoft.com` URLs. No sync logic, no scheduler
wiring. After this slice the client is **usable but still unwired** —
Phase 4/5 will connect it.

Prerequisites: Phase 2 merged. Interface + fake + `syncTeamsChannels`
all green against the fake.

## Scope boundary

**IN:**
- `src/sources/http-teams-channel-client.ts` — real implementation.
- Delta endpoint: `/teams/{teamId}/channels/{channelId}/messages/delta?$expand=replies`.
- Discovery endpoints: `/me/joinedTeams` and `/teams/{id}/channels`
  (both paginated via `@odata.nextLink`). Exposed as `AsyncIterable`
  per the interface.
- HTTP error mapping: 401 → `TokenExpiredError`, 429 →
  `GraphRateLimitedError(retryAfterSeconds)`, non-2xx with body redacted
  of bearer.
- `Prefer: odata.maxpagesize` header following the chat client pattern
  ([http-teams-client.ts:65](../../src/sources/http-teams-client.ts#L65)).
- **Contract test**: `src/sources/__contract__/teams-channel-client.contract.ts`
  — shared suite run against fake + real (real client hits a `fetch`
  stub that returns canned responses). Keeps the fake honest.

**OUT:**
- Admin-consent error detection (that's not an HTTP error, it comes from
  MSAL at token-acquisition time — Phase 5).
- Reply-clip fallback to `GET /messages/{id}/replies` — deferred to
  observation.
- Private/shared-channel-specific code paths — same endpoints, no branch
  needed.

## Files to create / touch

**Create:**
- `src/sources/http-teams-channel-client.ts`
- `src/sources/http-teams-channel-client.test.ts`
- `src/sources/__contract__/teams-channel-client.contract.ts` (or inline
  the shared suite if there is no existing `__contract__/` directory —
  check repo convention; if absent, the fake's own test file asserts
  against the shared suite, like the existing `http-teams-client.test.ts`
  does).

**Touch:**
- None in `src/sync/` or `src/store/` — this is a pure seam impl.

## Seams involved

| Seam | Role |
|---|---|
| **http** | `FetchLike` injection ([http-graph-client.ts](../../src/sources/http-graph-client.ts)) |
| graph | parent error classes reused |
| store / clock / msal / fs / logger | untouched |

## Design

### Endpoints

```
GET /me/joinedTeams
    → { value: JoinedTeam[], "@odata.nextLink"? }
GET /teams/{teamId}/channels
    → { value: Channel[], "@odata.nextLink"? }
    (no Prefer page cap needed — teams rarely have >100 channels)
GET /teams/{teamId}/channels/{channelId}/messages/delta?$expand=replies&$filter=lastModifiedDateTime gt {sinceIso}
    → first run, with backfill window
GET {deltaLink}
    → subsequent runs (deltaLink is opaque)
GET {nextLink}
    → pagination within one run (nextLink is opaque)
```

Header on every call:
```
Authorization: Bearer <token>
Accept: application/json
Prefer: odata.maxpagesize=50
```

### Constructor

```ts
export interface HttpTeamsChannelClientOptions {
  readonly fetch: FetchLike;
  readonly baseUrl?: string;                  // default "https://graph.microsoft.com/v1.0"
  readonly preferMaxPageSize?: number;        // default 50
}

export class HttpTeamsChannelClient implements TeamsChannelClient { ... }
```

### Delta URL construction

First call: `${baseUrl}/teams/{encodedTeamId}/channels/{encodedChannelId}/messages/delta` with query params:
- `$expand=replies`
- `$filter=lastModifiedDateTime gt ${sinceIso}` — only when
  `opts.sinceIso !== undefined && opts.deltaLink === undefined &&
  opts.nextLink === undefined`.

Subsequent call with `{ deltaLink }` or `{ nextLink }`: use opaque URL
as-is.

### Pagination shape

`listJoinedTeams` and `listChannels` follow the standard Graph page
loop. Return as `AsyncIterable<T>` — matches the interface from Phase 2.

### Error handling

Copy the working pattern from
[http-teams-client.ts:69-84](../../src/sources/http-teams-client.ts#L69-L84)
verbatim. Specifically:
- `res.status === 401` → `throw new TokenExpiredError()`
- `res.status === 429` → parse `Retry-After`, default 60, throw
  `GraphRateLimitedError(seconds)`
- non-2xx → `Error` with `HTTP ${status}: ${body-slice-200-chars}` with
  bearer-string substitution to `[redacted]`.

### Admin-consent — **not** handled here

If the tenant has not consented to `ChannelMessage.Read.All`, MSAL
`acquireTokenSilent` with that scope rejects at **token-acquisition
time** with `interaction_required` / `consent_required` — never reaches
an HTTP call. That's Phase 5's concern. If somehow a token without the
scope makes it to Graph, the server returns 403 with an
`Authorization_RequestDenied` code. We map 403 to a plain non-2xx error
(same as the chat client) — the scheduler's per-sub catch will surface
it.

## RED test list (file: `src/sources/http-teams-channel-client.test.ts`)

```
- AC1: listJoinedTeams GETs /me/joinedTeams and yields all pages
  - test: "listJoinedTeams walks @odata.nextLink across pages"
  - seams: http (fetch stub)

- AC2: listChannels GETs /teams/{id}/channels and yields all pages
  - test: "listChannels walks pages for a given teamId"
  - seams: http

- AC3: listChannels URL-encodes teamId
  - test: "listChannels percent-encodes teamId with a URL-significant character"
  - seams: http
  - edge: teamId with ":" to assert encoding

- AC4: getChannelMessagesDelta first call builds /messages/delta?$expand=replies URL
  - test: "first call builds delta URL with $expand=replies"
  - seams: http
  - edge: no $filter when sinceIso undefined

- AC5: getChannelMessagesDelta first call with sinceIso adds $filter
  - test: "first call with sinceIso adds lastModifiedDateTime filter"
  - seams: http

- AC6: getChannelMessagesDelta with { deltaLink } uses the opaque URL verbatim
  - test: "subsequent call uses the provided deltaLink verbatim"
  - seams: http
  - edge: deltaLink is absolute URL, no base concatenation

- AC7: getChannelMessagesDelta with { nextLink } uses the opaque URL verbatim
  - test: "pagination uses nextLink verbatim"
  - seams: http

- AC8: 401 throws TokenExpiredError
  - test: "maps HTTP 401 to TokenExpiredError"
  - seams: http

- AC9: 429 throws GraphRateLimitedError with Retry-After seconds
  - test: "maps HTTP 429 to GraphRateLimitedError and reads Retry-After"
  - seams: http
  - edge: Retry-After absent → default 60

- AC10: non-2xx body redacts the bearer token
  - test: "redacts the bearer token from error bodies"
  - seams: http

- AC11: Prefer: odata.maxpagesize=50 sent on every call
  - test: "sends Prefer header with odata.maxpagesize on every request"
  - seams: http

- AC12: successful response parses @odata.deltaLink and @odata.nextLink
  - test: "exposes @odata.deltaLink and @odata.nextLink to caller"
  - seams: http

- AC13: URL encodes teamId AND channelId on delta calls
  - test: "percent-encodes teamId and channelId in the delta URL"
  - seams: http
  - edge: both values contain "/"
```

### Contract test (shared with fake)

```
- Fake and real must both satisfy:
  - nextLink drives pagination on both discovery methods
  - delta first-call signature (sinceIso → $filter, no sinceIso → no $filter)
  - deltaLink verbatim on subsequent calls
  - 401/429 error classes
```

## Open questions / assumptions

1. **Assumption**: delta on channels accepts `$filter=lastModifiedDateTime gt`
   on the initial call. If live smoke shows this is silently ignored
   (as it is on `/me/mailFolders/inbox/messages/delta`), we fall back
   to accepting a full first-sync backfill and rely on the
   `backfillDays` policy being a UX message rather than a server-side
   filter. Document result of smoke test in changelog.
2. **Assumption**: `$expand=replies` on a delta endpoint returns the
   full root-message payload + inline replies. If Graph chunks
   differently (e.g., top-level in one page, replies on another), we
   adjust mapping in Phase 2 code.
3. **Assumption**: delta token lifetime matches the 30-day window
   documented for other Graph delta endpoints. After 30 days of no
   sync, the token returns 410 Gone — we currently map that to a
   plain non-2xx error and let the per-sub catch log it. A manual
   `--teams-resubscribe` would be the fix. (Phase 5+)

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `$expand=replies` response shape differs from docs | Low-Medium | Contract test + live smoke; mapping tweak is isolated to Phase 2 |
| Graph server-side rate limiting tighter for channels than chats | Medium | 429 handling is already robust; scheduler backs off the whole pass |
| URL encoding bugs (team IDs can contain ":" via `@thread.tacv2`) | Low | AC3 + AC13 explicitly encode |
| 410 Gone on expired deltaLink | Low | Map to error, surface in perSubscription[].error; operator remediates via re-subscribe |

## Out-of-scope follow-ups

- [ ] Phase 4: CLI.
- [ ] Phase 5: scheduler wiring, scope acquisition, graceful degradation.
- [ ] Future: map 410 Gone → typed `DeltaLinkExpiredError` and auto-reset
      the `chat_cursors` row + re-bootstrap from `backfillDays`.
- [ ] Future: reply-clip fallback (`GET /replies`) if
      `teams_channel_reply_clipped` warning volume becomes meaningful.
