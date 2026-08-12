import type { Clock } from "../../clock.js";
import type { MessageStore } from "../../store/message-store.js";
import type { CalendarEvent, EventAttendee, Message } from "../../store/types.js";
import { fetchLinkedTranscript, type GetEventTranscriptResult } from "./get-event-transcript.js";
import { InvalidParamsError } from "./get-recent-activity.js";
import { resolveEvent } from "./resolve-event.js";

const LINKED_CHAT_MESSAGE_LIMIT = 50;

export interface GetEventParams {
  readonly event_id: string;
  readonly account?: string;
  readonly include_transcript?: boolean;
}

export interface GetEventLinkedChat {
  readonly chatId: string;
  readonly messages: readonly Message[];
}

export interface GetEventResult {
  readonly event: CalendarEvent | null;
  readonly attendees: readonly EventAttendee[];
  readonly linkedChat: GetEventLinkedChat | null;
  readonly linkedTranscript?: GetEventTranscriptResult;
}

export const GET_EVENT_TOOL = {
  name: "get_event",
  description: [
    "Return a single calendar event by id, with its attendees and — for online meetings — the linked Teams meeting-chat messages (last 50). Pass the `eventId` from a prior `find_events` result.",
    "",
    "If the event is not found (or `account` was omitted and no account has it), `event` is null — not an error.",
    "",
    "For an in-person meeting (no online-meeting chat), `linkedChat` is null. For an online meeting whose chat sync hasn't run yet, `linkedChat.messages` is an empty array, not an error.",
    "",
    "Steering rules are NOT applied here — neither to the event itself nor to `linkedChat.messages` — mirrors `get_thread`. If the user explicitly asks about a specific meeting, they want everything, including one they've muted via find_events/get_recent_activity, and messages from senders they've muted elsewhere.",
    "",
    "Pass `include_transcript: true` to also get `linkedTranscript` (same shape as the dedicated get_event_transcript tool) in one call — useful when the user wants the meeting, its chat, and its transcript together. Omitted field means the field is absent from the response, not null.",
    "",
    "`account` is optional and only required when the same `eventId` exists under more than one signed-in account (e.g. a guest invite in another tenant) — omitting it in that case returns an error asking you to pass it.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      event_id: {
        type: "string",
        minLength: 1,
        description: "Opaque event id. Take it from a prior find_events result.",
      },
      account: {
        type: "string",
        description:
          "Disambiguates when the same event_id exists under multiple accounts. Usually omit this.",
      },
      include_transcript: {
        type: "boolean",
        description:
          "When true, also fetch the meeting transcript into linkedTranscript. Default false.",
      },
    },
    required: ["event_id"],
    additionalProperties: false,
  },
} as const;

export async function handleGetEvent(
  store: MessageStore,
  _clock: Clock,
  params: GetEventParams,
): Promise<GetEventResult> {
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

  if (event === null) {
    return { event: null, attendees: [], linkedChat: null };
  }

  let linkedChat: GetEventLinkedChat | null = null;
  if (event.chatId !== undefined) {
    const messages = await store.getThread({
      threadId: event.chatId,
      limit: LINKED_CHAT_MESSAGE_LIMIT,
    });
    linkedChat = { chatId: event.chatId, messages };
  }

  return {
    event,
    attendees: event.attendees,
    linkedChat,
    ...(params.include_transcript === true && {
      linkedTranscript: await fetchLinkedTranscript(store, event),
    }),
  };
}
