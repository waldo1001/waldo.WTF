import { describe, expect, it } from "vitest";
import {
  chatIdFromJoinUrl,
  mapGraphEventToCalendarEvent,
  type CalendarClient,
  type CalendarViewDeltaPage,
  type GraphCalendarEvent,
} from "./calendar.js";

// Structure mirrors a real production calendarView payload — Graph gives a
// joinUrl but NO chatInfo on the vast majority of events (470 of ~480 in
// the live lake) — with every identifier replaced by a synthetic one.
const SAMPLE_JOIN_URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_U1lOVEhFVElDLUZJWFRVUkUtTk9ULVJFQUwtTUVFVElORw%40thread.v2/0?context=%7b%22Tid%22%3a%22ff451c7f-0000-0000-0000-000000000000%22%2c%22Oid%22%3a%2239f11b70-0000-0000-0000-000000000000%22%7d";
const SAMPLE_JOIN_URL_THREAD_ID =
  "19:meeting_U1lOVEhFVElDLUZJWFRVUkUtTk9ULVJFQUwtTUVFVElORw@thread.v2";

function graphEvent(
  overrides: Partial<GraphCalendarEvent> & Pick<GraphCalendarEvent, "id">,
): GraphCalendarEvent {
  return {
    start: { dateTime: "2026-04-13T10:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-04-13T11:00:00.0000000", timeZone: "UTC" },
    ...overrides,
  };
}

describe("CalendarClient interface", () => {
  it("CalendarClient interface accepts a CalendarViewDeltaInput and returns a page of already-lowered CalendarEvent rows", async () => {
    const page: CalendarViewDeltaPage = {
      events: [mapGraphEventToCalendarEvent(graphEvent({ id: "evt-1" }), "a@example.test")],
      removedIds: [],
      deltaLink: "https://graph.microsoft.com/delta-token-1",
    };
    const client: CalendarClient = {
      listCalendarViewDelta: async () => page,
    };
    const result = await client.listCalendarViewDelta({
      account: "a@example.test",
    });
    expect(result).toBe(page);
    expect(result.events[0]?.eventId).toBe("evt-1");
  });
});

describe("chatIdFromJoinUrl", () => {
  it("chatIdFromJoinUrl decodes the meetup-join segment to a Teams chat thread id", () => {
    expect(chatIdFromJoinUrl(SAMPLE_JOIN_URL)).toBe(SAMPLE_JOIN_URL_THREAD_ID);
  });

  it("chatIdFromJoinUrl returns undefined for a URL that is not a meetup-join link", () => {
    expect(
      chatIdFromJoinUrl("https://teams.microsoft.com/l/channel/19%3aabc/General"),
    ).toBeUndefined();
    expect(chatIdFromJoinUrl("https://example.test/nothing-to-see")).toBeUndefined();
  });

  it("chatIdFromJoinUrl returns undefined (does not throw) on malformed percent-encoding", () => {
    // A lone '%' is not valid percent-encoding — decodeURIComponent throws
    // URIError on it. The helper must swallow that, not crash a sync tick.
    expect(() =>
      chatIdFromJoinUrl("https://teams.microsoft.com/l/meetup-join/19%3ameeting_%zz/0"),
    ).not.toThrow();
    expect(
      chatIdFromJoinUrl("https://teams.microsoft.com/l/meetup-join/19%3ameeting_%zz/0"),
    ).toBeUndefined();
  });

  it("chatIdFromJoinUrl returns undefined when there is no joinUrl", () => {
    expect(chatIdFromJoinUrl(undefined)).toBeUndefined();
  });

  it("chatIdFromJoinUrl rejects a decoded segment that is not a 19: thread id", () => {
    // Guards against exotic join links (live events, external tenants)
    // silently producing a bogus chat_id that would never join to anything.
    expect(
      chatIdFromJoinUrl("https://teams.microsoft.com/l/meetup-join/broadcast%3aabc/0"),
    ).toBeUndefined();
  });
});

describe("mapGraphEventToCalendarEvent", () => {
  it("mapGraphEventToCalendarEvent derives chatId from joinUrl when Graph omits chatInfo (production shape)", () => {
    const result = mapGraphEventToCalendarEvent(
      graphEvent({
        id: "evt-no-chatinfo",
        onlineMeeting: { joinUrl: SAMPLE_JOIN_URL },
      }),
      "a@example.test",
    );
    expect(result.chatId).toBe(SAMPLE_JOIN_URL_THREAD_ID);
    expect(result.onlineMeetingUrl).toBe(SAMPLE_JOIN_URL);
  });

  it("mapGraphEventToCalendarEvent prefers an explicit chatInfo.threadId over deriving one from joinUrl", () => {
    const result = mapGraphEventToCalendarEvent(
      graphEvent({
        id: "evt-both",
        onlineMeeting: {
          joinUrl: SAMPLE_JOIN_URL,
          chatInfo: { threadId: "19:explicit-wins@thread.v2" },
        },
      }),
      "a@example.test",
    );
    expect(result.chatId).toBe("19:explicit-wins@thread.v2");
  });

  it("mapGraphEventToCalendarEvent lowers a typical event with attendees", () => {
    const g = graphEvent({
      id: "evt-1",
      subject: "Planning sync",
      organizer: {
        emailAddress: { name: "Eric Wauters", address: "Eric@Example.Test" },
      },
      attendees: [
        {
          emailAddress: { name: "Kristof", address: "Kristof@Example.Test" },
          status: { response: "accepted" },
        },
      ],
    });
    const result = mapGraphEventToCalendarEvent(g, "a@example.test", "tenant-1");
    expect(result.account).toBe("a@example.test");
    expect(result.eventId).toBe("evt-1");
    expect(result.tenantId).toBe("tenant-1");
    expect(result.subject).toBe("Planning sync");
    expect(result.organizerName).toBe("Eric Wauters");
    expect(result.organizerEmail).toBe("eric@example.test");
    expect(result.startAt.toISOString()).toBe("2026-04-13T10:00:00.000Z");
    expect(result.endAt.toISOString()).toBe("2026-04-13T11:00:00.000Z");
    expect(result.attendees).toHaveLength(2);
    const kristof = result.attendees.find((a) => a.email === "kristof@example.test");
    expect(kristof?.responseStatus).toBe("accepted");
    const organizer = result.attendees.find((a) => a.email === "eric@example.test");
    expect(organizer?.responseStatus).toBe("organizer");
    expect(organizer?.isOrganizer).toBe(true);
  });

  it("mapGraphEventToCalendarEvent extracts online meeting fields when present", () => {
    const g = graphEvent({
      id: "evt-online",
      onlineMeeting: {
        joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
        conferenceId: "123456789",
        chatInfo: { threadId: "19:meeting_abc@thread.v2" },
      },
    });
    const result = mapGraphEventToCalendarEvent(g, "a@example.test");
    expect(result.chatId).toBe("19:meeting_abc@thread.v2");
    expect(result.onlineMeetingUrl).toBe(
      "https://teams.microsoft.com/l/meetup-join/abc",
    );
    expect(result.onlineMeetingId).toBe("123456789");
  });

  it("mapGraphEventToCalendarEvent extracts joinUrl even when chatInfo is absent", () => {
    const g = graphEvent({
      id: "evt-no-chat",
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/xyz" },
    });
    const result = mapGraphEventToCalendarEvent(g, "a@example.test");
    expect(result.chatId).toBeUndefined();
    expect(result.onlineMeetingUrl).toBe(
      "https://teams.microsoft.com/l/meetup-join/xyz",
    );
  });

  it("mapGraphEventToCalendarEvent leaves online-meeting (and every other optional) field OMITTED, not undefined, for a bare in-person event", () => {
    // toStrictEqual (unlike toEqual) treats an explicit `key: undefined`
    // as different from the key being absent — this is what actually
    // proves the conditional spreads omit the key rather than merely
    // returning an undefined value for it.
    const nullMeeting = mapGraphEventToCalendarEvent(
      graphEvent({ id: "evt-null", onlineMeeting: null }),
      "a@example.test",
    );
    expect(nullMeeting).toStrictEqual({
      account: "a@example.test",
      eventId: "evt-null",
      startAt: new Date("2026-04-13T10:00:00.000Z"),
      endAt: new Date("2026-04-13T11:00:00.000Z"),
      isAllDay: false,
      isCancelled: false,
      rawJson: JSON.stringify(
        graphEvent({ id: "evt-null", onlineMeeting: null }),
      ),
      attendees: [],
    });

    const undefinedMeeting = mapGraphEventToCalendarEvent(
      graphEvent({ id: "evt-undef" }),
      "a@example.test",
    );
    expect(undefinedMeeting.chatId).toBeUndefined();
    expect(undefinedMeeting.onlineMeetingUrl).toBeUndefined();
    expect(undefinedMeeting.onlineMeetingId).toBeUndefined();
    expect(Object.keys(undefinedMeeting)).not.toEqual(
      expect.arrayContaining(["chatId", "onlineMeetingUrl", "onlineMeetingId"]),
    );
  });

  it("mapGraphEventToCalendarEvent surfaces cancellations", () => {
    const cancelled = mapGraphEventToCalendarEvent(
      graphEvent({ id: "evt-cancel", isCancelled: true }),
      "a@example.test",
    );
    expect(cancelled.isCancelled).toBe(true);

    const notCancelled = mapGraphEventToCalendarEvent(
      graphEvent({ id: "evt-ok", isCancelled: false }),
      "a@example.test",
    );
    expect(notCancelled.isCancelled).toBe(false);
  });

  it("mapGraphEventToCalendarEvent handles all-day events", () => {
    const singleDay = mapGraphEventToCalendarEvent(
      graphEvent({
        id: "evt-allday-1",
        isAllDay: true,
        start: { dateTime: "2026-04-13T00:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-04-14T00:00:00.0000000", timeZone: "UTC" },
      }),
      "a@example.test",
    );
    expect(singleDay.isAllDay).toBe(true);
    expect(singleDay.startAt.toISOString()).toBe("2026-04-13T00:00:00.000Z");
    expect(singleDay.endAt.toISOString()).toBe("2026-04-14T00:00:00.000Z");

    const multiDay = mapGraphEventToCalendarEvent(
      graphEvent({
        id: "evt-allday-3",
        isAllDay: true,
        start: { dateTime: "2026-04-13T00:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-04-16T00:00:00.0000000", timeZone: "UTC" },
      }),
      "a@example.test",
    );
    expect(multiDay.startAt.toISOString()).toBe("2026-04-13T00:00:00.000Z");
    expect(multiDay.endAt.toISOString()).toBe("2026-04-16T00:00:00.000Z");
  });

  it("mapGraphEventToCalendarEvent maps attendee response statuses and includes the organizer", () => {
    const g = graphEvent({
      id: "evt-statuses",
      organizer: {
        emailAddress: { name: "Eric", address: "eric@example.test" },
      },
      attendees: [
        {
          emailAddress: { name: "Accepted", address: "accepted@example.test" },
          status: { response: "accepted" },
        },
        {
          emailAddress: { name: "Tentative", address: "tentative@example.test" },
          status: { response: "tentativelyAccepted" },
        },
        {
          emailAddress: { name: "Declined", address: "declined@example.test" },
          status: { response: "declined" },
        },
        {
          emailAddress: { name: "NotResponded", address: "notresponded@example.test" },
          status: { response: "notResponded" },
        },
        {
          emailAddress: { name: "Weird", address: "weird@example.test" },
          status: { response: "somethingUnknown" },
        },
      ],
    });
    const result = mapGraphEventToCalendarEvent(g, "a@example.test");
    const byEmail = (email: string) =>
      result.attendees.find((a) => a.email === email);
    expect(byEmail("accepted@example.test")?.responseStatus).toBe("accepted");
    expect(byEmail("tentative@example.test")?.responseStatus).toBe("tentative");
    expect(byEmail("declined@example.test")?.responseStatus).toBe("declined");
    expect(byEmail("notresponded@example.test")?.responseStatus).toBe(
      "notResponded",
    );
    expect(byEmail("weird@example.test")?.responseStatus).toBe("none");
    expect(byEmail("eric@example.test")?.responseStatus).toBe("organizer");
    // organizer is not double-listed
    expect(result.attendees.filter((a) => a.email === "eric@example.test")).toHaveLength(1);
  });

  it("mapGraphEventToCalendarEvent lowers lastModifiedDateTime when present", () => {
    const withTimestamp = mapGraphEventToCalendarEvent(
      graphEvent({
        id: "evt-modified",
        lastModifiedDateTime: "2026-04-12T09:30:00.0000000Z",
      }),
      "a@example.test",
    );
    expect(withTimestamp.lastModifiedAt?.toISOString()).toBe(
      "2026-04-12T09:30:00.000Z",
    );

    const withoutTimestamp = mapGraphEventToCalendarEvent(
      graphEvent({ id: "evt-unmodified" }),
      "a@example.test",
    );
    expect(withoutTimestamp.lastModifiedAt).toBeUndefined();
  });

  it("mapGraphEventToCalendarEvent maps an attendee whose Graph status.response is literally 'organizer'", () => {
    // Graph sometimes includes the organizer's own row in `attendees[]`
    // with status.response already set to "organizer", not just via the
    // separate `organizer` field.
    const g = graphEvent({
      id: "evt-self-organizer-status",
      attendees: [
        {
          emailAddress: { address: "solo@example.test" },
          status: { response: "organizer" },
        },
      ],
    });
    const result = mapGraphEventToCalendarEvent(g, "a@example.test");
    expect(result.attendees.find((a) => a.email === "solo@example.test")?.responseStatus).toBe(
      "organizer",
    );
  });

  it("mapGraphEventToCalendarEvent does not double-list an organizer who is also in the attendees array", () => {
    const g = graphEvent({
      id: "evt-organizer-attendee",
      organizer: {
        emailAddress: { name: "Eric", address: "eric@example.test" },
      },
      attendees: [
        {
          emailAddress: { name: "Eric", address: "eric@example.test" },
          status: { response: "accepted" },
        },
      ],
    });
    const result = mapGraphEventToCalendarEvent(g, "a@example.test");
    expect(result.attendees).toHaveLength(1);
    expect(result.attendees[0]).toMatchObject({
      email: "eric@example.test",
      responseStatus: "organizer",
      isOrganizer: true,
    });
  });

  it("mapGraphEventToCalendarEvent dedupes two attendees with the same email — real Graph data does contain this (production incident: UNIQUE constraint failed on event_attendees)", () => {
    const g = graphEvent({
      id: "evt-dup-attendee",
      attendees: [
        {
          emailAddress: { name: "Kristof", address: "kristof@example.test" },
          status: { response: "accepted" },
        },
        {
          // Same person invited twice — e.g. once directly, once via a
          // distribution list Graph expanded — same address, possibly
          // different casing, and a different response status.
          emailAddress: { name: "Kristof P.", address: "Kristof@Example.TEST" },
          status: { response: "tentativelyAccepted" },
        },
      ],
    });
    const result = mapGraphEventToCalendarEvent(g, "a@example.test");
    expect(result.attendees).toHaveLength(1);
    expect(result.attendees.filter((a) => a.email === "kristof@example.test")).toHaveLength(1);
  });

  it("mapGraphEventToCalendarEvent keeps the LAST occurrence when the same attendee email repeats, mirroring the existing organizer-merge last-write semantics", () => {
    const g = graphEvent({
      id: "evt-dup-attendee-last-wins",
      attendees: [
        {
          emailAddress: { name: "Kristof (old)", address: "kristof@example.test" },
          status: { response: "declined" },
        },
        {
          emailAddress: { name: "Kristof (latest)", address: "kristof@example.test" },
          status: { response: "accepted" },
        },
      ],
    });
    const result = mapGraphEventToCalendarEvent(g, "a@example.test");
    expect(result.attendees).toHaveLength(1);
    expect(result.attendees[0]).toMatchObject({
      email: "kristof@example.test",
      displayName: "Kristof (latest)",
      responseStatus: "accepted",
    });
  });

  it("mapGraphEventToCalendarEvent omits subject when Graph sends it as null", () => {
    const result = mapGraphEventToCalendarEvent(
      graphEvent({ id: "evt-null-subject", subject: null }),
      "a@example.test",
    );
    expect(result.subject).toBeUndefined();
    expect(Object.keys(result)).not.toContain("subject");
  });

  it("mapGraphEventToCalendarEvent tolerates an organizer object with no emailAddress", () => {
    const result = mapGraphEventToCalendarEvent(
      graphEvent({ id: "evt-bare-organizer", organizer: {} }),
      "a@example.test",
    );
    expect(result.organizerEmail).toBeUndefined();
    expect(result.organizerName).toBeUndefined();
    expect(result.attendees).toEqual([]);
  });

  it("mapGraphEventToCalendarEvent lower-cases attendee and organizer email", () => {
    const g = graphEvent({
      id: "evt-casing",
      organizer: { emailAddress: { address: "ERIC@EXAMPLE.TEST" } },
      attendees: [{ emailAddress: { address: "Kristof@Example.Test" } }],
    });
    const result = mapGraphEventToCalendarEvent(g, "a@example.test");
    expect(result.organizerEmail).toBe("eric@example.test");
    expect(result.attendees.map((a) => a.email)).toEqual(
      expect.arrayContaining(["kristof@example.test", "eric@example.test"]),
    );
  });
});
