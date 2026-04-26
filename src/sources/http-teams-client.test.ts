import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphRateLimitedError, TokenExpiredError } from "./teams.js";
import type { FetchLike, FetchLikeResponse } from "./http-graph-client.js";
import { createFetchWithTimeout } from "./fetch-with-timeout.js";
import { HttpTeamsClient } from "./http-teams-client.js";

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

describe("HttpTeamsClient.listChats", () => {
  it("hits /me/chats with bearer + prefer, parses value + nextLink", async () => {
    const payload = {
      value: [{ id: "chat-1", chatType: "oneOnOne", topic: null }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/chats?$skip=50",
    };
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const client = new HttpTeamsClient({ fetch });
    const got = await client.listChats("tok-1");
    expect(got).toEqual(payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("https://graph.microsoft.com/v1.0/me/chats");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-1");
    expect(calls[0]!.headers["Prefer"]).toBe("odata.maxpagesize=50");
  });

  it("uses absolute nextLink url as-is on subsequent pages", async () => {
    const nextLink = "https://graph.microsoft.com/v1.0/me/chats?$skiptoken=abc";
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsClient({ fetch });
    await client.listChats("t", nextLink);
    expect(calls[0]!.url).toBe(nextLink);
  });

  it("maps 401 → TokenExpiredError", async () => {
    const { fetch } = scriptFetch([response({ status: 401, body: "no" })]);
    const client = new HttpTeamsClient({ fetch });
    await expect(client.listChats("t")).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
  });

  it("maps 429 → GraphRateLimitedError with Retry-After", async () => {
    const { fetch } = scriptFetch([
      response({ status: 429, body: "", headers: { "Retry-After": "7" } }),
    ]);
    const client = new HttpTeamsClient({ fetch });
    try {
      await client.listChats("t");
      expect.fail("expected throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(GraphRateLimitedError);
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(7);
    }
  });
});

describe("HttpTeamsClient.getChatMessages", () => {
  it("builds /me/chats/{id}/messages with $orderby and $filter from sinceIso", async () => {
    const payload = {
      value: [
        {
          id: "msg-1",
          createdDateTime: "2026-04-13T09:00:00Z",
          chatId: "chat-1",
          body: { contentType: "text", content: "hi" },
        },
      ],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/next?skip=1",
    };
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const client = new HttpTeamsClient({ fetch });
    const got = await client.getChatMessages("t", "chat-1", {
      sinceIso: "2026-04-13T00:00:00Z",
    });
    expect(got).toEqual(payload);
    const url = calls[0]!.url;
    expect(url).toContain("/me/chats/chat-1/messages");
    expect(url).toContain("%24orderby=lastModifiedDateTime+desc");
    expect(url).toContain(
      "%24filter=lastModifiedDateTime+gt+2026-04-13T00%3A00%3A00Z",
    );
  });

  it("omits $filter when sinceIso is not provided", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsClient({ fetch });
    await client.getChatMessages("t", "chat-2", {});
    expect(calls[0]!.url).not.toContain("%24filter");
    expect(calls[0]!.url).toContain("/me/chats/chat-2/messages");
  });

  it("url-encodes chatId with special characters", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsClient({ fetch });
    await client.getChatMessages("t", "19:abc=thread.v2", {});
    expect(calls[0]!.url).toContain(
      "/me/chats/19%3Aabc%3Dthread.v2/messages",
    );
  });

  it("uses absolute nextLink as-is", async () => {
    const nextLink =
      "https://graph.microsoft.com/v1.0/me/chats/chat-1/messages?$skip=50";
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsClient({ fetch });
    await client.getChatMessages("t", "chat-1", { nextLink });
    expect(calls[0]!.url).toBe(nextLink);
  });

  it("maps 401 → TokenExpiredError", async () => {
    const { fetch } = scriptFetch([response({ status: 401, body: "no" })]);
    const client = new HttpTeamsClient({ fetch });
    await expect(
      client.getChatMessages("t", "chat-1", {}),
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("maps 429 → GraphRateLimitedError, defaults 60s when header missing/bad", async () => {
    for (const hdr of [{}, { "Retry-After": "abc" }]) {
      const { fetch } = scriptFetch([
        response({ status: 429, body: "", headers: hdr }),
      ]);
      const client = new HttpTeamsClient({ fetch });
      try {
        await client.getChatMessages("t", "chat-1", {});
        expect.fail("expected throw");
      } catch (caught) {
        expect(caught).toBeInstanceOf(GraphRateLimitedError);
        expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(60);
      }
    }
  });

  it("non-2xx error body truncated to ≤200 chars", async () => {
    const longBody = "x".repeat(500);
    const { fetch } = scriptFetch([response({ status: 500, body: longBody })]);
    const client = new HttpTeamsClient({ fetch });
    try {
      await client.getChatMessages("t", "chat-1", {});
      expect.fail("expected throw");
    } catch (caught) {
      const err = caught as Error;
      expect(err.message).toContain("500");
      const excerpt = err.message.split("500: ")[1] ?? "";
      expect(excerpt.length).toBeLessThanOrEqual(200);
    }
  });

  it("does not leak the bearer token into error messages", async () => {
    const secret = "tok-TEAMS-SECRET-do-not-leak";
    for (const status of [401, 403, 429, 500]) {
      const { fetch } = scriptFetch([
        response({ status, body: `boom ${secret}` }),
      ]);
      const client = new HttpTeamsClient({ fetch });
      try {
        await client.getChatMessages(secret, "chat-1", {});
        expect.fail("expected throw");
      } catch (caught) {
        expect((caught as Error).message).not.toContain(secret);
      }
    }
  });

  it("honours a custom baseUrl and preferMaxPageSize", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsClient({
      fetch,
      baseUrl: "https://custom.invalid/beta",
      preferMaxPageSize: 10,
    });
    await client.listChats("t");
    await client.getChatMessages("t", "chat-1", {});
    expect(calls[0]!.url.startsWith("https://custom.invalid/beta/me/chats")).toBe(
      true,
    );
    expect(calls[1]!.url).toContain(
      "https://custom.invalid/beta/me/chats/chat-1/messages",
    );
    expect(calls[0]!.headers["Prefer"]).toBe("odata.maxpagesize=10");
  });
});

describe("HttpTeamsClient transient-5xx retry", () => {
  function recordSleep(): {
    sleep: (ms: number) => Promise<void>;
    sleeps: number[];
  } {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    return { sleep, sleeps };
  }

  function fixedRandom(value: number): () => number {
    return () => value;
  }

  it("retries on 502 and returns success on second attempt", async () => {
    const payload = { value: [{ id: "chat-1" }] };
    const { fetch, calls } = scriptFetch([
      response({ status: 502, body: "bad gateway" }),
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const { sleep, sleeps } = recordSleep();
    const client = new HttpTeamsClient({
      fetch,
      sleep,
      random: fixedRandom(0.5),
    });
    const got = await client.listChats("t");
    expect(got).toEqual(payload);
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(250);
    expect(sleeps[0]).toBeLessThanOrEqual(500);
  });

  it("retries on 503 then 504 then succeeds on third attempt", async () => {
    const payload = { value: [] };
    const { fetch, calls } = scriptFetch([
      response({ status: 503, body: "unavailable" }),
      response({ status: 504, body: "timeout" }),
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const { sleep, sleeps } = recordSleep();
    const client = new HttpTeamsClient({
      fetch,
      sleep,
      random: fixedRandom(0),
    });
    const got = await client.listChats("t");
    expect(got).toEqual(payload);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([250, 750]);
  });

  it("gives up after maxRetries=2 and surfaces the last 5xx body", async () => {
    const secret = "tok-TEAMS-SECRET-xyz";
    const { fetch, calls } = scriptFetch([
      response({ status: 502, body: `boom ${secret}` }),
      response({ status: 502, body: `boom ${secret}` }),
      response({ status: 502, body: `final boom ${secret}` }),
    ]);
    const { sleep, sleeps } = recordSleep();
    const client = new HttpTeamsClient({
      fetch,
      sleep,
      random: fixedRandom(0),
    });
    try {
      await client.listChats(secret);
      expect.fail("expected throw");
    } catch (caught) {
      const msg = (caught as Error).message;
      expect(msg).toContain("HTTP 502");
      expect(msg).toContain("final boom");
      expect(msg).toContain("[redacted]");
      expect(msg).not.toContain(secret);
    }
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([250, 750]);
  });

  it("does not retry on 401", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 401, body: "no" }),
    ]);
    const { sleep, sleeps } = recordSleep();
    const client = new HttpTeamsClient({
      fetch,
      sleep,
      random: fixedRandom(0),
    });
    await expect(client.listChats("t")).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("does not retry on 429", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 429, body: "", headers: { "Retry-After": "30" } }),
    ]);
    const { sleep, sleeps } = recordSleep();
    const client = new HttpTeamsClient({
      fetch,
      sleep,
      random: fixedRandom(0),
    });
    try {
      await client.listChats("t");
      expect.fail("expected throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(GraphRateLimitedError);
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(30);
    }
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("does not retry on 404 or other 4xx", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 404, body: "not found" }),
    ]);
    const { sleep, sleeps } = recordSleep();
    const client = new HttpTeamsClient({
      fetch,
      sleep,
      random: fixedRandom(0),
    });
    await expect(client.listChats("t")).rejects.toThrow(/HTTP 404/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("does not retry on 500", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 500, body: "server error" }),
    ]);
    const { sleep, sleeps } = recordSleep();
    const client = new HttpTeamsClient({
      fetch,
      sleep,
      random: fixedRandom(0),
    });
    await expect(client.listChats("t")).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("does not retry on 2xx", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const { sleep, sleeps } = recordSleep();
    const client = new HttpTeamsClient({
      fetch,
      sleep,
      random: fixedRandom(0),
    });
    await client.listChats("t");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("jitter uses injected random source", async () => {
    const cases: { random: number; expectedFirstSleep: number }[] = [
      { random: 0, expectedFirstSleep: 250 },
      { random: 0.999_999, expectedFirstSleep: 500 },
    ];
    for (const c of cases) {
      const { fetch } = scriptFetch([
        response({ status: 502, body: "x" }),
        response({ status: 200, body: JSON.stringify({ value: [] }) }),
      ]);
      const { sleep, sleeps } = recordSleep();
      const client = new HttpTeamsClient({
        fetch,
        sleep,
        random: fixedRandom(c.random),
      });
      await client.listChats("t");
      expect(sleeps[0]).toBeCloseTo(c.expectedFirstSleep, 0);
    }
  });

  it("redacts bearer from final error body even after retries", async () => {
    const secret = "tok-RETRY-PATH-SECRET";
    const { fetch } = scriptFetch([
      response({ status: 502, body: `boom1 ${secret}` }),
      response({ status: 502, body: `boom2 ${secret}` }),
      response({ status: 502, body: `boom3 ${secret}` }),
    ]);
    const { sleep } = recordSleep();
    const client = new HttpTeamsClient({
      fetch,
      sleep,
      random: fixedRandom(0),
    });
    try {
      await client.listChats(secret);
      expect.fail("expected throw");
    } catch (caught) {
      const msg = (caught as Error).message;
      expect(msg).not.toContain(secret);
      expect(msg).toContain("[redacted]");
    }
  });
});

describe("HttpTeamsClient with fetchWithTimeout", () => {
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
    const client = new HttpTeamsClient({ fetch, random: () => 0 });

    const promise = client.listChats("tok-1");
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(250);
    await expect(promise).resolves.toEqual({ value: [] });
  });

  it("aborts via fetchWithTimeout default when inner fetch hangs", async () => {
    const inner: FetchLike = (_url, init) =>
      new Promise<FetchLikeResponse>((_resolve, reject) => {
        const sig = init?.signal;
        sig?.addEventListener(
          "abort",
          () => reject(sig.reason),
          { once: true },
        );
      });
    const wrapped = createFetchWithTimeout({
      fetch: inner,
      defaultTimeoutMs: 100,
    });
    const client = new HttpTeamsClient({ fetch: wrapped });

    const promise = client.listChats("tok-secret");
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
