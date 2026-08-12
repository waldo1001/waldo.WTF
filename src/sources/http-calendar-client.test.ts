import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeltaTokenInvalidError, GraphRateLimitedError, TokenExpiredError } from "./graph.js";
import type { FetchLike, FetchLikeResponse } from "./http-graph-client.js";
import { createFetchWithTimeout } from "./fetch-with-timeout.js";
import { HttpCalendarClient } from "./http-calendar-client.js";

interface ScriptedCall {
  url: string;
  headers: Record<string, string>;
}

function response(init: {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}): FetchLikeResponse {
  const hdrs = init.headers ?? {};
  return {
    status: init.status,
    headers: {
      get(name: string) {
        const key = Object.keys(hdrs).find(
          (k) => k.toLowerCase() === name.toLowerCase(),
        );
        return key ? hdrs[key]! : null;
      },
    },
    async text() {
      return init.body ?? "";
    },
  };
}

function scriptFetch(steps: FetchLikeResponse[]): {
  fetch: FetchLike;
  calls: ScriptedCall[];
} {
  const calls: ScriptedCall[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: { ...(init?.headers ?? {}) } });
    const step = steps[i++];
    if (!step) throw new Error(`scriptFetch: no scripted response #${i}`);
    return step;
  };
  return { fetch, calls };
}

function tokenFor(token: string) {
  return async () => token;
}

describe("HttpCalendarClient.listCalendarViewDelta — initial call", () => {
  it("initial call requests calendarView/delta with UTC timezone and the window", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpCalendarClient({ fetch, getAccessToken: tokenFor("tok-1") });
    await client.listCalendarViewDelta({
      account: "a@example.test",
      windowStartIso: "2026-04-06T00:00:00Z",
      windowEndIso: "2026-05-13T00:00:00Z",
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toContain("https://graph.microsoft.com/v1.0/me/calendarView/delta");
    expect(call.url).toContain("startDateTime=2026-04-06T00%3A00%3A00Z");
    expect(call.url).toContain("endDateTime=2026-05-13T00%3A00%3A00Z");
    expect(call.headers["Authorization"]).toBe("Bearer tok-1");
    expect(call.headers["Prefer"]).toContain('outlook.timezone="UTC"');
    expect(call.headers["Prefer"]).toContain('outlook.body-content-type="text"');
    expect(call.headers["Prefer"]).toContain("odata.maxpagesize=50");
  });

  it("resolves the access token via account + scope, not a caller-supplied token", async () => {
    const calls: { account: string; scope: string; forceRefresh: boolean }[] = [];
    const { fetch } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpCalendarClient({
      fetch,
      getAccessToken: async (account, scope, forceRefresh) => {
        calls.push({ account, scope, forceRefresh });
        return "tok-resolved";
      },
    });
    await client.listCalendarViewDelta({ account: "a@example.test" });
    expect(calls).toEqual([
      {
        account: "a@example.test",
        scope: "https://graph.microsoft.com/Calendars.Read",
        forceRefresh: false,
      },
    ]);
  });
});

describe("HttpCalendarClient.listCalendarViewDelta — cursor walk", () => {
  it("subsequent call follows the @odata.nextLink cursor", async () => {
    const cursor = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=abc&x=1";
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpCalendarClient({ fetch, getAccessToken: tokenFor("t") });
    await client.listCalendarViewDelta({ account: "a@example.test", cursor });
    expect(calls[0]!.url).toBe(cursor);
  });

  it("refuses a cursor pointing at an unexpected host", async () => {
    const { fetch } = scriptFetch([]);
    const client = new HttpCalendarClient({ fetch, getAccessToken: tokenFor("t") });
    await expect(
      client.listCalendarViewDelta({
        account: "a@example.test",
        cursor: "https://evil.invalid/steal-me",
      }),
    ).rejects.toThrow(/unexpected host/);
  });
});

describe("HttpCalendarClient.listCalendarViewDelta — page shape", () => {
  it("page lowers Graph events into CalendarEvent rows via shared mapping", async () => {
    const payload = {
      value: [
        {
          id: "evt-1",
          subject: "In person",
          start: { dateTime: "2026-04-13T10:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-04-13T11:00:00.0000000", timeZone: "UTC" },
        },
        {
          id: "evt-2",
          subject: "Online",
          start: { dateTime: "2026-04-13T14:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-04-13T15:00:00.0000000", timeZone: "UTC" },
          onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
        },
      ],
    };
    const { fetch } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const client = new HttpCalendarClient({ fetch, getAccessToken: tokenFor("t") });
    const page = await client.listCalendarViewDelta({ account: "a@example.test" });
    expect(page.events).toHaveLength(2);
    expect(page.events[0]).toMatchObject({
      account: "a@example.test",
      eventId: "evt-1",
      subject: "In person",
    });
    expect(page.events[1]).toMatchObject({
      eventId: "evt-2",
      onlineMeetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
    });
  });

  it("empty value[] produces an empty events page", async () => {
    const { fetch } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpCalendarClient({ fetch, getAccessToken: tokenFor("t") });
    const page = await client.listCalendarViewDelta({ account: "a@example.test" });
    expect(page.events).toEqual([]);
    expect(page.removedIds).toEqual([]);
  });

  it("@removed entries become removedIds", async () => {
    const payload = {
      value: [
        {
          id: "evt-kept",
          start: { dateTime: "2026-04-13T10:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-04-13T11:00:00.0000000", timeZone: "UTC" },
        },
        { id: "evt-removed", "@removed": { reason: "deleted" } },
      ],
    };
    const { fetch } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const client = new HttpCalendarClient({ fetch, getAccessToken: tokenFor("t") });
    const page = await client.listCalendarViewDelta({ account: "a@example.test" });
    expect(page.events.map((e) => e.eventId)).toEqual(["evt-kept"]);
    expect(page.removedIds).toEqual(["evt-removed"]);
  });

  it("page exposes nextLink mid-walk and deltaLink on the final page", async () => {
    const midWalk = {
      value: [],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skip=1",
    };
    const finalPage = {
      value: [],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=abc",
    };
    const { fetch } = scriptFetch([
      response({ status: 200, body: JSON.stringify(midWalk) }),
      response({ status: 200, body: JSON.stringify(finalPage) }),
    ]);
    const client = new HttpCalendarClient({ fetch, getAccessToken: tokenFor("t") });

    const first = await client.listCalendarViewDelta({ account: "a@example.test" });
    expect(first.nextLink).toBe(midWalk["@odata.nextLink"]);
    expect(first.deltaLink).toBeUndefined();

    const second = await client.listCalendarViewDelta({
      account: "a@example.test",
      cursor: first.nextLink,
    });
    expect(second.deltaLink).toBe(finalPage["@odata.deltaLink"]);
    expect(second.nextLink).toBeUndefined();
  });
});

describe("HttpCalendarClient error mapping", () => {
  it("401 forces a token refresh and retries once; second 401 surfaces as TokenExpiredError", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 401, body: "no" }),
      response({ status: 401, body: "still no" }),
    ]);
    const tokenCalls: boolean[] = [];
    const client = new HttpCalendarClient({
      fetch,
      getAccessToken: async (_account, _scope, forceRefresh) => {
        tokenCalls.push(forceRefresh);
        return "t";
      },
    });
    await expect(
      client.listCalendarViewDelta({ account: "a@example.test" }),
    ).rejects.toBeInstanceOf(TokenExpiredError);
    expect(calls).toHaveLength(2);
    expect(tokenCalls).toEqual([false, true]);
  });

  it("401 then 200 succeeds on the forced-refresh retry", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 401, body: "no" }),
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpCalendarClient({ fetch, getAccessToken: tokenFor("t") });
    const page = await client.listCalendarViewDelta({ account: "a@example.test" });
    expect(page.events).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("410 on a delta cursor surfaces as DeltaTokenInvalidError", async () => {
    const { fetch } = scriptFetch([
      response({ status: 410, body: '{"error":{"code":"resyncRequired"}}' }),
    ]);
    const client = new HttpCalendarClient({ fetch, getAccessToken: tokenFor("t") });
    await expect(
      client.listCalendarViewDelta({
        account: "a@example.test",
        cursor: "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=stale",
      }),
    ).rejects.toBeInstanceOf(DeltaTokenInvalidError);
  });

  it("429 surfaces as GraphRateLimitedError with Retry-After", async () => {
    const { fetch } = scriptFetch([
      response({ status: 429, body: "", headers: { "Retry-After": "7" } }),
    ]);
    const client = new HttpCalendarClient({ fetch, getAccessToken: tokenFor("t") });
    try {
      await client.listCalendarViewDelta({ account: "a@example.test" });
      expect.fail("expected throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(GraphRateLimitedError);
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(7);
    }
  });

  it("429 defaults to 60s when Retry-After is missing or malformed", async () => {
    for (const hdr of [{}, { "Retry-After": "abc" }]) {
      const { fetch } = scriptFetch([response({ status: 429, body: "", headers: hdr })]);
      const client = new HttpCalendarClient({ fetch, getAccessToken: tokenFor("t") });
      try {
        await client.listCalendarViewDelta({ account: "a@example.test" });
        expect.fail("expected throw");
      } catch (caught) {
        expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(60);
      }
    }
  });

  it("429 defaults to 60s when Retry-After is negative", async () => {
    const { fetch } = scriptFetch([
      response({ status: 429, body: "", headers: { "Retry-After": "-1" } }),
    ]);
    const client = new HttpCalendarClient({ fetch, getAccessToken: tokenFor("t") });
    try {
      await client.listCalendarViewDelta({ account: "a@example.test" });
      expect.fail("expected throw");
    } catch (caught) {
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(60);
    }
  });

  it("non-2xx error body truncated to ≤200 chars", async () => {
    const longBody = "x".repeat(500);
    const { fetch } = scriptFetch([response({ status: 500, body: longBody })]);
    const client = new HttpCalendarClient({ fetch, getAccessToken: tokenFor("t") });
    try {
      await client.listCalendarViewDelta({ account: "a@example.test" });
      expect.fail("expected throw");
    } catch (caught) {
      const err = caught as Error;
      const excerpt = err.message.split("500: ")[1] ?? "";
      expect(excerpt.length).toBeLessThanOrEqual(200);
    }
  });

  it("bearer token is redacted from error messages", async () => {
    const secret = "tok-CALENDAR-SECRET-do-not-leak";
    const { fetch } = scriptFetch([response({ status: 500, body: `boom ${secret}` })]);
    const client = new HttpCalendarClient({
      fetch,
      getAccessToken: tokenFor(secret),
      sleep: async () => {},
      random: () => 0,
    });
    try {
      await client.listCalendarViewDelta({ account: "a@example.test" });
      expect.fail("expected throw");
    } catch (caught) {
      const msg = (caught as Error).message;
      expect(msg).not.toContain(secret);
      expect(msg).toContain("[redacted]");
    }
  });
});

describe("HttpCalendarClient transient-5xx retry", () => {
  function recordSleep(): { sleep: (ms: number) => Promise<void>; sleeps: number[] } {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    return { sleep, sleeps };
  }

  function fixedRandom(value: number): () => number {
    return () => value;
  }

  it("5xx retries once before surfacing transient-5xx: 503 then 200 succeeds", async () => {
    const payload = { value: [] };
    const { fetch, calls } = scriptFetch([
      response({ status: 503, body: "unavailable" }),
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const { sleep, sleeps } = recordSleep();
    const client = new HttpCalendarClient({
      fetch,
      getAccessToken: tokenFor("t"),
      sleep,
      random: fixedRandom(0.5),
    });
    const page = await client.listCalendarViewDelta({ account: "a@example.test" });
    expect(page.events).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it("502 / 504 follow the same retry path as 503", async () => {
    for (const status of [502, 504]) {
      const { fetch, calls } = scriptFetch([
        response({ status, body: "transient" }),
        response({ status: 200, body: JSON.stringify({ value: [] }) }),
      ]);
      const { sleep } = recordSleep();
      const client = new HttpCalendarClient({
        fetch,
        getAccessToken: tokenFor("t"),
        sleep,
        random: fixedRandom(0),
      });
      await client.listCalendarViewDelta({ account: "a@example.test" });
      expect(calls).toHaveLength(2);
    }
  });

  it("gives up after maxRetries and surfaces transient-5xx", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 503, body: "boom" }),
      response({ status: 503, body: "boom" }),
      response({ status: 503, body: "final boom" }),
    ]);
    const { sleep, sleeps } = recordSleep();
    const client = new HttpCalendarClient({
      fetch,
      getAccessToken: tokenFor("t"),
      sleep,
      random: fixedRandom(0),
    });
    await expect(
      client.listCalendarViewDelta({ account: "a@example.test" }),
    ).rejects.toThrow(/HTTP 503/);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([250, 750]);
  });

  it("jitter uses injected random source for the exact sleep duration", async () => {
    const cases: { random: number; expectedFirstSleep: number }[] = [
      { random: 0, expectedFirstSleep: 250 },
      { random: 1, expectedFirstSleep: 500 },
    ];
    for (const c of cases) {
      const { fetch } = scriptFetch([
        response({ status: 502, body: "x" }),
        response({ status: 200, body: JSON.stringify({ value: [] }) }),
      ]);
      const { sleep, sleeps } = recordSleep();
      const client = new HttpCalendarClient({
        fetch,
        getAccessToken: tokenFor("t"),
        sleep,
        random: fixedRandom(c.random),
      });
      await client.listCalendarViewDelta({ account: "a@example.test" });
      expect(sleeps[0]).toBe(c.expectedFirstSleep);
    }
  });

  it("does not apply the 5xx backoff/retry path on 410, 429, or 404 (no sleep, single HTTP call)", async () => {
    for (const status of [410, 429, 404]) {
      const { fetch, calls } = scriptFetch([response({ status, body: "no" })]);
      const { sleep, sleeps } = recordSleep();
      const client = new HttpCalendarClient({
        fetch,
        getAccessToken: tokenFor("t"),
        sleep,
        random: fixedRandom(0),
      });
      await expect(
        client.listCalendarViewDelta({ account: "a@example.test" }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("401 does not go through the 5xx backoff/retry path either (no sleep, exactly 2 HTTP calls)", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 401, body: "no" }),
      response({ status: 401, body: "no" }),
    ]);
    const { sleep, sleeps } = recordSleep();
    const client = new HttpCalendarClient({
      fetch,
      getAccessToken: tokenFor("t"),
      sleep,
      random: fixedRandom(0),
    });
    await expect(
      client.listCalendarViewDelta({ account: "a@example.test" }),
    ).rejects.toBeInstanceOf(TokenExpiredError);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([]);
  });
});

describe("HttpCalendarClient with fetchWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("default sleep arrow waits via real setTimeout when not injected", async () => {
    const { fetch } = scriptFetch([
      response({ status: 502, body: "transient" }),
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpCalendarClient({
      fetch,
      getAccessToken: tokenFor("t"),
      random: () => 0,
    });

    const promise = client.listCalendarViewDelta({ account: "a@example.test" });
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(250);
    await expect(promise).resolves.toMatchObject({ events: [] });
  });

  it("aborts via fetchWithTimeout default when inner fetch hangs", async () => {
    const inner: FetchLike = (_url, init) =>
      new Promise<FetchLikeResponse>((_resolve, reject) => {
        const sig = init?.signal;
        sig?.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    const wrapped = createFetchWithTimeout({ fetch: inner, defaultTimeoutMs: 100 });
    const client = new HttpCalendarClient({ fetch: wrapped, getAccessToken: tokenFor("t") });

    const promise = client.listCalendarViewDelta({ account: "a@example.test" });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
