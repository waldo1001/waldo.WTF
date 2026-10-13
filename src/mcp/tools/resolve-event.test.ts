import { describe, expect, it } from "vitest";
import { InMemoryMessageStore } from "../../testing/in-memory-message-store.js";
import type { CalendarEvent } from "../../store/types.js";
import { InvalidParamsError } from "./get-recent-activity.js";
import { resolveEvent } from "./resolve-event.js";

const event = (account: string, eventId: string): CalendarEvent => ({
  account,
  eventId,
  startAt: new Date("2026-04-13T10:00:00Z"),
  endAt: new Date("2026-04-13T11:00:00Z"),
  isAllDay: false,
  isCancelled: false,
  attendees: [],
});

const storeWith = async (
  accounts: readonly string[],
  events: readonly CalendarEvent[],
): Promise<InMemoryMessageStore> => {
  const store = new InMemoryMessageStore();
  for (const username of accounts) {
    await store.upsertAccount({ username, addedAt: new Date("2026-04-01T00:00:00Z") });
  }
  await store.upsertEvents(events);
  return store;
};

describe("resolveEvent", () => {
  it("finds an event that exists under only one of several accounts", async () => {
    const store = await storeWith(
      ["a@example.test", "b@example.test"],
      [event("b@example.test", "evt-1")],
    );
    expect((await resolveEvent(store, "evt-1", undefined))?.account).toBe("b@example.test");
  });

  it("returns null when no account has the event", async () => {
    const store = await storeWith(["a@example.test", "b@example.test"], []);
    expect(await resolveEvent(store, "evt-missing", undefined)).toBeNull();
  });

  it("returns null when there are no accounts at all", async () => {
    const store = await storeWith([], []);
    expect(await resolveEvent(store, "evt-1", undefined)).toBeNull();
  });

  it("rejects an event id that exists under several accounts", async () => {
    const store = await storeWith(
      ["a@example.test", "b@example.test"],
      [event("a@example.test", "evt-1"), event("b@example.test", "evt-1")],
    );
    await expect(resolveEvent(store, "evt-1", undefined)).rejects.toThrow(InvalidParamsError);
  });

  it("looks up directly when the account is given", async () => {
    const store = await storeWith(["a@example.test"], [event("a@example.test", "evt-1")]);
    expect((await resolveEvent(store, "evt-1", "a@example.test"))?.eventId).toBe("evt-1");
  });
});
