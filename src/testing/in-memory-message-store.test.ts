import { describe, expect, it } from "vitest";
import type { Message, SyncStateEntry } from "../store/types.js";
import { InMemoryMessageStore } from "./in-memory-message-store.js";

const sampleMessage = (id: string): Message => ({
  id,
  source: "outlook",
  account: "a@example.test",
  nativeId: `native-${id}`,
  sentAt: new Date("2026-04-13T10:00:00Z"),
  importedAt: new Date("2026-04-13T10:05:00Z"),
});

describe("InMemoryMessageStore", () => {
  it("exposes seeded messages via upsert (id collision reports as update)", async () => {
    const store = new InMemoryMessageStore({
      seed: { messages: [sampleMessage("seed-1")] },
    });
    const result = await store.upsertMessages([sampleMessage("seed-1")]);
    expect(result).toEqual({ added: 0, updated: 1 });
  });

  it("exposes seeded sync state via getSyncState", async () => {
    const entry: SyncStateEntry = {
      account: "a@example.test",
      source: "teams",
      deltaToken: "seeded",
    };
    const store = new InMemoryMessageStore({ seed: { syncState: [entry] } });
    expect(await store.getSyncState("a@example.test", "teams")).toEqual(entry);
  });

  it("records each call with method name and args in order", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertMessages([sampleMessage("1")]);
    await store.deleteMessages(["1"]);
    await store.getSyncState("a@example.test", "outlook");
    await store.setSyncState({
      account: "a@example.test",
      source: "outlook",
      deltaToken: "x",
    });
    expect(store.calls.map((c) => c.method)).toEqual([
      "upsertMessages",
      "deleteMessages",
      "getSyncState",
      "setSyncState",
    ]);
    const upsertCall = store.calls[0];
    if (upsertCall.method !== "upsertMessages") throw new Error("unreachable");
    expect(upsertCall.messages).toHaveLength(1);
    expect(upsertCall.messages[0].id).toBe("1");
  });

  it("two instances do not share state", async () => {
    const a = new InMemoryMessageStore();
    const b = new InMemoryMessageStore();
    await a.upsertMessages([sampleMessage("1")]);
    await a.setSyncState({
      account: "a@example.test",
      source: "outlook",
      deltaToken: "a-only",
    });
    expect(await b.getSyncState("a@example.test", "outlook")).toBeNull();
    const reAdd = await b.upsertMessages([sampleMessage("1")]);
    expect(reAdd).toEqual({ added: 1, updated: 0 });
  });
});
