import type { Clock } from "../../clock.js";
import type { MessageStore } from "../../store/message-store.js";
import type { CalendarEvent, Transcript, TranscriptSegment } from "../../store/types.js";
import { InvalidParamsError } from "./get-recent-activity.js";
import { resolveEvent } from "./resolve-event.js";

export interface GetEventTranscriptParams {
  readonly event_id: string;
  readonly account?: string;
}

export interface GetEventTranscriptResult {
  readonly transcript: Transcript | null;
  readonly segments: readonly TranscriptSegment[];
}

export const GET_EVENT_TRANSCRIPT_TOOL = {
  name: "get_event_transcript",
  description: [
    "Return the meeting transcript for a calendar event, if one was fetched. Pass the `eventId` from a prior find_events/get_event result.",
    "",
    "`transcript` is null and `segments` is empty when no transcript exists yet — not an error. This covers several cases indistinguishably: the meeting wasn't transcribed, transcript sync hasn't run for this event yet, or the fetch failed/is quota-limited. Use get_sync_status or diagnose_sync_health to tell those apart if needed.",
    "",
    "Steering rules are NOT applied here — mirrors get_event. If the user explicitly asks about a specific meeting's transcript, they want it regardless of any mute rule.",
    "",
    "`account` is optional and only required when the same `eventId` exists under more than one signed-in account — omitting it in that case returns an error asking you to pass it.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      event_id: {
        type: "string",
        minLength: 1,
        description: "Opaque event id. Take it from a prior find_events or get_event result.",
      },
      account: {
        type: "string",
        description:
          "Disambiguates when the same event_id exists under multiple accounts. Usually omit this.",
      },
    },
    required: ["event_id"],
    additionalProperties: false,
  },
} as const;

const EMPTY_RESULT: GetEventTranscriptResult = { transcript: null, segments: [] };

// Shared with get_event's include_transcript option — takes an already
// resolved event (no param validation, no ambiguity handling) and picks
// the most-recently-fetched *successful* transcript for it. An event can
// accumulate multiple transcript rows (a recording restart can produce a
// second real transcript, or earlier attempts can have failed/been
// quota-limited) — only 'ok' rows are real content, and the newest one
// wins, mirroring sync-transcripts.ts's own "most recent attempt wins"
// policy.
export async function fetchLinkedTranscript(
  store: MessageStore,
  event: CalendarEvent,
): Promise<GetEventTranscriptResult> {
  const rows = await store.listTranscriptsForEvent(event.account, event.eventId);
  const okRows = rows.filter((r) => r.status === "ok");
  if (okRows.length === 0) return EMPTY_RESULT;
  const latest = [...okRows].sort(
    (a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime(),
  )[0]!;
  // getTranscriptByKey can't legitimately miss here — `latest` was just
  // read from the same table via listTranscriptsForEvent, and both read
  // the same account+eventId+transcriptId row.
  const got = await store.getTranscriptByKey({
    account: event.account,
    eventId: event.eventId,
    transcriptId: latest.transcriptId,
  });
  return got!;
}

export async function handleGetEventTranscript(
  store: MessageStore,
  _clock: Clock,
  params: GetEventTranscriptParams,
): Promise<GetEventTranscriptResult> {
  const eventId = params.event_id;
  if (typeof eventId !== "string" || eventId.length === 0) {
    throw new InvalidParamsError("event_id must be a non-empty string");
  }
  if (
    params.account !== undefined &&
    (typeof params.account !== "string" || params.account.length === 0)
  ) {
    throw new InvalidParamsError("account must be a non-empty string");
  }

  const event = await resolveEvent(store, eventId, params.account);
  if (event === null) return EMPTY_RESULT;

  return fetchLinkedTranscript(store, event);
}
