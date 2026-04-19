import { describe, it, expect } from "vitest";
import { InMemoryMessageStore } from "../../testing/in-memory-message-store.js";
import { FakeClock } from "../../testing/fake-clock.js";
import {
  handleSearch,
  SEARCH_TOOL,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
} from "./search.js";
import {
  MAX_BODY_CHARS,
  TRUNCATION_SENTINEL,
} from "./body-projection.js";
import { InvalidParamsError } from "./get-recent-activity.js";
import type { Message } from "../../store/types.js";

const mkMessage = (
  overrides: Partial<Message> & Pick<Message, "id">,
): Message => ({
  source: "outlook",
  account: "a@example.test",
  nativeId: `native-${overrides.id}`,
  sentAt: new Date("2026-04-13T09:00:00Z"),
  importedAt: new Date("2026-04-13T09:05:00Z"),
  ...overrides,
});

const clockAt = (iso: string): FakeClock => new FakeClock(new Date(iso));

describe("handleSearch", () => {
  it("rejects empty query with invalid-params", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleSearch(store, clock, { query: "" }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects whitespace-only query", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleSearch(store, clock, { query: "   \t\n " }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects non-string query", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleSearch(store, clock, {
        query: 42 as unknown as string,
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects limit <= 0", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleSearch(store, clock, { query: "hello", limit: 0 }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects non-finite limit", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleSearch(store, clock, { query: "hello", limit: Number.NaN }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it(`rejects limit > ${MAX_SEARCH_LIMIT}`, async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleSearch(store, clock, {
        query: "hello",
        limit: MAX_SEARCH_LIMIT + 1,
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it(`defaults limit to ${DEFAULT_SEARCH_LIMIT} when omitted and passes through to store`, async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await handleSearch(store, clock, { query: "hello" });
    const call = store.calls.find((c) => c.method === "searchMessages");
    expect(call).toEqual({
      method: "searchMessages",
      query: "hello",
      limit: DEFAULT_SEARCH_LIMIT,
    });
  });

  it("passes explicit limit through", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await handleSearch(store, clock, { query: "hello", limit: 5 });
    const call = store.calls.find((c) => c.method === "searchMessages");
    expect(call).toEqual({
      method: "searchMessages",
      query: "hello",
      limit: 5,
    });
  });

  it("projects hits and strips body/bodyHtml/rawJson while keeping snippet+rank", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "m1",
            body: "the quick brown fox",
            bodyHtml: "<p>nope</p>",
            rawJson: "{\"secret\":\"x\"}",
            threadName: "Foxes",
            senderName: "Alice",
            senderEmail: "alice@example.test",
            sentAt: new Date("2026-04-13T11:00:00Z"),
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = await handleSearch(store, clock, { query: "quick" });
    expect(result.count).toBe(1);
    const hit = result.hits[0];
    expect(hit).toBeDefined();
    expect(hit?.message).toEqual({
      id: "m1",
      source: "outlook",
      account: "a@example.test",
      threadName: "Foxes",
      senderName: "Alice",
      senderEmail: "alice@example.test",
      sentAt: "2026-04-13T11:00:00.000Z",
    });
    expect(Object.keys(hit?.message ?? {})).not.toContain("rawJson");
    expect(Object.keys(hit?.message ?? {})).not.toContain("bodyHtml");
    expect(Object.keys(hit?.message ?? {})).not.toContain("body");
    expect(hit?.snippet).toBe("the quick brown fox");
    expect(hit?.rank).toBe(0);
  });

  it("returns count equal to hits length and empty when no matches", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({ id: "m1", body: "hello world" }),
          mkMessage({ id: "m2", body: "goodbye world" }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const none = await handleSearch(store, clock, { query: "zzz" });
    expect(none.count).toBe(0);
    expect(none.hits).toHaveLength(0);

    const hit = await handleSearch(store, clock, { query: "world" });
    expect(hit.count).toBe(2);
    expect(hit.hits).toHaveLength(2);
  });

  it("projects Teams-specific fields on search hits", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "t1",
            source: "teams",
            chatType: "channel",
            replyToId: "root",
            mentions: ["bob@example.test"],
            body: "teamhit",
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = await handleSearch(store, clock, { query: "teamhit" });
    expect(result.count).toBe(1);
    const msg = result.hits[0]?.message;
    expect(msg?.source).toBe("teams");
    expect(msg?.chatType).toBe("channel");
    expect(msg?.replyToId).toBe("root");
    expect(msg?.mentions).toEqual(["bob@example.test"]);
  });

  it("projects threadId when the message has one", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({
            id: "with-thread",
            source: "teams",
            threadId: "chat-abc",
            body: "needle one",
          }),
          mkMessage({
            id: "without-thread",
            body: "needle two",
          }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = await handleSearch(store, clock, { query: "needle" });
    const withT = result.hits.find((h) => h.message.id === "with-thread");
    const withoutT = result.hits.find((h) => h.message.id === "without-thread");
    expect(withT?.message.threadId).toBe("chat-abc");
    expect(withoutT).toBeDefined();
    expect(Object.keys(withoutT?.message ?? {})).not.toContain("threadId");
  });

  it("exposes a tool descriptor with a valid JSON-schema input", () => {
    expect(SEARCH_TOOL.name).toBe("search");
    expect(SEARCH_TOOL.inputSchema.type).toBe("object");
    expect(SEARCH_TOOL.inputSchema.required).toContain("query");
  });

  it("description includes multilingual search guidance", () => {
    expect(SEARCH_TOOL.description).toContain("Language matters");
    expect(SEARCH_TOOL.description).toContain("spaghettisaus");
    expect(SEARCH_TOOL.description).toContain("Empty results are not proof of absence");
  });

  it("rejects non-boolean include_body with InvalidParamsError", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    await expect(
      handleSearch(store, clock, {
        query: "hello",
        include_body: "yes" as unknown as boolean,
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("omits body when include_body is false", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [mkMessage({ id: "m1", body: "private text" })],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = await handleSearch(store, clock, {
      query: "private",
      include_body: false,
    });
    expect(result.hits[0]?.message.body).toBeUndefined();
    expect(result.bodyBudgetExhausted).toBeUndefined();
  });

  it("projects body on every hit when include_body is true", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mkMessage({ id: "m1", body: "one two three" }),
          mkMessage({ id: "m2", body: "three four five" }),
        ],
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = await handleSearch(store, clock, {
      query: "three",
      include_body: true,
    });
    const bodies = result.hits.map((h) => h.message.body).sort();
    expect(bodies).toEqual(["one two three", "three four five"]);
    expect(result.hits.every((h) => h.message.bodyTruncated === undefined)).toBe(
      true,
    );
    expect(result.bodyBudgetExhausted).toBeUndefined();
  });

  it("marks bodyBudgetExhausted when cumulative hit bodies exceed the per-call budget", async () => {
    const token = "needle";
    const big = token + " " + "z".repeat(MAX_BODY_CHARS - token.length - 1);
    const store = new InMemoryMessageStore({
      seed: {
        messages: Array.from({ length: 10 }, (_, i) =>
          mkMessage({ id: `m${i}`, body: big }),
        ),
      },
    });
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = await handleSearch(store, clock, {
      query: token,
      include_body: true,
      limit: 10,
    });
    expect(result.count).toBe(10);
    expect(result.bodyBudgetExhausted).toBe(true);
    const withBody = result.hits.filter((h) => h.message.body !== undefined);
    const withoutBody = result.hits.filter((h) => h.message.body === undefined);
    expect(withBody.length).toBeGreaterThan(0);
    expect(withoutBody.length).toBeGreaterThan(0);
  });
});
