import { describe, it, expect, vi } from "vitest";
import { InMemoryMessageStore } from "../../testing/in-memory-message-store.js";
import { InMemorySteeringStore } from "../../testing/in-memory-steering-store.js";
import { FakeClock } from "../../testing/fake-clock.js";
import type { MessageStore } from "../../store/message-store.js";
import {
  handleGetRecentActivity,
  GET_RECENT_ACTIVITY_TOOL,
  InvalidParamsError,
  type LegacyGetRecentActivityResult,
  type UnifiedGetRecentActivityResult,
} from "./get-recent-activity.js";
import type { CalendarEvent, Message } from "../../store/types.js";

const mkMessage = (overrides: Partial<Message> & Pick<Message, "id">): Message => ({
  source: "outlook",
  account: "a@example.test",
  nativeId: `native-${overrides.id}`,
  sentAt: new Date("2026-04-13T09:00:00Z"),
  importedAt: new Date("2026-04-13T09:05:00Z"),
  ...overrides,
});

const mkEvent = (
  overrides: Partial<CalendarEvent> & Pick<CalendarEvent, "eventId">,
): CalendarEvent => ({
  account: "a@example.test",
  startAt: new Date("2026-04-13T10:00:00Z"),
  endAt: new Date("2026-04-13T11:00:00Z"),
  isAllDay: false,
  isCancelled: false,
  attendees: [],
  ...overrides,
});

const clockAt = (iso: string): FakeClock => new FakeClock(new Date(iso));

describe("handleGetRecentActivity", () => {
  it("rejects non-positive hours with invalid-params", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleGetRecentActivity(store, clock, { hours: 0 }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
    await expect(
      handleGetRecentActivity(store, clock, { hours: -1 }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects hours greater than 720 with invalid-params", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleGetRecentActivity(store, clock, { hours: 721 }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects unknown source values", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleGetRecentActivity(store, clock, {
        hours: 1,
        sources: ["bogus" as "outlook"],
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects empty account values", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleGetRecentActivity(store, clock, {
        hours: 1,
        accounts: [""],
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects empty kinds array", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleGetRecentActivity(store, clock, { hours: 1, kinds: [] }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects unknown kind values", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleGetRecentActivity(store, clock, {
        hours: 1,
        kinds: ["bogus" as "message"],
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("computes since as now minus hours using injected clock", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "in-window",
            sentAt: new Date("2026-04-13T11:30:00Z"),
          }),
          mkMessage({
            id: "out-of-window",
            sentAt: new Date("2026-04-13T10:30:00Z"),
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 1,
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    expect(result.messages.map((m) => m.id)).toEqual(["in-window"]);
  });

  it("projects messages without rawJson/bodyHtml and truncates body snippet to 280", async () => {
    const longBody = "x".repeat(400);
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "m1",
            body: longBody,
            bodyHtml: "<p>nope</p>",
            rawJson: "{\"secret\":\"redacted\"}",
            sentAt: new Date("2026-04-13T11:30:00Z"),
            threadName: "Thread A",
            senderName: "Alice",
            senderEmail: "alice@example.test",
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    const m = result.messages[0];
    expect(m).toBeDefined();
    expect(m).toEqual({
      id: "m1",
      source: "outlook",
      account: "a@example.test",
      threadName: "Thread A",
      senderName: "Alice",
      senderEmail: "alice@example.test",
      sentAt: "2026-04-13T11:30:00.000Z",
      snippet: "x".repeat(280),
    });
    expect(Object.keys(m ?? {})).not.toContain("rawJson");
    expect(Object.keys(m ?? {})).not.toContain("bodyHtml");
    expect(Object.keys(m ?? {})).not.toContain("body");
  });

  it("returns count equal to messages length", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({ id: "1", sentAt: new Date("2026-04-13T11:00:00Z") }),
          mkMessage({ id: "2", sentAt: new Date("2026-04-13T11:30:00Z") }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 4,
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    expect(result.count).toBe(2);
    expect(result.messages).toHaveLength(2);
  });

  it("accepts empty sources and accounts arrays as effectively no filter", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({ id: "m", sentAt: new Date("2026-04-13T11:30:00Z") }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      sources: [],
      accounts: [],
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    expect(result.count).toBe(1);
  });

  it("rejects a non-string account value", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleGetRecentActivity(store, clock, {
        hours: 1,
        accounts: [123 as unknown as string],
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects non-finite hours", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleGetRecentActivity(store, clock, { hours: Number.NaN }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("returns no snippet when body is absent", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({ id: "no-body", sentAt: new Date("2026-04-13T11:30:00Z") }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    expect(result.messages[0]?.snippet).toBeUndefined();
  });

  it("returns body as snippet when shorter than 280", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "short",
            body: "hi",
            sentAt: new Date("2026-04-13T11:30:00Z"),
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    expect(result.messages[0]?.snippet).toBe("hi");
  });

  it("projects Teams-specific fields (chatType, replyToId, mentions)", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "t1",
            source: "teams",
            chatType: "channel",
            replyToId: "root",
            mentions: ["alice@example.test"],
            body: "hi team",
            sentAt: new Date("2026-04-13T11:30:00Z"),
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    const m = result.messages[0];
    expect(m?.source).toBe("teams");
    expect(m?.chatType).toBe("channel");
    expect(m?.replyToId).toBe("root");
    expect(m?.mentions).toEqual(["alice@example.test"]);
  });

  it("projects threadId when the message has one", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "teams-msg",
            source: "teams",
            threadId: "chat-xyz",
            sentAt: new Date("2026-04-13T11:30:00Z"),
          }),
          mkMessage({
            id: "outlook-msg",
            source: "outlook",
            threadId: "conv-123",
            sentAt: new Date("2026-04-13T11:31:00Z"),
          }),
          mkMessage({
            id: "no-thread",
            sentAt: new Date("2026-04-13T11:32:00Z"),
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    const teams = result.messages.find((m) => m.id === "teams-msg");
    const outlook = result.messages.find((m) => m.id === "outlook-msg");
    const none = result.messages.find((m) => m.id === "no-thread");
    expect(teams?.threadId).toBe("chat-xyz");
    expect(outlook?.threadId).toBe("conv-123");
    expect(none).toBeDefined();
    expect(Object.keys(none ?? {})).not.toContain("threadId");
  });

  it("sources:['teams'] returns only teams rows", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({ id: "o1", sentAt: new Date("2026-04-13T11:30:00Z") }),
          mkMessage({
            id: "t1",
            source: "teams",
            sentAt: new Date("2026-04-13T11:40:00Z"),
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      sources: ["teams"],
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    expect(result.count).toBe(1);
    expect(result.messages[0]?.source).toBe("teams");
  });

  it("falls back to bodyHtml for snippet when body is undefined", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "html",
            source: "teams",
            bodyHtml: "<p>richtext</p>",
            sentAt: new Date("2026-04-13T11:30:00Z"),
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    expect(result.messages[0]?.snippet).toBe("<p>richtext</p>");
  });

  it("truncates bodyHtml fallback to SNIPPET_MAX", async () => {
    const long = "x".repeat(500);
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "html-long",
            source: "teams",
            bodyHtml: long,
            sentAt: new Date("2026-04-13T11:30:00Z"),
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    expect(result.messages[0]?.snippet?.length).toBe(280);
  });

  it("exposes a tool descriptor with a valid JSON-schema input", () => {
    expect(GET_RECENT_ACTIVITY_TOOL.name).toBe("get_recent_activity");
    expect(GET_RECENT_ACTIVITY_TOOL.inputSchema.type).toBe("object");
    expect(GET_RECENT_ACTIVITY_TOOL.inputSchema.required).toContain("hours");
  });

  it("description identifies it as source-of-truth probe", () => {
    expect(GET_RECENT_ACTIVITY_TOOL.description).toContain(
      "source-of-truth probe",
    );
  });

  it("AC-R3: replied=true when the latest message in the thread is fromMe", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "outlook:a@example.test:inbound-1",
            threadId: "conv-1",
            senderEmail: "gunter@example.test",
            sentAt: new Date("2026-04-13T10:00:00Z"),
          }),
          mkMessage({
            id: "outlook:a@example.test:reply-1",
            threadId: "conv-1",
            senderEmail: "a@example.test",
            fromMe: true,
            sentAt: new Date("2026-04-13T11:30:00Z"),
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 6,
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    expect(result.count).toBe(2);
    // Annotation is attached to every row of the thread.
    for (const m of result.messages) {
      if (m.threadId === "conv-1") expect(m.replied).toBe(true);
    }
  });

  it("AC-R4: replied=false when the latest message in the thread is inbound", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "outlook:a@example.test:reply-1",
            threadId: "conv-2",
            fromMe: true,
            sentAt: new Date("2026-04-13T09:00:00Z"),
          }),
          mkMessage({
            id: "outlook:a@example.test:inbound-2",
            threadId: "conv-2",
            senderEmail: "gunter@example.test",
            sentAt: new Date("2026-04-13T11:30:00Z"),
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 6,
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    for (const m of result.messages) {
      if (m.threadId === "conv-2") expect(m.replied).toBe(false);
    }
  });

  it("AC-R5: replied annotation does not change message ordering", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "outlook:a@example.test:reply-1",
            threadId: "conv-3",
            fromMe: true,
            sentAt: new Date("2026-04-13T11:30:00Z"),
          }),
          mkMessage({
            id: "outlook:a@example.test:other-1",
            threadId: "conv-4",
            senderEmail: "gunter@example.test",
            sentAt: new Date("2026-04-13T11:45:00Z"),
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 6,
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    // DESC order preserved regardless of fromMe rows.
    expect(result.messages.map((m) => m.id)).toEqual([
      "outlook:a@example.test:other-1",
      "outlook:a@example.test:reply-1",
    ]);
  });

  it("get_recent_activity defaults kinds to [message,event] and returns mixed items", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({ id: "m1", sentAt: new Date("2026-04-13T11:30:00Z") }),
        ],
      },
    });
    await store.upsertEvents([
      mkEvent({
        eventId: "e1",
        startAt: new Date("2026-04-14T09:00:00Z"),
        endAt: new Date("2026-04-14T10:00:00Z"),
      }),
    ]);
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
    })) as UnifiedGetRecentActivityResult;
    expect(result.items.map((i) => i.kind)).toEqual(["message", "event"]);

    // event-only lake still returns the unified shape.
    const eventOnlyStore = new InMemoryMessageStore();
    await eventOnlyStore.upsertEvents([
      mkEvent({
        eventId: "e2",
        startAt: new Date("2026-04-14T09:00:00Z"),
        endAt: new Date("2026-04-14T10:00:00Z"),
      }),
    ]);
    const eventOnlyResult = (await handleGetRecentActivity(
      eventOnlyStore,
      clock,
      { hours: 2 },
    )) as UnifiedGetRecentActivityResult;
    expect(eventOnlyResult.items.map((i) => i.kind)).toEqual(["event"]);

    // message-only lake still returns the unified shape.
    const messageOnlyStore = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({ id: "m2", sentAt: new Date("2026-04-13T11:30:00Z") }),
        ],
      },
    });
    const messageOnlyResult = (await handleGetRecentActivity(
      messageOnlyStore,
      clock,
      { hours: 2 },
    )) as UnifiedGetRecentActivityResult;
    expect(messageOnlyResult.items.map((i) => i.kind)).toEqual(["message"]);
  });

  it("get_recent_activity with kinds=[message] keeps the legacy messages-only output", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({ id: "m1", sentAt: new Date("2026-04-13T11:30:00Z") }),
        ],
      },
    });
    await store.upsertEvents([
      mkEvent({
        eventId: "e1",
        startAt: new Date("2026-04-14T09:00:00Z"),
        endAt: new Date("2026-04-14T10:00:00Z"),
      }),
    ]);
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      kinds: ["message"],
    })) as LegacyGetRecentActivityResult;
    expect(result.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(result.count).toBe(1);
    expect("items" in result).toBe(false);
  });

  it("get_recent_activity with kinds=[event] returns event items only", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({ id: "m1", sentAt: new Date("2026-04-13T11:30:00Z") }),
        ],
      },
    });
    await store.upsertEvents([
      mkEvent({
        eventId: "e1",
        startAt: new Date("2026-04-14T09:00:00Z"),
        endAt: new Date("2026-04-14T10:00:00Z"),
      }),
    ]);
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      kinds: ["event"],
    })) as UnifiedGetRecentActivityResult;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.kind).toBe("event");
    if (result.items[0]?.kind === "event") {
      expect(result.items[0].event.eventId).toBe("e1");
    }

    // zero events still returns the unified shape, empty.
    const emptyStore = new InMemoryMessageStore();
    const emptyResult = (await handleGetRecentActivity(emptyStore, clock, {
      hours: 2,
      kinds: ["event"],
    })) as UnifiedGetRecentActivityResult;
    expect(emptyResult.items).toEqual([]);
  });

  it("items are ordered by at ascending across both kinds", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({ id: "m-early", sentAt: new Date("2026-04-13T09:00:00Z") }),
          mkMessage({ id: "m-tie", sentAt: new Date("2026-04-13T10:00:00Z") }),
        ],
      },
    });
    await store.upsertEvents([
      // Same instant as m-tie: message must sort before event.
      mkEvent({
        eventId: "e-tie",
        startAt: new Date("2026-04-13T10:00:00Z"),
        endAt: new Date("2026-04-13T10:30:00Z"),
      }),
      mkEvent({
        eventId: "e-late",
        startAt: new Date("2026-04-13T11:00:00Z"),
        endAt: new Date("2026-04-13T11:30:00Z"),
      }),
    ]);
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 6,
    })) as UnifiedGetRecentActivityResult;
    expect(
      result.items.map((i) => (i.kind === "message" ? i.message.id : i.event.eventId)),
    ).toEqual(["m-early", "m-tie", "e-tie", "e-late"]);
  });

  it("default to is now+7d when events are requested", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      mkEvent({
        eventId: "e-in-7d",
        startAt: new Date("2026-04-20T11:59:00Z"),
        endAt: new Date("2026-04-20T12:59:00Z"),
      }),
      mkEvent({
        eventId: "e-past-7d",
        startAt: new Date("2026-04-20T12:01:00Z"),
        endAt: new Date("2026-04-20T13:01:00Z"),
      }),
    ]);
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 24,
    })) as UnifiedGetRecentActivityResult;
    const eventIds = result.items
      .filter((i) => i.kind === "event")
      .map((i) => (i.kind === "event" ? i.event.eventId : ""));
    expect(eventIds).toEqual(["e-in-7d"]);
  });

  it("an explicit to param overrides the now+7d default", async () => {
    // now+7d default would be 2026-04-20T12:00:00Z — this event sits
    // strictly beyond that default but within the explicit `to` below,
    // so it's only included if the explicit param actually wins.
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      mkEvent({
        eventId: "e-beyond-default-within-explicit",
        startAt: new Date("2026-04-22T00:00:00Z"),
        endAt: new Date("2026-04-22T01:00:00Z"),
      }),
      mkEvent({
        eventId: "e-beyond-explicit-to",
        startAt: new Date("2026-04-27T00:00:00Z"),
        endAt: new Date("2026-04-27T01:00:00Z"),
      }),
    ]);
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      to: "2026-04-25T00:00:00Z",
    })) as UnifiedGetRecentActivityResult;
    const eventIds = result.items
      .filter((i) => i.kind === "event")
      .map((i) => (i.kind === "event" ? i.event.eventId : ""));
    expect(eventIds).toEqual(["e-beyond-default-within-explicit"]);
  });

  it("sources filters the unified feed's message items", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "o1",
            source: "outlook",
            sentAt: new Date("2026-04-13T11:30:00Z"),
          }),
          mkMessage({
            id: "t1",
            source: "teams",
            sentAt: new Date("2026-04-13T11:40:00Z"),
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      sources: ["teams"],
    })) as UnifiedGetRecentActivityResult;
    expect(
      result.items.map((i) => (i.kind === "message" ? i.message.id : "")),
    ).toEqual(["t1"]);
  });

  it("accounts filters both message and event items in the unified feed", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "m-a",
            account: "a@example.test",
            sentAt: new Date("2026-04-13T11:00:00Z"),
          }),
          mkMessage({
            id: "m-b",
            account: "b@example.test",
            sentAt: new Date("2026-04-13T11:30:00Z"),
          }),
        ],
      },
    });
    await store.upsertEvents([
      mkEvent({
        eventId: "e-a",
        account: "a@example.test",
        startAt: new Date("2026-04-14T09:00:00Z"),
        endAt: new Date("2026-04-14T10:00:00Z"),
      }),
      mkEvent({
        eventId: "e-b",
        account: "b@example.test",
        startAt: new Date("2026-04-14T09:00:00Z"),
        endAt: new Date("2026-04-14T10:00:00Z"),
      }),
    ]);
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      accounts: ["b@example.test"],
    })) as UnifiedGetRecentActivityResult;
    const ids = result.items.map((i) =>
      i.kind === "message" ? i.message.id : i.event.eventId,
    );
    expect(ids).toEqual(["m-b", "e-b"]);
  });

  it("steering_hint and muted_count are reported in the unified feed", async () => {
    const steeringStore = new InMemorySteeringStore();
    await steeringStore.addRule({
      ruleType: "sender_email",
      pattern: "noisy@bar.com",
    });
    const store = new InMemoryMessageStore({
      steeringStore,
      seed: {
        messages: [
          mkMessage({
            id: "muted",
            senderEmail: "noisy@bar.com",
            sentAt: new Date("2026-04-13T11:30:00Z"),
          }),
          mkMessage({
            id: "keep",
            senderEmail: "alice@example.test",
            sentAt: new Date("2026-04-13T11:40:00Z"),
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const muted = (await handleGetRecentActivity(store, clock, {
      hours: 2,
    })) as UnifiedGetRecentActivityResult;
    expect(muted.muted_count).toBe(1);
    expect(muted.steering_hint).toBeDefined();
    expect(
      muted.items.map((i) => (i.kind === "message" ? i.message.id : "")),
    ).toEqual(["keep"]);

    const unmuted = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      include_muted: true,
    })) as UnifiedGetRecentActivityResult;
    expect(unmuted.muted_count).toBe(0);
    expect(unmuted.steering_hint).toBeUndefined();
    // Key must be absent, not merely undefined-valued — proves the
    // conditional spread is actually skipped, not just read-as-undefined.
    expect(Object.keys(unmuted)).not.toContain("steering_hint");
  });

  it("AC9: get_recent_activity excludes muted events on the event branch by default", async () => {
    const steeringStore = new InMemorySteeringStore();
    await steeringStore.addRule({
      ruleType: "sender_email",
      pattern: "noisy@bar.com",
    });
    await steeringStore.addRule({
      ruleType: "event_organizer_email",
      pattern: "noisy-organizer@example.test",
    });
    const store = new InMemoryMessageStore({
      steeringStore,
      seed: {
        messages: [
          mkMessage({
            id: "muted-msg",
            senderEmail: "noisy@bar.com",
            sentAt: new Date("2026-04-13T11:30:00Z"),
          }),
          mkMessage({
            id: "keep-msg",
            senderEmail: "alice@example.test",
            sentAt: new Date("2026-04-13T11:40:00Z"),
          }),
        ],
      },
    });
    await store.upsertEvents([
      mkEvent({
        eventId: "muted-event",
        organizerEmail: "noisy-organizer@example.test",
        startAt: new Date("2026-04-14T09:00:00Z"),
        endAt: new Date("2026-04-14T10:00:00Z"),
      }),
      mkEvent({
        eventId: "keep-event",
        organizerEmail: "alice@example.test",
        startAt: new Date("2026-04-14T11:00:00Z"),
        endAt: new Date("2026-04-14T12:00:00Z"),
      }),
    ]);
    const clock = clockAt("2026-04-13T12:00:00Z");
    const muted = (await handleGetRecentActivity(store, clock, {
      hours: 2,
    })) as UnifiedGetRecentActivityResult;
    const ids = (item: UnifiedGetRecentActivityResult["items"][number]) =>
      item.kind === "message" ? item.message.id : item.event.eventId;
    // Both message and event mutes contribute to one combined muted_count,
    // and messages-only behaviour (AC-R3..R5) is unaffected by the event
    // branch existing alongside it.
    expect(muted.items.map(ids)).toEqual(["keep-msg", "keep-event"]);
    expect(muted.muted_count).toBe(2);

    const unmuted = (await handleGetRecentActivity(store, clock, {
      hours: 2,
      include_muted: true,
    })) as UnifiedGetRecentActivityResult;
    expect(unmuted.items.map(ids).sort()).toEqual([
      "keep-event",
      "keep-msg",
      "muted-event",
      "muted-msg",
    ]);
    expect(unmuted.muted_count).toBe(0);
  });

  it("omits sources/accounts from the store.getRecentItems call when not set on params", async () => {
    const store = {
      getRecentItems: vi
        .fn()
        .mockResolvedValue({ items: [], mutedCount: 0 }),
    } as unknown as MessageStore;
    const clock = clockAt("2026-04-13T12:00:00Z");
    await handleGetRecentActivity(store, clock, { hours: 2 });
    const call = (store.getRecentItems as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(call).toStrictEqual({
      from: new Date("2026-04-13T10:00:00Z"),
      to: new Date("2026-04-20T12:00:00Z"),
      kinds: ["message", "event"],
      includeMuted: false,
    });
  });

  it("forwards sources/accounts to the store.getRecentItems call exactly when set on params", async () => {
    const store = {
      getRecentItems: vi
        .fn()
        .mockResolvedValue({ items: [], mutedCount: 0 }),
    } as unknown as MessageStore;
    const clock = clockAt("2026-04-13T12:00:00Z");
    await handleGetRecentActivity(store, clock, {
      hours: 2,
      sources: ["teams"],
      accounts: ["a@example.test"],
    });
    const call = (store.getRecentItems as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(call).toStrictEqual({
      from: new Date("2026-04-13T10:00:00Z"),
      to: new Date("2026-04-20T12:00:00Z"),
      kinds: ["message", "event"],
      sources: ["teams"],
      accounts: ["a@example.test"],
      includeMuted: false,
    });
  });

  it("replied annotation is computed correctly for message items within a mixed feed", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "outlook:a@example.test:inbound-1",
            threadId: "conv-mixed",
            senderEmail: "gunter@example.test",
            sentAt: new Date("2026-04-13T10:00:00Z"),
          }),
          mkMessage({
            id: "outlook:a@example.test:reply-1",
            threadId: "conv-mixed",
            senderEmail: "a@example.test",
            fromMe: true,
            sentAt: new Date("2026-04-13T11:30:00Z"),
          }),
        ],
      },
    });
    await store.upsertEvents([
      mkEvent({
        eventId: "e-mixed",
        startAt: new Date("2026-04-14T09:00:00Z"),
        endAt: new Date("2026-04-14T10:00:00Z"),
      }),
    ]);
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 6,
    })) as UnifiedGetRecentActivityResult;
    for (const item of result.items) {
      if (item.kind === "message" && item.message.threadId === "conv-mixed") {
        expect(item.message.replied).toBe(true);
      }
    }
  });

  it("items are capped at 500 with the oldest dropped", async () => {
    const messages = Array.from({ length: 600 }, (_, i) =>
      mkMessage({
        id: `m${i}`,
        sentAt: new Date(Date.parse("2026-04-13T00:00:00Z") + i * 60_000),
      }),
    );
    const store = new InMemoryMessageStore({ seed: { messages } });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = (await handleGetRecentActivity(store, clock, {
      hours: 20,
    })) as UnifiedGetRecentActivityResult;
    expect(result.items).toHaveLength(500);
    const ids = result.items.map((i) => (i.kind === "message" ? i.message.id : ""));
    expect(ids).not.toContain("m0");
    expect(ids).toContain("m599");
  });
});
