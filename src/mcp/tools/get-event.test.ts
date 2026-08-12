import { describe, expect, it } from "vitest";
import { FakeClock } from "../../testing/fake-clock.js";
import { InMemoryMessageStore } from "../../testing/in-memory-message-store.js";
import { InMemorySteeringStore } from "../../testing/in-memory-steering-store.js";
import type { CalendarEvent, Message } from "../../store/types.js";
import { InvalidParamsError } from "./get-recent-activity.js";
import { GET_EVENT_TOOL, handleGetEvent, type GetEventParams } from "./get-event.js";
import type { Transcript } from "../../store/types.js";

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

function msg(overrides: Partial<Message> & Pick<Message, "id">): Message {
  return {
    source: "teams",
    account: "a@example.test",
    nativeId: `native-${overrides.id}`,
    sentAt: new Date("2026-04-13T09:00:00Z"),
    importedAt: new Date("2026-04-13T09:05:00Z"),
    ...overrides,
  };
}

describe("GET_EVENT_TOOL descriptor", () => {
  it("is named get_event and requires event_id, account is optional", () => {
    expect(GET_EVENT_TOOL.name).toBe("get_event");
    expect(GET_EVENT_TOOL.inputSchema.required).toEqual(["event_id"]);
    expect(GET_EVENT_TOOL.inputSchema.properties.event_id.type).toBe("string");
    expect(GET_EVENT_TOOL.inputSchema.properties.account.type).toBe("string");
  });
});

describe("handleGetEvent", () => {
  it("rejects missing event_id with InvalidParamsError", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleGetEvent(store, clock, {} as GetEventParams),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects an empty-string event_id with InvalidParamsError", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleGetEvent(store, clock, { event_id: "" }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects a non-empty-but-invalid account with InvalidParamsError", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleGetEvent(store, clock, { event_id: "evt-1", account: "" }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("get_event returns event with attendees and null linkedChat for in-person events", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({
        eventId: "evt-1",
        subject: "In-person sync",
        attendees: [{ email: "kristof@example.test", responseStatus: "accepted" }],
      }),
    ]);
    const result = await handleGetEvent(store, clock, {
      event_id: "evt-1",
      account: "a@example.test",
    });
    expect(result.event?.eventId).toBe("evt-1");
    expect(result.attendees).toEqual([
      expect.objectContaining({ email: "kristof@example.test" }),
    ]);
    expect(result.linkedChat).toBeNull();
  });

  it("get_event returns linkedChat with messages for an online meeting", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({ eventId: "evt-online", chatId: "19:chat-abc@thread.v2" }),
    ]);
    for (let i = 0; i < 60; i++) {
      await store.upsertMessages([
        msg({
          id: `m${i}`,
          threadId: "19:chat-abc@thread.v2",
          sentAt: new Date(2026, 3, 13, 0, i),
        }),
      ]);
    }
    const result = await handleGetEvent(store, clock, {
      event_id: "evt-online",
      account: "a@example.test",
    });
    expect(result.linkedChat?.chatId).toBe("19:chat-abc@thread.v2");
    expect(result.linkedChat?.messages).toHaveLength(50);

    // fewer than 50: all returned
    const store2 = new InMemoryMessageStore();
    await store2.upsertEvents([
      event({ eventId: "evt-online-2", chatId: "19:chat-xyz@thread.v2" }),
    ]);
    await store2.upsertMessages([
      msg({ id: "only-one", threadId: "19:chat-xyz@thread.v2" }),
    ]);
    const result2 = await handleGetEvent(store2, clock, {
      event_id: "evt-online-2",
      account: "a@example.test",
    });
    expect(result2.linkedChat?.messages).toHaveLength(1);
  });

  it("get_event returns linkedChat with empty messages when the chat sync has not landed", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({ eventId: "evt-no-messages-yet", chatId: "19:chat-none@thread.v2" }),
    ]);
    const result = await handleGetEvent(store, clock, {
      event_id: "evt-no-messages-yet",
      account: "a@example.test",
    });
    expect(result.linkedChat).toEqual({
      chatId: "19:chat-none@thread.v2",
      messages: [],
    });
  });

  it("get_event accepts account to disambiguate cross-tenant event ids", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({ eventId: "shared-id", account: "a@example.test", subject: "A's meeting" }),
      event({ eventId: "shared-id", account: "b@example.test", subject: "B's meeting" }),
    ]);
    await store.upsertAccount({
      username: "a@example.test",
      addedAt: clock.now(),
    });
    await store.upsertAccount({
      username: "b@example.test",
      addedAt: clock.now(),
    });

    // missing account when ambiguous -> InvalidParams
    await expect(
      handleGetEvent(store, clock, { event_id: "shared-id" }),
    ).rejects.toBeInstanceOf(InvalidParamsError);

    // account provided -> the right event
    const a = await handleGetEvent(store, clock, {
      event_id: "shared-id",
      account: "a@example.test",
    });
    expect(a.event?.subject).toBe("A's meeting");

    // account provided but no event under that account -> null event, not a throw
    const none = await handleGetEvent(store, clock, {
      event_id: "shared-id",
      account: "c@example.test",
    });
    expect(none.event).toBeNull();
  });

  it("get_event resolves an unambiguous event across accounts when account is omitted", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({ eventId: "evt-solo", account: "a@example.test", subject: "Solo" }),
    ]);
    await store.upsertAccount({ username: "a@example.test", addedAt: clock.now() });
    const result = await handleGetEvent(store, clock, { event_id: "evt-solo" });
    expect(result.event?.subject).toBe("Solo");
  });

  it("get_event returns event: null (not an error) when the event is not found at all", async () => {
    const store = new InMemoryMessageStore();
    const result = await handleGetEvent(store, clock, {
      event_id: "nonexistent",
      account: "a@example.test",
    });
    expect(result).toEqual({ event: null, attendees: [], linkedChat: null });
  });

  it("get_event ignores steering rules on linked chat messages", async () => {
    const steeringCalls: unknown[] = [];
    const steering = {
      listRules: async () => {
        steeringCalls.push("listRules");
        return [
          {
            id: 1,
            ruleType: "sender_email" as const,
            pattern: "muted@example.test",
            enabled: true,
            createdAt: clock.now(),
          },
        ];
      },
    };
    const store = new InMemoryMessageStore({ steeringStore: steering });
    await store.upsertEvents([
      event({ eventId: "evt-steered", chatId: "19:chat-steered@thread.v2" }),
    ]);
    await store.upsertMessages([
      msg({
        id: "muted-msg",
        threadId: "19:chat-steered@thread.v2",
        senderEmail: "muted@example.test",
      }),
    ]);
    const result = await handleGetEvent(store, clock, {
      event_id: "evt-steered",
      account: "a@example.test",
    });
    // get_thread (which linkedChat is backed by) never applies steering,
    // so the "muted" sender's message is still present.
    expect(result.linkedChat?.messages).toHaveLength(1);
    expect(steeringCalls).toEqual([]);
  });

  it("AC10: get_event ignores event steering rules — a muted organizer's event is still returned", async () => {
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
    const result = await handleGetEvent(store, clock, {
      event_id: "evt-muted-organizer",
      account: "a@example.test",
    });
    // If the user explicitly asks about a specific event, they want it —
    // even one they've muted elsewhere (mirrors the get_thread carve-out).
    expect(result.event?.eventId).toBe("evt-muted-organizer");
  });

  it("omits linkedTranscript entirely when include_transcript is not passed", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const result = await handleGetEvent(store, clock, {
      event_id: "evt-1",
      account: "a@example.test",
    });
    expect(result).not.toHaveProperty("linkedTranscript");
  });

  it("omits linkedTranscript when include_transcript is explicitly false", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const result = await handleGetEvent(store, clock, {
      event_id: "evt-1",
      account: "a@example.test",
      include_transcript: false,
    });
    expect(result).not.toHaveProperty("linkedTranscript");
  });

  it("include_transcript: true adds linkedTranscript with null transcript when none exists yet", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const result = await handleGetEvent(store, clock, {
      event_id: "evt-1",
      account: "a@example.test",
      include_transcript: true,
    });
    expect(result.linkedTranscript).toEqual({ transcript: null, segments: [] });
  });

  it("include_transcript: true returns the fetched transcript and its segments", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const transcript: Transcript = {
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: "tr-1",
      fetchedAt: new Date("2026-04-13T11:05:00Z"),
      segmentCount: 1,
      status: "ok",
    };
    await store.upsertTranscript({
      transcript,
      segments: [
        {
          account: "a@example.test",
          eventId: "evt-1",
          transcriptId: "tr-1",
          sequence: 0,
          startOffsetMs: 0,
          endOffsetMs: 1000,
          text: "Hello everyone.",
        },
      ],
    });
    const result = await handleGetEvent(store, clock, {
      event_id: "evt-1",
      account: "a@example.test",
      include_transcript: true,
    });
    expect(result.linkedTranscript?.transcript?.transcriptId).toBe("tr-1");
    expect(result.linkedTranscript?.segments).toHaveLength(1);
    expect(result.linkedTranscript?.segments[0]?.text).toBe("Hello everyone.");
  });
});
