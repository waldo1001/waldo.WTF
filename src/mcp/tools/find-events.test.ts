import { describe, expect, it } from "vitest";
import { FakeClock } from "../../testing/fake-clock.js";
import { InMemoryMessageStore } from "../../testing/in-memory-message-store.js";
import { InMemorySteeringStore } from "../../testing/in-memory-steering-store.js";
import type { CalendarEvent } from "../../store/types.js";
import { InvalidParamsError } from "./get-recent-activity.js";
import {
  FIND_EVENTS_TOOL,
  handleFindEvents,
  type FindEventsParams,
} from "./find-events.js";

const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));

function event(
  overrides: Partial<CalendarEvent> & Pick<CalendarEvent, "eventId">,
): CalendarEvent {
  return {
    account: "a@example.test",
    startAt: new Date("2026-04-13T10:00:00Z"),
    endAt: new Date("2026-04-13T11:00:00Z"),
    isAllDay: false,
    isCancelled: false,
    attendees: [],
    ...overrides,
  };
}

describe("FIND_EVENTS_TOOL descriptor", () => {
  it("find_events description mentions calendar, agenda, meeting, and when-did-we-meet phrasing", () => {
    const d = FIND_EVENTS_TOOL.description;
    for (const term of [
      "calendar",
      "agenda",
      "meeting",
      "planned",
      "when did we meet",
      "upcoming",
      "appointment",
    ]) {
      expect(d.toLowerCase()).toContain(term.toLowerCase());
    }
  });

  it("has no required fields — every param is optional", () => {
    expect(FIND_EVENTS_TOOL.inputSchema.required).toBeUndefined();
  });
});

describe("handleFindEvents", () => {
  it("find_events defaults to a 7-day window from now", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({
        eventId: "evt-in-window",
        startAt: new Date("2026-04-14T00:00:00Z"),
        endAt: new Date("2026-04-14T01:00:00Z"),
      }),
      event({
        eventId: "evt-out-of-window",
        startAt: new Date("2026-05-01T00:00:00Z"),
        endAt: new Date("2026-05-01T01:00:00Z"),
      }),
    ]);
    const result = await handleFindEvents(store, clock, {});
    expect(result.events.map((e) => e.eventId)).toEqual(["evt-in-window"]);
  });

  it("respects an explicit from with the default 7-day to", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({
        eventId: "evt-later",
        startAt: new Date("2026-04-18T00:00:00Z"),
        endAt: new Date("2026-04-18T01:00:00Z"),
      }),
    ]);
    const result = await handleFindEvents(store, clock, {
      from: "2026-04-17T00:00:00Z",
    });
    expect(result.events.map((e) => e.eventId)).toEqual(["evt-later"]);
  });

  it("find_events rejects to <= from with InvalidParams", async () => {
    const store = new InMemoryMessageStore();
    for (const [from, to] of [
      ["2026-04-13T10:00:00Z", "2026-04-13T10:00:00Z"],
      ["2026-04-13T10:00:00Z", "2026-04-13T09:00:00Z"],
      ["2026-04-13T10:00:00.001Z", "2026-04-13T10:00:00.000Z"],
    ]) {
      await expect(
        handleFindEvents(store, clock, { from, to }),
      ).rejects.toBeInstanceOf(InvalidParamsError);
    }
  });

  it("find_events rejects windows wider than a quarter when no filter is set", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleFindEvents(store, clock, {
        from: "2026-01-01T00:00:00Z",
        to: "2026-04-04T00:00:00Z", // 93 days
      }),
    ).rejects.toThrow(/92 days/);

    // exactly 92 days is allowed
    await expect(
      handleFindEvents(store, clock, {
        from: "2026-01-01T00:00:00Z",
        to: "2026-04-03T00:00:00Z", // 92 days
      }),
    ).resolves.toBeDefined();
  });

  it("find_events allows windows wider than a quarter when subject_contains or attendee is set", async () => {
    const store = new InMemoryMessageStore();
    const wide = { from: "2025-06-01T00:00:00Z", to: "2026-04-01T00:00:00Z" };
    await expect(
      handleFindEvents(store, clock, { ...wide, subject_contains: "budget" }),
    ).resolves.toBeDefined();
    await expect(
      handleFindEvents(store, clock, { ...wide, attendee: "kristof" }),
    ).resolves.toBeDefined();
    await expect(handleFindEvents(store, clock, { ...wide })).rejects.toThrow(
      /92 days/,
    );
  });

  it("omits subjectContains/attendee/accounts from the store call when not provided, includes them when provided", async () => {
    const store = new InMemoryMessageStore();
    await handleFindEvents(store, clock, {});
    const bareCall = store.calls.find((c) => c.method === "findEvents");
    // toStrictEqual on the relevant keys: an omitted param must not appear
    // as `key: undefined` in the store call, only as a genuinely absent key.
    expect(Object.keys((bareCall as { opts: object }).opts)).not.toEqual(
      expect.arrayContaining(["subjectContains", "attendee", "accounts"]),
    );

    const store2 = new InMemoryMessageStore();
    await handleFindEvents(store2, clock, {
      subject_contains: "budget",
      attendee: "kristof",
      accounts: ["a@example.test"],
    });
    const filledCall = store2.calls.find((c) => c.method === "findEvents");
    expect(filledCall).toMatchObject({
      opts: {
        subjectContains: "budget",
        attendee: "kristof",
        accounts: ["a@example.test"],
      },
    });
  });

  it("find_events inlines attendees per event", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({
        eventId: "evt-1",
        attendees: [{ email: "kristof@example.test", responseStatus: "accepted" }],
      }),
      event({ eventId: "evt-2" }),
    ]);
    const result = await handleFindEvents(store, clock, {
      from: "2026-04-13T00:00:00Z",
      to: "2026-04-14T00:00:00Z",
    });
    const withAttendees = result.events.find((e) => e.eventId === "evt-1");
    const withoutAttendees = result.events.find((e) => e.eventId === "evt-2");
    expect(withAttendees?.attendees).toEqual([
      expect.objectContaining({ email: "kristof@example.test" }),
    ]);
    expect(withoutAttendees?.attendees).toEqual([]);
  });

  it("find_events caps results at limit and sets truncated when more match", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({ eventId: "evt-1" }),
      event({ eventId: "evt-2" }),
      event({ eventId: "evt-3" }),
    ]);
    const window = { from: "2026-04-13T00:00:00Z", to: "2026-04-14T00:00:00Z" };
    const capped = await handleFindEvents(store, clock, { ...window, limit: 2 });
    expect(capped.events).toHaveLength(2);
    expect(capped.truncated).toBe(true);

    const exact = await handleFindEvents(store, clock, { ...window, limit: 3 });
    expect(exact.truncated).toBe(false);

    // default limit applies when omitted
    const defaulted = await handleFindEvents(store, clock, window);
    expect(defaulted.truncated).toBe(false);

    // caller-supplied limit above 250 is clamped, not rejected
    await expect(
      handleFindEvents(store, clock, { ...window, limit: 999 }),
    ).resolves.toBeDefined();
  });

  it("rejects a non-positive limit with InvalidParams", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleFindEvents(store, clock, { limit: 0 }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
    await expect(
      handleFindEvents(store, clock, { limit: -5 }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("order desc returns most recent match first", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({
        eventId: "evt-early",
        startAt: new Date("2026-04-13T08:00:00Z"),
        endAt: new Date("2026-04-13T09:00:00Z"),
      }),
      event({
        eventId: "evt-late",
        startAt: new Date("2026-04-13T14:00:00Z"),
        endAt: new Date("2026-04-13T15:00:00Z"),
      }),
    ]);
    const result = await handleFindEvents(store, clock, {
      from: "2026-04-13T00:00:00Z",
      to: "2026-04-14T00:00:00Z",
      order: "desc",
    } as FindEventsParams);
    expect(result.events.map((e) => e.eventId)).toEqual(["evt-late", "evt-early"]);
  });

  it("AC7: find_events excludes muted events by default", async () => {
    const steeringStore = new InMemorySteeringStore();
    await steeringStore.addRule({
      ruleType: "event_organizer_email",
      pattern: "noisy@example.test",
    });
    const store = new InMemoryMessageStore({ steeringStore });
    await store.upsertEvents([
      event({
        eventId: "muted",
        organizerEmail: "noisy@example.test",
        startAt: new Date("2026-04-13T09:00:00Z"),
        endAt: new Date("2026-04-13T10:00:00Z"),
      }),
      event({
        eventId: "keep",
        organizerEmail: "alice@example.test",
        startAt: new Date("2026-04-13T14:00:00Z"),
        endAt: new Date("2026-04-13T15:00:00Z"),
      }),
    ]);
    const result = await handleFindEvents(store, clock, {
      from: "2026-04-13T00:00:00Z",
      to: "2026-04-14T00:00:00Z",
    });
    expect(result.events.map((e) => e.eventId)).toEqual(["keep"]);
    expect(result.muted_count).toBe(1);
    expect(result.steering_hint).toBeDefined();
  });

  it("AC8: find_events with include_muted=true returns everything", async () => {
    const steeringStore = new InMemorySteeringStore();
    await steeringStore.addRule({
      ruleType: "event_organizer_email",
      pattern: "noisy@example.test",
    });
    const store = new InMemoryMessageStore({ steeringStore });
    await store.upsertEvents([
      event({
        eventId: "muted",
        organizerEmail: "noisy@example.test",
        startAt: new Date("2026-04-13T09:00:00Z"),
        endAt: new Date("2026-04-13T10:00:00Z"),
      }),
      event({
        eventId: "keep",
        organizerEmail: "alice@example.test",
        startAt: new Date("2026-04-13T14:00:00Z"),
        endAt: new Date("2026-04-13T15:00:00Z"),
      }),
    ]);
    const result = await handleFindEvents(store, clock, {
      from: "2026-04-13T00:00:00Z",
      to: "2026-04-14T00:00:00Z",
      include_muted: true,
    });
    expect(result.events.map((e) => e.eventId).sort()).toEqual(["keep", "muted"]);
    expect(result.muted_count).toBe(0);
    expect(result.steering_hint).toBeUndefined();
    expect(Object.keys(result)).not.toContain("steering_hint");
  });
});
