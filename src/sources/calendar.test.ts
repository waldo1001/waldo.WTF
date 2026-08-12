import { describe, expect, it } from "vitest";
import {
  mapGraphEventToCalendarEvent,
  type CalendarClient,
  type CalendarViewDeltaPage,
  type GraphCalendarEvent,
} from "./calendar.js";

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

describe("mapGraphEventToCalendarEvent", () => {
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
