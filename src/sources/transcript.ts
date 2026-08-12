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
 * `onlineMeetingId` (from `events.online_meeting_id`, populated by
 * calendar slice 5) identifies which meeting's transcripts to fetch — that's
 * what `GET /me/onlineMeetings/{onlineMeetingId}/transcripts` actually takes,
 * not `eventId`.
 *
 * Error mapping is the real HTTP implementation's concern (a later slice):
 * 401 refreshes the token and retries once, 402 (the metered-content-fetch
 * limit) and 403/404 (not transcribed, API disabled, or the meeting has
 * expired) surface as distinct statuses the sync job can apply its own
 * per-status retry policy to, and 429 backs off like every other Graph
 * client in this codebase.
 */
export interface TranscriptClient {
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

// The meeting was never transcribed, the tenant/meeting has the transcript
// API disabled, or the meeting has expired past Teams' retention window —
// Graph maps all of these to 403/404 and there's no reliable way to tell
// them apart from the response alone, so they collapse to one status.
export class TranscriptNotAvailableError extends Error {}
