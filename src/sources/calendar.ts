import type { CalendarEvent, EventAttendee, EventResponseStatus } from "../store/types.js";

export interface GraphEmailAddress {
  readonly name?: string;
  readonly address?: string;
}

export interface GraphAttendee {
  readonly emailAddress?: GraphEmailAddress;
  readonly status?: { readonly response?: string };
  readonly type?: "required" | "optional" | "resource";
}

// Only the fields we lower. Graph's actual onlineMeeting shape has more
// (tollNumber, phones, ...) but nothing else feeds the lake — the full
// wire payload survives on events.raw_json for future readers.
export interface GraphOnlineMeetingInfo {
  readonly joinUrl?: string;
  readonly conferenceId?: string;
  readonly chatInfo?: { readonly threadId?: string };
}

// dateTime carries no offset in Graph's wire format — the timezone comes
// from the separate `timeZone` field. We always request UTC (Prefer:
// outlook.timezone="UTC", added in slice 3) so parseGraphDateTime can
// treat the string as already-UTC and just append the Z.
export interface GraphDateTimeZone {
  readonly dateTime: string;
  readonly timeZone?: string;
}

export interface GraphCalendarEvent {
  readonly id: string;
  readonly subject?: string | null;
  readonly organizer?: { readonly emailAddress?: GraphEmailAddress };
  readonly start: GraphDateTimeZone;
  readonly end: GraphDateTimeZone;
  readonly isAllDay?: boolean;
  readonly isCancelled?: boolean;
  readonly attendees?: readonly GraphAttendee[];
  readonly onlineMeeting?: GraphOnlineMeetingInfo | null;
  readonly lastModifiedDateTime?: string;
}

export interface CalendarViewDeltaInput {
  readonly account: string;
  readonly cursor?: string;
  readonly windowStartIso?: string;
  readonly windowEndIso?: string;
}

// `events` is already lowered — both FakeCalendarClient and
// HttpCalendarClient call mapGraphEventToCalendarEvent internally before
// returning a page, so every consumer downstream of CalendarClient only
// ever sees CalendarEvent, never the raw Graph wire shape.
export interface CalendarViewDeltaPage {
  readonly events: readonly CalendarEvent[];
  readonly removedIds: readonly string[];
  readonly nextLink?: string;
  readonly deltaLink?: string;
}

/**
 * Calendar client seam. One method: walk /me/calendarView/delta one page
 * at a time. Mirrors TeamsClient/TeamsChannelClient shape so slice 4's
 * sync loop can be written generically.
 *
 * Error mapping (real HTTP impl translates; fakes throw directly):
 * - HTTP 401 → TokenExpiredError
 * - HTTP 429 → GraphRateLimitedError
 * - HTTP 410 → DeltaTokenInvalidError
 */
export interface CalendarClient {
  listCalendarViewDelta(
    input: CalendarViewDeltaInput,
  ): Promise<CalendarViewDeltaPage>;
}

function parseGraphDateTime(dt: GraphDateTimeZone): Date {
  const iso = dt.dateTime.endsWith("Z") ? dt.dateTime : `${dt.dateTime}Z`;
  return new Date(iso);
}

// Graph's attendee status.response values don't match our EventResponseStatus
// literals 1:1 (Graph says "tentativelyAccepted", we say "tentative").
// Anything unrecognized falls back to "none" rather than throwing — a wire
// drift here shouldn't break sync.
function mapResponseStatus(response: string | undefined): EventResponseStatus {
  switch (response) {
    case "accepted":
      return "accepted";
    case "tentativelyAccepted":
      return "tentative";
    case "declined":
      return "declined";
    case "notResponded":
      return "notResponded";
    case "organizer":
      return "organizer";
    default:
      return "none";
  }
}

export function mapGraphEventToCalendarEvent(
  graphEvent: GraphCalendarEvent,
  account: string,
  tenantId?: string,
): CalendarEvent {
  const attendees: EventAttendee[] = (graphEvent.attendees ?? []).map((a) => {
    const email = (a.emailAddress?.address ?? "").toLowerCase();
    return {
      email,
      ...(a.emailAddress?.name !== undefined && {
        displayName: a.emailAddress.name,
      }),
      responseStatus: mapResponseStatus(a.status?.response),
    };
  });

  const organizerEmailRaw = graphEvent.organizer?.emailAddress?.address;
  const organizerEmail = organizerEmailRaw?.toLowerCase();
  if (organizerEmail !== undefined) {
    const existing = attendees.findIndex((a) => a.email === organizerEmail);
    const organizerAttendee: EventAttendee = {
      email: organizerEmail,
      ...(graphEvent.organizer?.emailAddress?.name !== undefined && {
        displayName: graphEvent.organizer.emailAddress.name,
      }),
      responseStatus: "organizer",
      isOrganizer: true,
    };
    if (existing >= 0) {
      attendees[existing] = organizerAttendee;
    } else {
      attendees.push(organizerAttendee);
    }
  }

  const onlineMeeting = graphEvent.onlineMeeting ?? undefined;
  const chatId = onlineMeeting?.chatInfo?.threadId;
  const onlineMeetingUrl = onlineMeeting?.joinUrl;
  const onlineMeetingId = onlineMeeting?.conferenceId;

  return {
    account,
    eventId: graphEvent.id,
    ...(tenantId !== undefined && { tenantId }),
    ...(graphEvent.subject !== null &&
      graphEvent.subject !== undefined && { subject: graphEvent.subject }),
    ...(graphEvent.organizer?.emailAddress?.name !== undefined && {
      organizerName: graphEvent.organizer.emailAddress.name,
    }),
    ...(organizerEmail !== undefined && { organizerEmail }),
    startAt: parseGraphDateTime(graphEvent.start),
    endAt: parseGraphDateTime(graphEvent.end),
    isAllDay: graphEvent.isAllDay === true,
    isCancelled: graphEvent.isCancelled === true,
    ...(chatId !== undefined && { chatId }),
    ...(onlineMeetingUrl !== undefined && { onlineMeetingUrl }),
    ...(onlineMeetingId !== undefined && { onlineMeetingId }),
    ...(graphEvent.lastModifiedDateTime !== undefined && {
      lastModifiedAt: new Date(graphEvent.lastModifiedDateTime),
    }),
    rawJson: JSON.stringify(graphEvent),
    attendees,
  };
}

export {
  DeltaTokenInvalidError,
  GraphRateLimitedError,
  TokenExpiredError,
} from "./graph.js";
