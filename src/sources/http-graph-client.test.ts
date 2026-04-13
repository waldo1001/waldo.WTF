import { describe, expect, it } from "vitest";
import {
  DeltaTokenInvalidError,
  GraphRateLimitedError,
  TokenExpiredError,
} from "./graph.js";
import {
  HttpGraphClient,
  type FetchLike,
  type FetchLikeResponse,
} from "./http-graph-client.js";

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
        return key ? hdrs[key] : null;
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
    calls.push({
      url,
      headers: { ...(init?.headers ?? {}) },
    });
    const step = steps[i++];
    if (!step) {
      throw new Error(`scriptFetch: no scripted response for call #${i}`);
    }
    return step;
  };
  return { fetch, calls };
}

describe("HttpGraphClient", () => {
  it("getDelta hits baseUrl + relative path with bearer token and Prefer header", async () => {
    const { fetch, calls } = scriptFetch([
      response({
        status: 200,
        body: JSON.stringify({ value: [] }),
      }),
    ]);
    const client = new HttpGraphClient({ fetch });

    await client.getDelta("/me/mailFolders/inbox/messages/delta", "tok-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta",
    );
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-1");
    expect(calls[0]!.headers["Accept"]).toBe("application/json");
    expect(calls[0]!.headers["Prefer"]).toBe("odata.maxpagesize=50");
  });

  it("getDelta uses absolute nextLink url as-is", async () => {
    const nextLink =
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc123";
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpGraphClient({ fetch });

    await client.getDelta(nextLink, "tok");

    expect(calls[0]!.url).toBe(nextLink);
  });

  it("getDelta returns parsed JSON with value/@odata.nextLink/@odata.deltaLink", async () => {
    const payload = {
      value: [
        {
          id: "AAMk-1",
          receivedDateTime: "2026-04-13T09:00:00Z",
          subject: "hello",
        },
      ],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/next?skip=1",
      "@odata.deltaLink":
        "https://graph.microsoft.com/v1.0/delta?token=zz",
    };
    const { fetch } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const client = new HttpGraphClient({ fetch });

    const result = await client.getDelta("/me/mailFolders/inbox/messages/delta", "t");

    expect(result).toEqual(payload);
  });

  it("getDelta throws TokenExpiredError on HTTP 401", async () => {
    const { fetch } = scriptFetch([
      response({ status: 401, body: "unauthorized" }),
    ]);
    const client = new HttpGraphClient({ fetch });

    await expect(client.getDelta("/delta", "t")).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
  });

  it("getDelta throws GraphRateLimitedError carrying Retry-After seconds", async () => {
    const cases: Array<{
      header: Record<string, string>;
      expected: number;
    }> = [
      { header: { "Retry-After": "42" }, expected: 42 },
      { header: {}, expected: 60 },
      { header: { "Retry-After": "abc" }, expected: 60 },
    ];

    for (const tc of cases) {
      const { fetch } = scriptFetch([
        response({ status: 429, body: "", headers: tc.header }),
      ]);
      const client = new HttpGraphClient({ fetch });
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

  it("getDelta throws DeltaTokenInvalidError on HTTP 410", async () => {
    const { fetch } = scriptFetch([
      response({ status: 410, body: "gone" }),
    ]);
    const client = new HttpGraphClient({ fetch });

    await expect(client.getDelta("/delta", "t")).rejects.toBeInstanceOf(
      DeltaTokenInvalidError,
    );
  });

  it("getDelta throws a descriptive Error on HTTP 500", async () => {
    const longBody = "x".repeat(500);
    const { fetch } = scriptFetch([
      response({ status: 500, body: longBody }),
    ]);
    const client = new HttpGraphClient({ fetch });

    try {
      await client.getDelta("/delta", "t");
      expect.fail("expected throw");
    } catch (caught) {
      const err = caught as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("500");
      // excerpt must be ≤200 chars from the body
      const excerpt = err.message.split("500: ")[1] ?? "";
      expect(excerpt.length).toBeLessThanOrEqual(200);
    }

    // 403 also hits the generic branch
    const { fetch: fetch403 } = scriptFetch([
      response({ status: 403, body: "forbidden" }),
    ]);
    const client403 = new HttpGraphClient({ fetch: fetch403 });
    await expect(client403.getDelta("/delta", "t")).rejects.toThrowError(
      /403/,
    );
  });

  it("thrown errors do not leak the bearer token", async () => {
    const secret = "tok-SECRET-do-not-leak";
    const statuses = [401, 403, 410, 429, 500];
    for (const status of statuses) {
      const { fetch } = scriptFetch([
        response({ status, body: `boom ${secret}` }),
      ]);
      const client = new HttpGraphClient({ fetch });
      try {
        await client.getDelta("/delta", secret);
        expect.fail("expected throw");
      } catch (caught) {
        expect((caught as Error).message).not.toContain(secret);
      }
    }
  });
});
