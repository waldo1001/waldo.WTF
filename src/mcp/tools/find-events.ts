import type { Clock } from "../../clock.js";
import type { MessageStore } from "../../store/message-store.js";
import type { CalendarEvent } from "../../store/types.js";
import { InvalidParamsError } from "./get-recent-activity.js";

const DEFAULT_WINDOW_DAYS = 7;
const MAX_UNFILTERED_WINDOW_DAYS = 92;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 250;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FindEventsParams {
  readonly from?: string;
  readonly to?: string;
  readonly accounts?: readonly string[];
  readonly subject_contains?: string;
  readonly attendee?: string;
  readonly order?: "asc" | "desc";
  readonly limit?: number;
  readonly include_muted?: boolean;
}

export interface FindEventsResult {
  readonly events: readonly CalendarEvent[];
  readonly truncated: boolean;
  readonly muted_count: number;
  readonly steering_hint?: string;
}

export const FIND_EVENTS_TOOL = {
  name: "find_events",
  description: [
    "Find calendar/agenda events — meetings, appointments, upcoming plans. Covers both forward-looking agenda questions (\"what's on my plate this week\", \"what's upcoming\") and history questions over up to a year of synced events (\"did I already plan this\", \"when is the meeting about X\", \"when did we meet about Y\").",
    "",
    "Default window is the next 7 days (agenda mode). Pass `subject_contains` and/or `attendee` to search history — those filters lift the normal 92-day window cap, so you can search the full synced range without a full dump.",
    "",
    "For history questions (\"when did we meet about X\"), pass `order: \"desc\"` so the most recent match comes first. For agenda questions (\"what's next\"), leave `order` at the default `\"asc\"`.",
    "",
    "If `truncated: true` comes back, there were more matches than shown — narrow the window or make `subject_contains` more specific rather than assuming completeness.",
    "",
    "Events matching an event-targeted steering rule (organizer or subject) are hidden by default, same as get_recent_activity and search hide muted messages. Pass include_muted=true to see them, or call get_steering to review active rules.",
    "",
    "Prefer this over `search` or `get_recent_activity` for anything about a meeting, appointment, or planned event.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description: "ISO datetime. Default: now. May lie in the past for history queries.",
      },
      to: {
        type: "string",
        description: "ISO datetime. Default: from + 7 days.",
      },
      accounts: {
        type: "array",
        items: { type: "string" },
        description: "Restrict to these accounts. Default: all known accounts.",
      },
      subject_contains: {
        type: "string",
        description:
          "Case-insensitive substring match on the event subject. Setting this lifts the 92-day unfiltered-window cap.",
      },
      attendee: {
        type: "string",
        description:
          "Case-insensitive substring match on attendee display name, attendee email, or organizer name/email. Setting this lifts the 92-day unfiltered-window cap.",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Order by start time. Default asc (agenda). Use desc for history questions.",
      },
      limit: {
        type: "number",
        exclusiveMinimum: 0,
        maximum: MAX_LIMIT,
        description: `Max events to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
      },
      include_muted: {
        type: "boolean",
        description:
          "If true, include events matching event-targeted steering rules. Default false (hard-exclude muted events).",
      },
    },
    additionalProperties: false,
  },
} as const;

export async function handleFindEvents(
  store: MessageStore,
  clock: Clock,
  params: FindEventsParams,
): Promise<FindEventsResult> {
  const from = params.from !== undefined ? new Date(params.from) : clock.now();
  const to =
    params.to !== undefined
      ? new Date(params.to)
      : new Date(from.getTime() + DEFAULT_WINDOW_DAYS * DAY_MS);

  if (!(to.getTime() > from.getTime())) {
    throw new InvalidParamsError("to must be after from");
  }

  const hasFilter =
    params.subject_contains !== undefined || params.attendee !== undefined;
  if (!hasFilter) {
    const windowMs = to.getTime() - from.getTime();
    if (windowMs > MAX_UNFILTERED_WINDOW_DAYS * DAY_MS) {
      throw new InvalidParamsError(
        `unfiltered window must be <= ${MAX_UNFILTERED_WINDOW_DAYS} days — add subject_contains or attendee to search a wider range`,
      );
    }
  }

  let limit = params.limit ?? DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    throw new InvalidParamsError("limit must be a positive number");
  }
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const order = params.order === "desc" ? "desc" : "asc";
  const includeMuted = params.include_muted === true;

  const result = await store.findEvents({
    from,
    to,
    ...(params.accounts !== undefined && { accounts: params.accounts }),
    ...(params.subject_contains !== undefined && {
      subjectContains: params.subject_contains,
    }),
    ...(params.attendee !== undefined && { attendee: params.attendee }),
    order,
    limit,
    includeMuted,
  });
  const hint =
    !includeMuted && result.mutedCount > 0
      ? `${result.mutedCount} event(s) hidden by steering rules. Pass include_muted=true to see them, or call get_steering to review active rules.`
      : undefined;
  return {
    events: result.events,
    truncated: result.truncated,
    muted_count: result.mutedCount,
    ...(hint !== undefined && { steering_hint: hint }),
  };
}
