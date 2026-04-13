import { describe, it, expect } from "vitest";
import { InMemoryMessageStore } from "../../testing/in-memory-message-store.js";
import { FakeClock } from "../../testing/fake-clock.js";
import {
  handleGetRecentActivity,
  GET_RECENT_ACTIVITY_TOOL,
  InvalidParamsError,
} from "./get-recent-activity.js";
import type { Message } from "../../store/types.js";

const mkMessage = (overrides: Partial<Message> & Pick<Message, "id">): Message => ({
  source: "outlook",
  account: "a@example.test",
  nativeId: `native-${overrides.id}`,
  sentAt: new Date("2026-04-13T09:00:00Z"),
  importedAt: new Date("2026-04-13T09:05:00Z"),
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
    const result = await handleGetRecentActivity(store, clock, { hours: 1 });
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
    const result = await handleGetRecentActivity(store, clock, { hours: 2 });
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
    const result = await handleGetRecentActivity(store, clock, { hours: 4 });
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
    const result = await handleGetRecentActivity(store, clock, {
      hours: 2,
      sources: [],
      accounts: [],
    });
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
    const result = await handleGetRecentActivity(store, clock, { hours: 2 });
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
    const result = await handleGetRecentActivity(store, clock, { hours: 2 });
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
    const result = await handleGetRecentActivity(store, clock, { hours: 2 });
    const m = result.messages[0];
    expect(m?.source).toBe("teams");
    expect(m?.chatType).toBe("channel");
    expect(m?.replyToId).toBe("root");
    expect(m?.mentions).toEqual(["alice@example.test"]);
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
    const result = await handleGetRecentActivity(store, clock, {
      hours: 2,
      sources: ["teams"],
    });
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
    const result = await handleGetRecentActivity(store, clock, { hours: 2 });
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
    const result = await handleGetRecentActivity(store, clock, { hours: 2 });
    expect(result.messages[0]?.snippet?.length).toBe(280);
  });

  it("exposes a tool descriptor with a valid JSON-schema input", () => {
    expect(GET_RECENT_ACTIVITY_TOOL.name).toBe("get_recent_activity");
    expect(GET_RECENT_ACTIVITY_TOOL.inputSchema.type).toBe("object");
    expect(GET_RECENT_ACTIVITY_TOOL.inputSchema.required).toContain("hours");
  });
});
