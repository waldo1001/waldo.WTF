// Handle returned by listing a meeting's transcripts. `contentUrl` is
// whatever Graph gave us to fetch the VTT body from — HttpTranscriptClient
// (a later slice) decides whether to use it directly or construct
// `/onlineMeetings/{onlineMeetingId}/transcripts/{transcriptId}/content`
// itself; this seam doesn't require either strategy.
export interface TranscriptHandle {
  readonly transcriptId: string;
  readonly createdAt: string;
  readonly contentUrl?: string;
}

/**
 * Transcript client seam. Two methods: list a meeting's transcripts, then
 * fetch one's VTT content. Mirrors CalendarClient's shape (one seam, real
 * HTTP impl translates Graph errors, fakes throw directly) so the sync job
 * (a later slice) can be written generically.
 *
 * Both methods take `account` explicitly, separately from
 * `onlineMeetingId` — tokens are per-user-account, not per-meeting, so the
 * real HTTP implementation needs the account to resolve one (mirrors
 * `CalendarViewDeltaInput.account`, which exists for the identical reason).
 * `onlineMeetingId` identifies which meeting's transcripts to fetch —
 * that's what `GET /me/onlineMeetings/{onlineMeetingId}/transcripts`
 * actually takes, not `eventId`. **It is NOT
 * `events.online_meeting_id`**: that column holds Graph's
 * `onlineMeeting.conferenceId`, which is the audio dial-in number
 * (short, numeric) and 404s against this API. Callers get a real
 * onlineMeeting resource id from `resolveOnlineMeetingId` below.
 *
 * Error mapping is the real HTTP implementation's concern (a later slice):
 * 401 refreshes the token and retries once, 402 (the metered-content-fetch
 * limit) and 403/404 (not transcribed, API disabled, or the meeting has
 * expired) surface as distinct statuses the sync job can apply its own
 * per-status retry policy to, and 429 backs off like every other Graph
 * client in this codebase.
 */
export interface TranscriptClient {
  // Turns a calendar event's joinUrl into the onlineMeeting resource id
  // the transcript endpoints require, via Graph's documented alternate-key
  // lookup (`GET /me/onlineMeetings?$filter=JoinWebUrl eq '...'`,
  // delegated OnlineMeetings.Read). `null` means Graph matched no meeting
  // — expired past Teams' retention, or not visible to this account —
  // which is a normal answer, not an error.
  resolveOnlineMeetingId(
    account: string,
    joinWebUrl: string,
  ): Promise<string | null>;
  listTranscripts(
    account: string,
    onlineMeetingId: string,
  ): Promise<readonly TranscriptHandle[]>;
  fetchVttContent(
    account: string,
    onlineMeetingId: string,
    handle: TranscriptHandle,
  ): Promise<{ readonly vtt: string }>;
}

// The transcript *content* endpoint is metered (evaluation mode gives
// ~600 free minutes/month/tenant/app); past that Graph returns HTTP 402
// until an Azure subscription is linked for billing.
export class TranscriptQuotaExhaustedError extends Error {}

// The meeting was never transcribed, or it has expired past Teams'
// retention window — Graph maps both to 403/404 with no reliable way to
// tell them apart, so they collapse to one status. This is a permanent,
// per-meeting fact: the sync job records it and never retries.
export class TranscriptNotAvailableError extends Error {}

/**
 * Tenant-level transcript configuration errors.
 *
 * Both are 403s, but unlike TranscriptNotAvailableError they say nothing
 * about the individual meeting — they are an admin toggle that is off for
 * the whole tenant, and every meeting will 403 identically until it is
 * flipped. The sync job must therefore NOT record a per-event status for
 * them (a `not-available` row is never retried, so it would permanently
 * poison every meeting checked while the toggle happened to be off).
 * They propagate instead, surfacing as one actionable sync_log row per
 * account per tick — the same treatment consent failures get.
 *
 * Graph documents branching on `innerError.code`, not the message text,
 * because the messages are subject to change.
 */
export class TranscriptApiDisabledError extends Error {
  constructor() {
    super(
      "Graph API access to transcripts is disabled for this tenant — a Teams admin must enable it: Teams admin center > Meetings > Meeting settings > Transcript API access > Microsoft Graph access, or `Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess $true -Identity Global`. It is OFF by default and no app permission can override it.",
    );
  }
}

export class TranscriptSpeakerAttributionDisabledError extends Error {
  constructor() {
    super(
      "Speaker attribution is disabled for this tenant, so speaker-attributed transcripts (text/vtt) are refused — a Teams admin must enable it: Teams admin center > Meetings > Meeting settings > Transcript API access > Configure > Include speaker attribution, or `Set-CsTeamsMeetingConfiguration -EnableAttributedTranscripts $true -Identity Global`. It is OFF by default, separately from Graph access.",
    );
  }
}
