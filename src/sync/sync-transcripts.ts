import { isConsentRequiredError } from "../auth/msal-auth-client.js";
import type { Account } from "../auth/types.js";
import type { Clock } from "../clock.js";
import type { Logger } from "../logger.js";
import { parseVtt } from "../sources/http-transcript-client.js";
import {
  TranscriptApiDisabledError,
  TranscriptNotAvailableError,
  TranscriptQuotaExhaustedError,
  TranscriptSpeakerAttributionDisabledError,
  type TranscriptClient,
} from "../sources/transcript.js";
import type { MessageStore } from "../store/message-store.js";
import type { Transcript, TranscriptStatus } from "../store/types.js";

// A meeting from 8 months ago has calendar history (slice 1's 365-day
// backfill) but the transcript API stops working once a meeting expires
// past Teams' own retention window — this bound keeps the sync loop from
// attempting (and failing) hundreds of doomed fetches for old meetings on
// its very first tick. Not configurable — see the plan's "no per-account
// eligibility window" out-of-scope note.
export const TRANSCRIPT_ELIGIBILITY_DAYS = 60;
export const MAX_TRANSCRIPT_EVENTS_PER_TICK = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const QUOTA_RETRY_COOLDOWN_MS = 7 * DAY_MS;
const FETCH_FAILED_RETRY_COOLDOWN_MS = DAY_MS;

// transcripts.transcript_id is NOT NULL (it's part of the PK) — a
// status-only "checked, Graph reported zero transcripts for this meeting"
// marker row needs a placeholder id. This string can never collide with a
// real Graph-assigned transcript id (those are GUIDs).
export const NO_TRANSCRIPT_FOUND_MARKER = "__no-transcript-found__";

export interface SyncTranscriptsDeps {
  readonly account: Account;
  readonly store: MessageStore;
  readonly transcripts: TranscriptClient;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export interface SyncTranscriptsResult {
  readonly fetched: number;
}

// Every status but 'ok' gets its own cooldown before the sync loop
// re-checks a meeting; 'ok' never needs re-checking, and a genuinely new
// row (never checked before) is always eligible. When multiple rows exist
// for one event (e.g. a recording restart produced a second real
// transcript alongside an earlier failed one), the most recently
// fetched row governs — matches the "most recent attempt wins" policy an
// operator would expect from a per-event retry cooldown.
function isEligible(rows: readonly Transcript[], now: Date): boolean {
  if (rows.length === 0) return true;
  if (rows.some((r) => r.status === "ok")) return false;
  const latest = [...rows].sort(
    (a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime(),
  )[0]!;
  switch (latest.status) {
    // Mutation testing note: mutants that drop this `return false` or
    // change the case label are equivalent, not real gaps — the sole
    // call site (`if (!isEligible(...)) continue`) only checks
    // truthiness, and falling through the switch without a match
    // implicitly returns undefined, which is exactly as falsy as
    // `false` there.
    case "not-available":
      return false;
    case "quota-exhausted":
      return (
        now.getTime() - latest.fetchedAt.getTime() >= QUOTA_RETRY_COOLDOWN_MS
      );
    case "fetch-failed":
      return (
        now.getTime() - latest.fetchedAt.getTime() >=
        FETCH_FAILED_RETRY_COOLDOWN_MS
      );
    /* c8 ignore next 2 -- unreachable: the `some(status === "ok")` check above already returned */
    case "ok":
      return false;
  }
}

// Conditions that are about the tenant, not this meeting: recording them
// as a per-event status would be a lie, and `not-available` is never
// retried, so it would permanently poison every event checked while the
// toggle happened to be off. Propagate instead — the scheduler turns it
// into one actionable sync_log row per account per tick, and per-event
// state stays clean for a retry once an admin fixes the setting.
function isTenantTranscriptConfigError(err: unknown): boolean {
  return (
    err instanceof TranscriptApiDisabledError ||
    err instanceof TranscriptSpeakerAttributionDisabledError
  );
}

function statusForError(err: unknown): TranscriptStatus {
  if (err instanceof TranscriptQuotaExhaustedError) return "quota-exhausted";
  if (err instanceof TranscriptNotAvailableError) return "not-available";
  return "fetch-failed";
}

// Per-account sync tick: walk this account's online-meeting events that
// ended within the eligibility window, fetch+parse+store any transcript
// content Graph has for them, cap to MAX_TRANSCRIPT_EVENTS_PER_TICK per
// tick. Caller (the scheduler) is expected to gate this entirely on
// `calendar_accounts.transcripts_enabled` before calling — mirrors
// syncCalendarEvents, which likewise assumes its caller already checked
// `calendar_accounts.enabled`.
export async function syncTranscripts(
  deps: SyncTranscriptsDeps,
): Promise<SyncTranscriptsResult> {
  const { account, store, transcripts, clock, logger } = deps;
  const now = clock.now();

  // getEventsInRange's `end_at >= from` filter already guarantees every
  // candidate ended no earlier than `from` (both store implementations use
  // that exact bound, not an approximation) — so only the "hasn't ended
  // yet" side needs a JS-side re-check below; a redundant `endAt < from`
  // check would never be reachable.
  const from = new Date(now.getTime() - TRANSCRIPT_ELIGIBILITY_DAYS * DAY_MS);
  const candidates = await store.getEventsInRange(account.username, from, now);

  const eligibleEvents = [];
  for (const event of candidates) {
    // Gate on the joinUrl, NOT events.online_meeting_id: that column holds
    // Graph's `onlineMeeting.conferenceId` (the audio dial-in number),
    // which is absent on almost every event and 404s against the
    // transcript API when present. The joinUrl is reliably populated and
    // resolves to a real onlineMeeting id below.
    if (event.onlineMeetingUrl === undefined) continue;
    // A cancelled occurrence never happened, but Graph still returns the
    // recurring series' transcripts against it — which then shows up as
    // "what was said in the meeting that was called off". Skip it.
    if (event.isCancelled) continue;
    if (event.endAt.getTime() >= now.getTime()) continue;
    const rows = await store.listTranscriptsForEvent(
      account.username,
      event.eventId,
    );
    if (!isEligible(rows, now)) continue;
    eligibleEvents.push(event);
    if (eligibleEvents.length >= MAX_TRANSCRIPT_EVENTS_PER_TICK) break;
  }

  let fetched = 0;
  for (const event of eligibleEvents) {
    // calendarView never returns the onlineMeeting resource id, so trade
    // the joinUrl for one. A null means Graph matched no meeting (expired
    // past Teams' retention, or not visible to this account) — same
    // permanent "nothing here" as a meeting with zero transcripts.
    const onlineMeetingId = await transcripts.resolveOnlineMeetingId(
      account.username,
      event.onlineMeetingUrl!,
    );
    if (onlineMeetingId === null) {
      await store.markTranscriptStatus(
        {
          account: account.username,
          eventId: event.eventId,
          transcriptId: NO_TRANSCRIPT_FOUND_MARKER,
        },
        "not-available",
        now,
      );
      continue;
    }

    let handles;
    try {
      handles = await transcripts.listTranscripts(
        account.username,
        onlineMeetingId,
      );
    } catch (err) {
      if (isConsentRequiredError(err) || isTenantTranscriptConfigError(err)) {
        throw err;
      }
      await store.markTranscriptStatus(
        {
          account: account.username,
          eventId: event.eventId,
          transcriptId: NO_TRANSCRIPT_FOUND_MARKER,
        },
        statusForError(err),
        now,
      );
      logger?.info(
        `transcript_list_failed account=${account.username} event_id=${event.eventId}`,
      );
      continue;
    }

    if (handles.length === 0) {
      await store.markTranscriptStatus(
        {
          account: account.username,
          eventId: event.eventId,
          transcriptId: NO_TRANSCRIPT_FOUND_MARKER,
        },
        "not-available",
        now,
      );
      continue;
    }

    for (const handle of handles) {
      try {
        const { vtt } = await transcripts.fetchVttContent(
          account.username,
          onlineMeetingId,
          handle,
        );
        const cues = parseVtt(vtt);
        const transcript: Transcript = {
          account: account.username,
          eventId: event.eventId,
          transcriptId: handle.transcriptId,
          fetchedAt: now,
          vttBytes: vtt.length,
          segmentCount: cues.length,
          status: "ok",
        };
        await store.upsertTranscript({
          transcript,
          segments: cues.map((cue) => ({
            account: account.username,
            eventId: event.eventId,
            transcriptId: handle.transcriptId,
            sequence: cue.sequence,
            ...(cue.speakerEmail !== undefined && {
              speakerEmail: cue.speakerEmail,
            }),
            ...(cue.speakerName !== undefined && {
              speakerDisplayName: cue.speakerName,
            }),
            startOffsetMs: cue.startMs,
            endOffsetMs: cue.endMs,
            text: cue.text,
          })),
        });
        fetched++;
      } catch (err) {
        if (isConsentRequiredError(err) || isTenantTranscriptConfigError(err)) {
        throw err;
      }
        await store.markTranscriptStatus(
          {
            account: account.username,
            eventId: event.eventId,
            transcriptId: handle.transcriptId,
          },
          statusForError(err),
          now,
        );
        logger?.info(
          `transcript_content_fetch_failed account=${account.username} event_id=${event.eventId} transcript_id=${handle.transcriptId}`,
        );
      }
    }
  }

  return { fetched };
}
