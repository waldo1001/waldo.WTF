import { describe, expect, it } from "vitest";
import type { Account } from "../auth/types.js";
import { FakeClock } from "../testing/fake-clock.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import {
  DeltaTokenInvalidError,
  GraphRateLimitedError,
  TokenExpiredError,
  type CalendarClient,
  type CalendarViewDeltaInput,
  type CalendarViewDeltaPage,
} from "../sources/calendar.js";
import type { CalendarEvent } from "../store/types.js";
import {
  CALENDAR_WINDOW_BACK_DAYS,
  CALENDAR_WINDOW_FORWARD_DAYS,
  syncCalendarEvents,
} from "./sync-calendar.js";

const account: Account = {
  username: "a@example.test",
  homeAccountId: "home-1",
  tenantId: "tenant-1",
};

function event(overrides: Partial<CalendarEvent> & Pick<CalendarEvent, "eventId">): CalendarEvent {
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

class ScriptedCalendarClient implements CalendarClient {
  readonly calls: CalendarViewDeltaInput[] = [];
  private index = 0;
  constructor(private readonly steps: (CalendarViewDeltaPage | Error)[]) {}

  async listCalendarViewDelta(
    input: CalendarViewDeltaInput,
  ): Promise<CalendarViewDeltaPage> {
    this.calls.push(input);
    const step = this.steps[this.index++];
    if (step === undefined) {
      throw new Error(`ScriptedCalendarClient: no step #${this.index}`);
    }
    if (step instanceof Error) throw step;
    return step;
  }
}

describe("syncCalendarEvents", () => {
  it("first sync uses the rolling [now-365d, now+60d] window", async () => {
    const clock = new FakeClock(new Date("2026-08-12T12:00:00Z"));
    const store = new InMemoryMessageStore();
    const client = new ScriptedCalendarClient([
      { events: [], removedIds: [], deltaLink: "delta-1" },
    ]);
    await syncCalendarEvents({ account, store, calendar: client, clock });
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0]!;
    expect(call.cursor).toBeUndefined();
    const expectedStart = new Date(
      clock.now().getTime() - CALENDAR_WINDOW_BACK_DAYS * 86_400_000,
    ).toISOString();
    const expectedEnd = new Date(
      clock.now().getTime() + CALENDAR_WINDOW_FORWARD_DAYS * 86_400_000,
    ).toISOString();
    expect(call.windowStartIso).toBe(expectedStart);
    expect(call.windowEndIso).toBe(expectedEnd);
  });

  it("subsequent sync resumes from the stored delta link", async () => {
    const clock = new FakeClock(new Date("2026-08-12T12:00:00Z"));
    const store = new InMemoryMessageStore();
    await store.setSyncState({
      account: account.username,
      source: "calendar",
      folder: "default",
      deltaToken: "stored-delta-link",
    });
    const client = new ScriptedCalendarClient([
      { events: [], removedIds: [], deltaLink: "delta-2" },
    ]);
    await syncCalendarEvents({ account, store, calendar: client, clock });
    expect(client.calls[0]!.cursor).toBe("stored-delta-link");
    expect(client.calls[0]!.windowStartIso).toBeUndefined();
  });

  it("events are upserted page-by-page so a mid-walk crash leaves a usable lake", async () => {
    const clock = new FakeClock(new Date("2026-08-12T12:00:00Z"));
    const store = new InMemoryMessageStore();
    const client = new ScriptedCalendarClient([
      { events: [event({ eventId: "evt-p1" })], removedIds: [], nextLink: "page-2" },
      { events: [event({ eventId: "evt-p2" })], removedIds: [], nextLink: "page-3" },
      new GraphRateLimitedError(30),
    ]);
    const result = await syncCalendarEvents({ account, store, calendar: client, clock });
    expect(result.added).toBe(2);
    const events = await store.getEventsInRange(
      "a@example.test",
      new Date("2026-04-01T00:00:00Z"),
      new Date("2026-04-30T00:00:00Z"),
    );
    expect(events.map((e) => e.eventId).sort()).toEqual(["evt-p1", "evt-p2"]);
    const state = await store.getSyncState(account.username, "calendar", "default");
    expect(state?.deltaToken).toBe("page-3");
  });

  it("removedIds become deleteEvents on the store", async () => {
    const clock = new FakeClock(new Date("2026-08-12T12:00:00Z"));
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-gone" })]);
    const client = new ScriptedCalendarClient([
      { events: [], removedIds: ["evt-gone"], deltaLink: "delta-3" },
    ]);
    const result = await syncCalendarEvents({ account, store, calendar: client, clock });
    expect(result.removed).toBe(1);
    const events = await store.getEventsInRange(
      "a@example.test",
      new Date("2026-04-01T00:00:00Z"),
      new Date("2026-04-30T00:00:00Z"),
    );
    expect(events).toEqual([]);
  });

  it("second TokenExpiredError (client already retried once internally) surfaces to the caller", async () => {
    const clock = new FakeClock(new Date("2026-08-12T12:00:00Z"));
    const store = new InMemoryMessageStore();
    const client = new ScriptedCalendarClient([new TokenExpiredError()]);
    await expect(
      syncCalendarEvents({ account, store, calendar: client, clock }),
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("delta-invalid clears the stored cursor and restarts from the window on the next call", async () => {
    const clock = new FakeClock(new Date("2026-08-12T12:00:00Z"));
    const store = new InMemoryMessageStore();
    await store.setSyncState({
      account: account.username,
      source: "calendar",
      folder: "default",
      deltaToken: "stale-delta-link",
    });
    const logged: string[] = [];
    const logger = {
      info: (message: string) => {
        logged.push(message);
      },
      error: () => {},
    };
    const client = new ScriptedCalendarClient([new DeltaTokenInvalidError()]);
    const result = await syncCalendarEvents({
      account,
      store,
      calendar: client,
      clock,
      logger,
    });
    expect(result).toEqual({ added: 0, removed: 0 });
    expect(
      logged.some((l) => l.startsWith("calendar_delta_cursor_reset")),
    ).toBe(true);
    const state = await store.getSyncState(account.username, "calendar", "default");
    expect(state?.deltaToken).toBeUndefined();

    // Next call uses the window again, not the (now-cleared) stale cursor.
    const client2 = new ScriptedCalendarClient([
      { events: [], removedIds: [], deltaLink: "fresh-delta" },
    ]);
    await syncCalendarEvents({ account, store, calendar: client2, clock });
    expect(client2.calls[0]!.cursor).toBeUndefined();
    expect(client2.calls[0]!.windowStartIso).toBeDefined();
  });

  it("rate-limit stops the walk and leaves the cursor untouched when hit on the first page", async () => {
    const clock = new FakeClock(new Date("2026-08-12T12:00:00Z"));
    const store = new InMemoryMessageStore();
    const client = new ScriptedCalendarClient([new GraphRateLimitedError(60)]);
    const result = await syncCalendarEvents({ account, store, calendar: client, clock });
    expect(result).toEqual({ added: 0, removed: 0 });
    const state = await store.getSyncState(account.username, "calendar", "default");
    expect(state?.deltaToken).toBeUndefined();
  });

  it("transient-5xx stops the walk the same way rate-limit does", async () => {
    const clock = new FakeClock(new Date("2026-08-12T12:00:00Z"));
    const store = new InMemoryMessageStore();
    const client = new ScriptedCalendarClient([
      new Error("calendar request failed: HTTP 503: unavailable"),
    ]);
    const result = await syncCalendarEvents({ account, store, calendar: client, clock });
    expect(result).toEqual({ added: 0, removed: 0 });
  });

  it("an unrecognized error is not swallowed — it propagates", async () => {
    const clock = new FakeClock(new Date("2026-08-12T12:00:00Z"));
    const store = new InMemoryMessageStore();
    const client = new ScriptedCalendarClient([new Error("totally unexpected")]);
    await expect(
      syncCalendarEvents({ account, store, calendar: client, clock }),
    ).rejects.toThrow("totally unexpected");
  });

  it("walks multiple pages to completion and sets lastSyncAt", async () => {
    const clock = new FakeClock(new Date("2026-08-12T12:00:00Z"));
    const store = new InMemoryMessageStore();
    const client = new ScriptedCalendarClient([
      { events: [event({ eventId: "evt-1" })], removedIds: [], nextLink: "page-2" },
      { events: [event({ eventId: "evt-2" })], removedIds: [], deltaLink: "final-delta" },
    ]);
    const result = await syncCalendarEvents({ account, store, calendar: client, clock });
    expect(result).toEqual({ added: 2, removed: 0 });
    expect(client.calls[1]!.cursor).toBe("page-2");
    const state = await store.getSyncState(account.username, "calendar", "default");
    expect(state?.deltaToken).toBe("final-delta");
    expect(state?.lastSyncAt).toEqual(clock.now());
  });
});
