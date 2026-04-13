import { describe, expect, it } from "vitest";
import {
  DeltaTokenInvalidError,
  GraphRateLimitedError,
  TokenExpiredError,
} from "./teams.js";
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

function scriptFetch(
  steps: FetchLikeResponse[],
): { fetch: FetchLike; calls: ScriptedCall[] } {
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

describe("HttpTeamsClient", () => {
  it("hits baseUrl + relative path with bearer token and Prefer header", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsClient({ fetch });
    await client.getDelta("/me/chats/getAllMessages/delta", "tok-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://graph.microsoft.com/v1.0/me/chats/getAllMessages/delta",
    );
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-1");
    expect(calls[0]!.headers["Accept"]).toBe("application/json");
    expect(calls[0]!.headers["Prefer"]).toBe("odata.maxpagesize=50");
  });

  it("uses absolute nextLink url as-is", async () => {
    const nextLink =
      "https://graph.microsoft.com/v1.0/me/chats/getAllMessages/delta?$skiptoken=abc";
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsClient({ fetch });
    await client.getDelta(nextLink, "tok");
    expect(calls[0]!.url).toBe(nextLink);
  });

  it("parses value + @odata.nextLink + @odata.deltaLink", async () => {
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
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta?token=z",
    };
    const { fetch } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const client = new HttpTeamsClient({ fetch });
    const got = await client.getDelta("/me/chats/getAllMessages/delta", "t");
    expect(got).toEqual(payload);
  });

  it("throws TokenExpiredError on HTTP 401", async () => {
    const { fetch } = scriptFetch([response({ status: 401, body: "no" })]);
    const client = new HttpTeamsClient({ fetch });
    await expect(client.getDelta("/delta", "t")).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
  });

  it("throws DeltaTokenInvalidError on HTTP 410", async () => {
    const { fetch } = scriptFetch([response({ status: 410, body: "gone" })]);
    const client = new HttpTeamsClient({ fetch });
    await expect(client.getDelta("/delta", "t")).rejects.toBeInstanceOf(
      DeltaTokenInvalidError,
    );
  });

  it("throws GraphRateLimitedError carrying Retry-After seconds (header / missing / bad)", async () => {
    const cases: Array<{ header: Record<string, string>; expected: number }> = [
      { header: { "Retry-After": "42" }, expected: 42 },
      { header: {}, expected: 60 },
      { header: { "Retry-After": "abc" }, expected: 60 },
    ];
    for (const tc of cases) {
      const { fetch } = scriptFetch([
        response({ status: 429, body: "", headers: tc.header }),
      ]);
      const client = new HttpTeamsClient({ fetch });
      try {
        await client.getDelta("/delta", "t");
        expect.fail("expected throw");
      } catch (caught) {
        expect(caught).toBeInstanceOf(GraphRateLimitedError);
        expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(
          tc.expected,
        );
      }
    }
  });

  it("throws a descriptive error on non-2xx (500, 403) with body ≤200 chars", async () => {
    const longBody = "x".repeat(500);
    const { fetch } = scriptFetch([response({ status: 500, body: longBody })]);
    const client = new HttpTeamsClient({ fetch });
    try {
      await client.getDelta("/delta", "t");
      expect.fail("expected throw");
    } catch (caught) {
      const err = caught as Error;
      expect(err.message).toContain("500");
      const excerpt = err.message.split("500: ")[1] ?? "";
      expect(excerpt.length).toBeLessThanOrEqual(200);
    }
    const { fetch: f403 } = scriptFetch([
      response({ status: 403, body: "forbidden" }),
    ]);
    await expect(
      new HttpTeamsClient({ fetch: f403 }).getDelta("/delta", "t"),
    ).rejects.toThrowError(/403/);
  });

  it("does not leak the bearer token into error messages", async () => {
    const secret = "tok-TEAMS-SECRET-do-not-leak";
    const statuses = [401, 403, 410, 429, 500];
    for (const status of statuses) {
      const { fetch } = scriptFetch([
        response({ status, body: `boom ${secret}` }),
      ]);
      const client = new HttpTeamsClient({ fetch });
      try {
        await client.getDelta("/delta", secret);
        expect.fail("expected throw");
      } catch (caught) {
        expect((caught as Error).message).not.toContain(secret);
      }
    }
  });

  it("honours a custom baseUrl and preferMaxPageSize", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsClient({
      fetch,
      baseUrl: "https://custom.invalid/beta",
      preferMaxPageSize: 10,
    });
    await client.getDelta("/me/chats/getAllMessages/delta", "t");
    expect(calls[0]!.url).toBe(
      "https://custom.invalid/beta/me/chats/getAllMessages/delta",
    );
    expect(calls[0]!.headers["Prefer"]).toBe("odata.maxpagesize=10");
  });
});
