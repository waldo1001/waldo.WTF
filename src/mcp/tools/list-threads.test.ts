import { describe, expect, it } from "vitest";
import { FakeClock } from "../../testing/fake-clock.js";
import { InMemoryMessageStore } from "../../testing/in-memory-message-store.js";
import type { Message } from "../../store/types.js";
import { InvalidParamsError } from "./get-recent-activity.js";
import {
  LIST_THREADS_TOOL,
  handleListThreads,
  type ListThreadsParams,
} from "./list-threads.js";

const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));

const mk = (overrides: Partial<Message> & Pick<Message, "id">): Message => ({
  source: "whatsapp",
  account: "a@example.test",
  nativeId: `native-${overrides.id}`,
  sentAt: new Date("2026-04-13T10:00:00Z"),
  importedAt: new Date("2026-04-13T10:05:00Z"),
  ...overrides,
});

describe("LIST_THREADS_TOOL descriptor", () => {
  it("is named list_threads and requires source", () => {
    expect(LIST_THREADS_TOOL.name).toBe("list_threads");
    expect(LIST_THREADS_TOOL.inputSchema.required).toEqual(["source"]);
    expect(LIST_THREADS_TOOL.inputSchema.properties.source.enum).toEqual([
      "outlook",
      "teams",
      "whatsapp",
    ]);
  });

  it("description notes list_threads is unaffected by steering", () => {
    expect(LIST_THREADS_TOOL.description).toMatch(/steering/i);
  });
});

describe("handleListThreads", () => {
  it("rejects missing source with InvalidParamsError", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleListThreads(store, clock, {} as unknown as ListThreadsParams),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects unknown source with InvalidParamsError", async () => {
    const store = new InMemoryMessageStore();
    await expect(
      handleListThreads(store, clock, {
        source: "signal" as unknown as ListThreadsParams["source"],
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("returns projected threads with ISO timestamps and ordered newest-first", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mk({
            id: "w1",
            threadId: "General chat",
            threadName: "General chat",
            sentAt: new Date("2026-04-09T10:00:00Z"),
          }),
          mk({
            id: "w2",
            threadId: "General chat",
            threadName: "General chat",
            sentAt: new Date("2026-04-09T11:00:00Z"),
          }),
          mk({
            id: "w3",
            threadId: "General chat (BC Dev Talk)",
            threadName: "General chat (BC Dev Talk)",
            sentAt: new Date("2026-04-21T08:00:00Z"),
          }),
        ],
      },
    });
    const result = await handleListThreads(store, clock, { source: "whatsapp" });
    expect(result.count).toBe(2);
    expect(result.threads).toEqual([
      {
        source: "whatsapp",
        threadId: "General chat (BC Dev Talk)",
        threadName: "General chat (BC Dev Talk)",
        messageCount: 1,
        newestSentAt: "2026-04-21T08:00:00.000Z",
        oldestSentAt: "2026-04-21T08:00:00.000Z",
      },
      {
        source: "whatsapp",
        threadId: "General chat",
        threadName: "General chat",
        messageCount: 2,
        newestSentAt: "2026-04-09T11:00:00.000Z",
        oldestSentAt: "2026-04-09T10:00:00.000Z",
      },
    ]);
  });

  it("omits threadName when absent on every message in the thread", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          mk({
            id: "bare",
            source: "outlook",
            threadId: "thr-bare",
            sentAt: new Date("2026-04-13T10:00:00Z"),
          }),
        ],
      },
    });
    const result = await handleListThreads(store, clock, { source: "outlook" });
    expect(result.threads).toHaveLength(1);
    expect(
      (result.threads[0] as unknown as { threadName?: unknown }).threadName,
    ).toBeUndefined();
  });

  it("returns empty threads array for a source with no messages", async () => {
    const store = new InMemoryMessageStore();
    const result = await handleListThreads(store, clock, { source: "teams" });
    expect(result).toEqual({ count: 0, threads: [] });
  });
});
