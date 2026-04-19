import { describe, expect, it } from "vitest";
import { FakeClock } from "../../testing/fake-clock.js";
import { InMemoryMessageStore } from "../../testing/in-memory-message-store.js";
import type { Message } from "../../store/types.js";
import {
  MAX_BODY_CHARS,
  TRUNCATION_SENTINEL,
} from "./body-projection.js";
import { InvalidParamsError } from "./get-recent-activity.js";
import {
  GET_THREAD_TOOL,
  handleGetThread,
  type GetThreadParams,
} from "./get-thread.js";

const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));

const mk = (overrides: Partial<Message> & Pick<Message, "id">): Message => ({
  source: "teams",
  account: "a@example.test",
  nativeId: `native-${overrides.id}`,
  sentAt: new Date("2026-04-13T10:00:00Z"),
  importedAt: new Date("2026-04-13T10:05:00Z"),
  ...overrides,
});

describe("GET_THREAD_TOOL descriptor", () => {
  it("is named get_thread and requires thread_id", () => {
    expect(GET_THREAD_TOOL.name).toBe("get_thread");
    expect(GET_THREAD_TOOL.inputSchema.required).toEqual(["thread_id"]);
    expect(GET_THREAD_TOOL.inputSchema.properties.thread_id.type).toBe(
      "string",
    );
  });
});

describe("handleGetThread", () => {
  it("rejects missing thread_id with InvalidParamsError", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleGetThread(store, clock, {} as unknown as GetThreadParams),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects empty thread_id with InvalidParamsError", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleGetThread(store, clock, { thread_id: "" }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects non-numeric limit with InvalidParamsError", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleGetThread(store, clock, {
        thread_id: "chat-1",
        limit: "ten" as unknown as number,
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects limit > 500 with InvalidParamsError", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleGetThread(store, clock, { thread_id: "chat-1", limit: 501 }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("returns empty for an unknown thread id", async () => {
    const store = new InMemoryMessageStore();
    const result = await handleGetThread(store, clock, {
      thread_id: "nope",
    });
    expect(result).toEqual({ count: 0, messages: [] });
  });

  it("projects the same shape as get_recent_activity with no body/rawJson leak", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mk({
            id: "teams:a@example.test:1",
            threadId: "chat-1",
            senderName: "Alice",
            senderEmail: "alice@example.test",
            chatType: "group",
            replyToId: "root",
            mentions: ["bob@example.test"],
            body: "hello world",
            rawJson: JSON.stringify({ secret: true }),
          }),
        ],
      },
    });
    const result = await handleGetThread(store, clock, {
      thread_id: "chat-1",
    });
    expect(result.count).toBe(1);
    const m = result.messages[0]!;
    expect(m.id).toBe("teams:a@example.test:1");
    expect(m.source).toBe("teams");
    expect(m.senderName).toBe("Alice");
    expect(m.chatType).toBe("group");
    expect(m.replyToId).toBe("root");
    expect(m.mentions).toEqual(["bob@example.test"]);
    expect(m.snippet).toBe("hello world");
    expect((m as unknown as { body?: unknown }).body).toBeUndefined();
    expect((m as unknown as { rawJson?: unknown }).rawJson).toBeUndefined();
  });

  it("falls back to bodyHtml for the snippet when body is missing", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mk({
            id: "teams:a@example.test:1",
            threadId: "chat-1",
            bodyHtml: "<p>hi html</p>",
          }),
        ],
      },
    });
    const result = await handleGetThread(store, clock, {
      thread_id: "chat-1",
    });
    expect(result.messages[0]?.snippet).toBe("<p>hi html</p>");
  });

  it("omits snippet when neither body nor bodyHtml is set", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mk({ id: "teams:a@example.test:1", threadId: "chat-1" }),
        ],
      },
    });
    const result = await handleGetThread(store, clock, {
      thread_id: "chat-1",
    });
    expect(result.messages[0]?.snippet).toBeUndefined();
  });

  it("truncates a long body to SNIPPET_MAX (280 chars) and surfaces threadName", async () => {
    const long = "x".repeat(400);
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mk({
            id: "teams:a@example.test:1",
            threadId: "chat-1",
            threadName: "Weekly sync",
            body: long,
          }),
        ],
      },
    });
    const result = await handleGetThread(store, clock, {
      thread_id: "chat-1",
    });
    expect(result.messages[0]?.snippet?.length).toBe(280);
    expect(result.messages[0]?.threadName).toBe("Weekly sync");
  });

  it("projects threadId on every returned message", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mk({
            id: "teams:a@example.test:1",
            threadId: "chat-1",
            sentAt: new Date("2026-04-13T10:00:00Z"),
          }),
          mk({
            id: "teams:a@example.test:2",
            threadId: "chat-1",
            sentAt: new Date("2026-04-13T11:00:00Z"),
          }),
        ],
      },
    });
    const result = await handleGetThread(store, clock, {
      thread_id: "chat-1",
    });
    expect(result.count).toBe(2);
    expect(result.messages.every((m) => m.threadId === "chat-1")).toBe(true);
  });

  it("orders messages oldest→newest and respects explicit limit", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mk({
            id: "teams:a@example.test:3",
            threadId: "chat-1",
            sentAt: new Date("2026-04-13T12:00:00Z"),
            body: "third",
          }),
          mk({
            id: "teams:a@example.test:1",
            threadId: "chat-1",
            sentAt: new Date("2026-04-13T10:00:00Z"),
            body: "first",
          }),
          mk({
            id: "teams:a@example.test:2",
            threadId: "chat-1",
            sentAt: new Date("2026-04-13T11:00:00Z"),
            body: "second",
          }),
        ],
      },
    });
    const result = await handleGetThread(store, clock, {
      thread_id: "chat-1",
      limit: 2,
    });
    expect(result.messages.map((m) => m.snippet)).toEqual(["first", "second"]);
  });

  it("description recommends get_thread over search for known persons", () => {
    expect(GET_THREAD_TOOL.description).toContain(
      "Prefer this over search",
    );
  });

  it("truncates a single oversized body without affecting other messages", async () => {
    const big = "x".repeat(MAX_BODY_CHARS + 200);
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mk({
            id: "teams:a@example.test:1",
            threadId: "chat-1",
            sentAt: new Date("2026-04-13T10:00:00Z"),
            body: "short a",
          }),
          mk({
            id: "teams:a@example.test:2",
            threadId: "chat-1",
            sentAt: new Date("2026-04-13T10:05:00Z"),
            body: big,
          }),
          mk({
            id: "teams:a@example.test:3",
            threadId: "chat-1",
            sentAt: new Date("2026-04-13T10:10:00Z"),
            body: "short c",
          }),
        ],
      },
    });
    const result = await handleGetThread(store, clock, {
      thread_id: "chat-1",
      include_body: true,
    });
    expect(result.messages[0]?.bodyTruncated).toBeUndefined();
    expect(result.messages[0]?.body).toBe("short a");
    expect(result.messages[1]?.bodyTruncated).toBe(true);
    expect(result.messages[1]?.body?.endsWith(TRUNCATION_SENTINEL)).toBe(true);
    expect(result.messages[2]?.bodyTruncated).toBeUndefined();
    expect(result.messages[2]?.body).toBe("short c");
    expect(result.bodyBudgetExhausted).toBeUndefined();
  });

  it("projects body on every message when include_body is true and bodies fit", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mk({
            id: "teams:a@example.test:1",
            threadId: "chat-1",
            sentAt: new Date("2026-04-13T10:00:00Z"),
            body: "first message body",
          }),
          mk({
            id: "teams:a@example.test:2",
            threadId: "chat-1",
            sentAt: new Date("2026-04-13T10:05:00Z"),
            body: "second message body",
          }),
          mk({
            id: "teams:a@example.test:3",
            threadId: "chat-1",
            sentAt: new Date("2026-04-13T10:10:00Z"),
            body: "third message body",
          }),
        ],
      },
    });
    const result = await handleGetThread(store, clock, {
      thread_id: "chat-1",
      include_body: true,
    });
    expect(result.count).toBe(3);
    expect(result.messages.map((m) => m.body)).toEqual([
      "first message body",
      "second message body",
      "third message body",
    ]);
    expect(result.messages.every((m) => m.bodyTruncated === undefined)).toBe(
      true,
    );
    expect(result.bodyBudgetExhausted).toBeUndefined();
  });

  it("marks bodyBudgetExhausted when cumulative bodies exceed the per-call budget", async () => {
    const chunk = "y".repeat(MAX_BODY_CHARS);
    const store = new InMemoryMessageStore({
      seed: {
        messages: Array.from({ length: 10 }, (_, i) =>
          mk({
            id: `teams:a@example.test:${i + 1}`,
            threadId: "chat-1",
            sentAt: new Date(`2026-04-13T10:${String(i).padStart(2, "0")}:00Z`),
            body: chunk,
          }),
        ),
      },
    });
    const result = await handleGetThread(store, clock, {
      thread_id: "chat-1",
      include_body: true,
    });
    expect(result.count).toBe(10);
    expect(result.bodyBudgetExhausted).toBe(true);
    const withBody = result.messages.filter((m) => m.body !== undefined);
    const withoutBody = result.messages.filter((m) => m.body === undefined);
    expect(withBody.length).toBeGreaterThan(0);
    expect(withoutBody.length).toBeGreaterThan(0);
    expect(withBody.length + withoutBody.length).toBe(10);
  });

  it("defaults to include_body=false when the flag is omitted", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mk({
            id: "teams:a@example.test:1",
            threadId: "chat-1",
            body: "should not appear",
          }),
        ],
      },
    });
    const result = await handleGetThread(store, clock, {
      thread_id: "chat-1",
    });
    expect(result.messages[0]?.body).toBeUndefined();
    expect(result.bodyBudgetExhausted).toBeUndefined();
  });

  it("omits body when include_body is explicitly false", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mk({
            id: "teams:a@example.test:1",
            threadId: "chat-1",
            body: "should not appear",
          }),
        ],
      },
    });
    const result = await handleGetThread(store, clock, {
      thread_id: "chat-1",
      include_body: false,
    });
    expect(result.messages[0]?.body).toBeUndefined();
  });

  it("rejects non-boolean include_body with InvalidParamsError", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleGetThread(store, clock, {
        thread_id: "chat-1",
        include_body: "yes" as unknown as boolean,
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });
});
