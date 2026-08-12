import { describe, expect, it, vi } from "vitest";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { composeRecentItems } from "./message-store.js";
import { runMessageStoreContract } from "./message-store-contract.js";

runMessageStoreContract("InMemoryMessageStore", () => {
  const store = new InMemoryMessageStore();
  return {
    store,
    readSyncLog: () => store.syncLog,
  };
});

describe("composeRecentItems", () => {
  function spyStore() {
    return {
      getRecentMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], mutedCount: 0 }),
      findEvents: vi.fn().mockResolvedValue({ events: [], truncated: false }),
    };
  }
  const window = {
    from: new Date("2026-04-01T00:00:00Z"),
    to: new Date("2026-04-30T00:00:00Z"),
  };

  it("omits sources/accounts/includeMuted from getRecentMessages when not set on opts", async () => {
    const store = spyStore();
    await composeRecentItems(store, { ...window, kinds: ["message"] });
    // toStrictEqual (not toHaveBeenCalledWith) so a key present with an
    // undefined value is distinguished from the key being absent.
    expect(store.getRecentMessages.mock.calls[0]?.[0]).toStrictEqual({
      since: window.from,
      limit: 500,
    });
  });

  it("forwards sources/accounts/includeMuted to getRecentMessages exactly when set on opts", async () => {
    const store = spyStore();
    await composeRecentItems(store, {
      ...window,
      kinds: ["message"],
      sources: ["teams"],
      accounts: ["a@example.test"],
      includeMuted: true,
    });
    expect(store.getRecentMessages.mock.calls[0]?.[0]).toStrictEqual({
      since: window.from,
      sources: ["teams"],
      accounts: ["a@example.test"],
      limit: 500,
      includeMuted: true,
    });
  });

  it("omits accounts from findEvents when not set on opts, always orders desc", async () => {
    const store = spyStore();
    await composeRecentItems(store, { ...window, kinds: ["event"] });
    expect(store.findEvents.mock.calls[0]?.[0]).toStrictEqual({
      from: window.from,
      to: window.to,
      order: "desc",
      limit: 500,
    });
  });

  it("forwards accounts to findEvents exactly when set on opts", async () => {
    const store = spyStore();
    await composeRecentItems(store, {
      ...window,
      kinds: ["event"],
      accounts: ["a@example.test"],
    });
    expect(store.findEvents.mock.calls[0]?.[0]).toStrictEqual({
      from: window.from,
      to: window.to,
      accounts: ["a@example.test"],
      order: "desc",
      limit: 500,
    });
  });

  it("calls neither sub-fetch for a kind not requested", async () => {
    const store = spyStore();
    await composeRecentItems(store, { ...window, kinds: ["message"] });
    expect(store.findEvents).not.toHaveBeenCalled();

    const store2 = spyStore();
    await composeRecentItems(store2, { ...window, kinds: ["event"] });
    expect(store2.getRecentMessages).not.toHaveBeenCalled();
  });
});
