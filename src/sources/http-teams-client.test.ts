import { describe, expect, it } from "vitest";
import { GraphRateLimitedError, TokenExpiredError } from "./teams.js";
import type { FetchLike, FetchLikeResponse } from "./http-graph-client.js";
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
