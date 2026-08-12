import { describe, expect, it } from "vitest";
import { FakeClock } from "../../testing/fake-clock.js";
import { InMemoryMessageStore } from "../../testing/in-memory-message-store.js";
import { InMemorySteeringStore } from "../../testing/in-memory-steering-store.js";
import type { CalendarEvent, Transcript, TranscriptSegment } from "../../store/types.js";
import { InvalidParamsError } from "./get-recent-activity.js";
import {
  GET_EVENT_TRANSCRIPT_TOOL,
  handleGetEventTranscript,
  type GetEventTranscriptParams,
} from "./get-event-transcript.js";

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

function transcript(
  overrides: Partial<Transcript> & Pick<Transcript, "transcriptId">,
): Transcript {
  return {
    account: "a@example.test",
    eventId: "evt-1",
    fetchedAt: new Date("2026-04-13T11:05:00Z"),
    segmentCount: 1,
    status: "ok",
    ...overrides,
  };
}

function segment(
  overrides: Partial<TranscriptSegment> & Pick<TranscriptSegment, "transcriptId" | "sequence">,
): TranscriptSegment {
  return {
    account: "a@example.test",
    eventId: "evt-1",
    startOffsetMs: 0,
    endOffsetMs: 1000,
    text: "Hello.",
    ...overrides,
  };
}

describe("GET_EVENT_TRANSCRIPT_TOOL descriptor", () => {
  it("is named get_event_transcript and requires event_id, account is optional", () => {
    expect(GET_EVENT_TRANSCRIPT_TOOL.name).toBe("get_event_transcript");
    expect(GET_EVENT_TRANSCRIPT_TOOL.inputSchema.required).toEqual(["event_id"]);
    expect(GET_EVENT_TRANSCRIPT_TOOL.inputSchema.properties.event_id.type).toBe(
      "string",
    );
    expect(GET_EVENT_TRANSCRIPT_TOOL.inputSchema.properties.account.type).toBe(
      "string",
    );
  });
});

describe("handleGetEventTranscript", () => {
  it("rejects missing event_id with InvalidParamsError", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleGetEventTranscript(store, clock, {} as GetEventTranscriptParams),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects an empty-string event_id with InvalidParamsError", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleGetEventTranscript(store, clock, { event_id: "" }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects a non-empty-but-invalid account with InvalidParamsError", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleGetEventTranscript(store, clock, { event_id: "evt-1", account: "" }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("returns null transcript and empty segments (not an error) when the event doesn't exist", async () => {
    const store = new InMemoryMessageStore();
    const result = await handleGetEventTranscript(store, clock, {
      event_id: "nonexistent",
      account: "a@example.test",
    });
    expect(result).toEqual({ transcript: null, segments: [] });
  });

  it("returns null transcript and empty segments when the event exists but has no transcript row yet", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const result = await handleGetEventTranscript(store, clock, {
      event_id: "evt-1",
      account: "a@example.test",
    });
    expect(result).toEqual({ transcript: null, segments: [] });
  });

  it("returns null when the only rows for the event are non-ok (not-available/fetch-failed)", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    await store.markTranscriptStatus(
      { account: "a@example.test", eventId: "evt-1", transcriptId: "__marker__" },
      "not-available",
      clock.now(),
    );
    const result = await handleGetEventTranscript(store, clock, {
      event_id: "evt-1",
      account: "a@example.test",
    });
    expect(result).toEqual({ transcript: null, segments: [] });
  });

  it("returns the transcript and its segments when one exists", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    await store.upsertTranscript({
      transcript: transcript({ transcriptId: "tr-1" }),
      segments: [
        segment({ transcriptId: "tr-1", sequence: 0, text: "Hello everyone." }),
      ],
    });
    const result = await handleGetEventTranscript(store, clock, {
      event_id: "evt-1",
      account: "a@example.test",
    });
    expect(result.transcript?.transcriptId).toBe("tr-1");
    expect(result.transcript?.status).toBe("ok");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.text).toBe("Hello everyone.");
  });

  it("when multiple ok transcripts exist for one event, returns the most recently fetched one", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    await store.upsertTranscript({
      transcript: transcript({
        transcriptId: "tr-old",
        fetchedAt: new Date("2026-04-13T11:00:00Z"),
      }),
      segments: [segment({ transcriptId: "tr-old", sequence: 0, text: "Old take." })],
    });
    await store.upsertTranscript({
      transcript: transcript({
        transcriptId: "tr-new",
        fetchedAt: new Date("2026-04-13T11:10:00Z"),
      }),
      segments: [segment({ transcriptId: "tr-new", sequence: 0, text: "New take." })],
    });
    const result = await handleGetEventTranscript(store, clock, {
      event_id: "evt-1",
      account: "a@example.test",
    });
    expect(result.transcript?.transcriptId).toBe("tr-new");
    expect(result.segments[0]?.text).toBe("New take.");
  });

  it("ignores a non-ok row and returns the ok one even if the non-ok row is more recent", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    await store.upsertTranscript({
      transcript: transcript({
        transcriptId: "tr-ok",
        fetchedAt: new Date("2026-04-13T11:00:00Z"),
      }),
      segments: [segment({ transcriptId: "tr-ok", sequence: 0, text: "Real content." })],
    });
    await store.markTranscriptStatus(
      { account: "a@example.test", eventId: "evt-1", transcriptId: "tr-retry" },
      "fetch-failed",
      new Date("2026-04-13T12:00:00Z"),
    );
    const result = await handleGetEventTranscript(store, clock, {
      event_id: "evt-1",
      account: "a@example.test",
    });
    expect(result.transcript?.transcriptId).toBe("tr-ok");
  });

  it("accepts account to disambiguate cross-account event ids", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({ eventId: "shared-id", account: "a@example.test" }),
      event({ eventId: "shared-id", account: "b@example.test" }),
    ]);
    await store.upsertAccount({ username: "a@example.test", addedAt: clock.now() });
    await store.upsertAccount({ username: "b@example.test", addedAt: clock.now() });
    await store.upsertTranscript({
      transcript: transcript({
        transcriptId: "tr-a",
        account: "a@example.test",
        eventId: "shared-id",
      }),
      segments: [],
    });

    await expect(
      handleGetEventTranscript(store, clock, { event_id: "shared-id" }),
    ).rejects.toBeInstanceOf(InvalidParamsError);

    const a = await handleGetEventTranscript(store, clock, {
      event_id: "shared-id",
      account: "a@example.test",
    });
    expect(a.transcript?.transcriptId).toBe("tr-a");

    const b = await handleGetEventTranscript(store, clock, {
      event_id: "shared-id",
      account: "b@example.test",
    });
    expect(b).toEqual({ transcript: null, segments: [] });
  });

  it("ignores event steering rules — a muted organizer's event transcript is still returned", async () => {
    const steeringStore = new InMemorySteeringStore();
    await steeringStore.addRule({
      ruleType: "event_organizer_email",
      pattern: "noisy-organizer@example.test",
    });
    const store = new InMemoryMessageStore({ steeringStore });
    await store.upsertEvents([
      event({
        eventId: "evt-muted-organizer",
        organizerEmail: "noisy-organizer@example.test",
      }),
    ]);
    await store.upsertTranscript({
      transcript: transcript({
        transcriptId: "tr-1",
        eventId: "evt-muted-organizer",
      }),
      segments: [],
    });
    const result = await handleGetEventTranscript(store, clock, {
      event_id: "evt-muted-organizer",
      account: "a@example.test",
    });
    expect(result.transcript?.transcriptId).toBe("tr-1");
  });
});
