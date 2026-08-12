import { describe, expect, it } from "vitest";
import type { CalendarViewDeltaPage } from "../sources/calendar.js";
import {
  FakeCalendarClient,
  UnknownCalendarAccountError,
  UnknownCalendarCursorError,
} from "./fake-calendar-client.js";

function page(overrides: Partial<CalendarViewDeltaPage> = {}): CalendarViewDeltaPage {
  return { events: [], removedIds: [], ...overrides };
}

describe("FakeCalendarClient", () => {
  it("FakeCalendarClient walks pages by cursor and resolves the deltaLink", async () => {
    const firstPage = page({ nextLink: "cursor-2" });
    const secondPage = page({ deltaLink: "final-delta-token" });
    const client = new FakeCalendarClient({
      pages: {
        __initial__: firstPage,
        "cursor-2": secondPage,
      },
      allowedAccounts: ["a@example.test"],
    });

    const first = await client.listCalendarViewDelta({
      account: "a@example.test",
    });
    expect(first).toBe(firstPage);
    expect(first.deltaLink).toBeUndefined();

    const second = await client.listCalendarViewDelta({
      account: "a@example.test",
      cursor: first.nextLink,
    });
    expect(second).toBe(secondPage);
    expect(second.deltaLink).toBe("final-delta-token");
    expect(second.nextLink).toBeUndefined();
  });

  it("FakeCalendarClient throws on an unknown cursor so loop bugs surface early", async () => {
    const client = new FakeCalendarClient({
      pages: { __initial__: page() },
      allowedAccounts: ["a@example.test"],
    });

    await expect(
      client.listCalendarViewDelta({
        account: "a@example.test",
        cursor: "bogus-cursor",
      }),
    ).rejects.toThrow(/no scripted page for cursor "bogus-cursor"/);

    await expect(
      client.listCalendarViewDelta({
        account: "a@example.test",
        cursor: "cursor-for-a-different-account",
      }),
    ).rejects.toThrow(UnknownCalendarCursorError);
  });

  it("FakeCalendarClient rejects unknown accounts", async () => {
    const client = new FakeCalendarClient({
      pages: { __initial__: page() },
      allowedAccounts: ["a@example.test", "b@example.test"],
    });

    await expect(
      client.listCalendarViewDelta({ account: "typo@example.test" }),
    ).rejects.toThrow(/account not in allow-list: typo@example\.test/);

    // Multi-account fixture isolation: rejecting one account doesn't taint
    // the allow-list check for a different, legitimately allow-listed one.
    await expect(
      client.listCalendarViewDelta({ account: "a@example.test" }),
    ).resolves.toBeDefined();
    await expect(
      client.listCalendarViewDelta({ account: "b@example.test" }),
    ).resolves.toBeDefined();
  });

  it("FakeCalendarClient records every call", async () => {
    const client = new FakeCalendarClient({
      pages: { __initial__: page() },
      allowedAccounts: ["a@example.test"],
    });
    await client.listCalendarViewDelta({ account: "a@example.test" });
    expect(client.calls).toEqual([{ account: "a@example.test" }]);
  });
});
