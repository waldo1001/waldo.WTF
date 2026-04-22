import { describe, expect, it } from "vitest";
import { GraphRateLimitedError, TokenExpiredError } from "./viva.js";
import type { FetchLike, FetchLikeResponse } from "./http-graph-client.js";
import { HttpVivaClient } from "./http-viva-client.js";

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

describe("HttpVivaClient.listCommunities", () => {
  it("hits /beta/employeeExperience/communities with bearer + prefer, parses payload + nextLink", async () => {
    const payload = {
      value: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          displayName: "Engineering",
          networkId: "00000000-0000-0000-0000-0000000000aa",
        },
      ],
      "@odata.nextLink":
        "https://graph.microsoft.com/beta/employeeExperience/communities?$skip=50",
    };
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const client = new HttpVivaClient({ fetch });
    const got = await client.listCommunities("tok-1");
    expect(got).toEqual(payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(
      "https://graph.microsoft.com/beta/employeeExperience/communities",
    );
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-1");
    expect(calls[0]!.headers["Prefer"]).toBe("odata.maxpagesize=50");
  });

  it("uses absolute nextLink as-is on subsequent pages", async () => {
    const nextLink =
      "https://graph.microsoft.com/beta/employeeExperience/communities?$skiptoken=abc";
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpVivaClient({ fetch });
    await client.listCommunities("t", nextLink);
    expect(calls[0]!.url).toBe(nextLink);
  });

  it("maps 401 → TokenExpiredError", async () => {
    const { fetch } = scriptFetch([response({ status: 401, body: "no" })]);
    const client = new HttpVivaClient({ fetch });
    await expect(client.listCommunities("t")).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
  });

  it("maps 429 → GraphRateLimitedError with Retry-After", async () => {
    const { fetch } = scriptFetch([
      response({ status: 429, body: "", headers: { "Retry-After": "9" } }),
    ]);
    const client = new HttpVivaClient({ fetch });
    try {
      await client.listCommunities("t");
      expect.fail("expected throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(GraphRateLimitedError);
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(9);
    }
  });
});

describe("HttpVivaClient.listThreads", () => {
  it("builds /communities/{id}/threads with $orderby and $filter from sinceIso", async () => {
    const payload = {
      value: [
        {
          id: "thr-1",
          topic: "release plans",
          lastPostedDateTime: "2026-04-21T08:00:00Z",
        },
      ],
      "@odata.nextLink":
        "https://graph.microsoft.com/beta/employeeExperience/next?skip=1",
    };
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const client = new HttpVivaClient({ fetch });
    const got = await client.listThreads("t", "com-1", {
      sinceIso: "2026-04-13T00:00:00Z",
    });
    expect(got).toEqual(payload);
    const url = calls[0]!.url;
    expect(url).toContain("/employeeExperience/communities/com-1/threads");
    expect(url).toContain("%24orderby=lastPostedDateTime+desc");
    expect(url).toContain(
      "%24filter=lastPostedDateTime+gt+2026-04-13T00%3A00%3A00Z",
    );
  });

  it("omits $filter when sinceIso is not provided", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpVivaClient({ fetch });
    await client.listThreads("t", "com-2", {});
    expect(calls[0]!.url).not.toContain("%24filter");
    expect(calls[0]!.url).toContain(
      "/employeeExperience/communities/com-2/threads",
    );
  });

  it("url-encodes communityId with special characters", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpVivaClient({ fetch });
    await client.listThreads("t", "com:abc=foo/v2", {});
    expect(calls[0]!.url).toContain(
      "/employeeExperience/communities/com%3Aabc%3Dfoo%2Fv2/threads",
    );
  });

  it("uses absolute nextLink as-is", async () => {
    const nextLink =
      "https://graph.microsoft.com/beta/employeeExperience/communities/com-1/threads?$skip=50";
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpVivaClient({ fetch });
    await client.listThreads("t", "com-1", { nextLink });
    expect(calls[0]!.url).toBe(nextLink);
  });

  it("maps 401 → TokenExpiredError", async () => {
    const { fetch } = scriptFetch([response({ status: 401, body: "no" })]);
    const client = new HttpVivaClient({ fetch });
    await expect(
      client.listThreads("t", "com-1", {}),
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("maps 429 → GraphRateLimitedError, defaults 60s when header missing/bad", async () => {
    for (const hdr of [{}, { "Retry-After": "abc" }]) {
      const { fetch } = scriptFetch([
        response({ status: 429, body: "", headers: hdr }),
      ]);
      const client = new HttpVivaClient({ fetch });
      try {
        await client.listThreads("t", "com-1", {});
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
    const client = new HttpVivaClient({ fetch });
    try {
      await client.listThreads("t", "com-1", {});
      expect.fail("expected throw");
    } catch (caught) {
      const err = caught as Error;
      expect(err.message).toContain("500");
      const excerpt = err.message.split("500: ")[1] ?? "";
      expect(excerpt.length).toBeLessThanOrEqual(200);
    }
  });

  it("does not leak the bearer token into error messages", async () => {
    const secret = "tok-VIVA-SECRET-do-not-leak";
    for (const status of [401, 403, 429, 500]) {
      const { fetch } = scriptFetch([
        response({ status, body: `boom ${secret}` }),
      ]);
      const client = new HttpVivaClient({ fetch });
      try {
        await client.listThreads(secret, "com-1", {});
        expect.fail("expected throw");
      } catch (caught) {
        expect((caught as Error).message).not.toContain(secret);
      }
    }
  });
});

describe("HttpVivaClient.listPosts", () => {
  it("builds /communities/{c}/threads/{t}/posts and parses payload", async () => {
    const payload = {
      value: [
        {
          id: "post-1",
          conversationId: "thr-1",
          createdDateTime: "2026-04-21T08:00:00Z",
          body: { contentType: "text", content: "hello" },
        },
      ],
    };
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const client = new HttpVivaClient({ fetch });
    const got = await client.listPosts("t", "com-1", "thr-1", {});
    expect(got).toEqual(payload);
    expect(calls[0]!.url).toContain(
      "/employeeExperience/communities/com-1/threads/thr-1/posts",
    );
  });

  it("url-encodes both communityId and threadId", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpVivaClient({ fetch });
    await client.listPosts("t", "c:1=x", "th/2", {});
    expect(calls[0]!.url).toContain(
      "/employeeExperience/communities/c%3A1%3Dx/threads/th%2F2/posts",
    );
  });

  it("uses absolute nextLink as-is", async () => {
    const nextLink =
      "https://graph.microsoft.com/beta/employeeExperience/communities/com-1/threads/thr-1/posts?$skip=50";
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpVivaClient({ fetch });
    await client.listPosts("t", "com-1", "thr-1", { nextLink });
    expect(calls[0]!.url).toBe(nextLink);
  });

  it("maps 401/429 errors", async () => {
    const { fetch: f1 } = scriptFetch([response({ status: 401 })]);
    await expect(
      new HttpVivaClient({ fetch: f1 }).listPosts("t", "c", "th", {}),
    ).rejects.toBeInstanceOf(TokenExpiredError);
    const { fetch: f2 } = scriptFetch([
      response({ status: 429, headers: { "Retry-After": "5" } }),
    ]);
    try {
      await new HttpVivaClient({ fetch: f2 }).listPosts("t", "c", "th", {});
      expect.fail("expected throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(GraphRateLimitedError);
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(5);
    }
  });
});

describe("HttpVivaClient — config", () => {
  it("honours custom baseUrl + preferMaxPageSize across endpoints", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpVivaClient({
      fetch,
      baseUrl: "https://custom.invalid/beta",
      preferMaxPageSize: 10,
    });
    await client.listCommunities("t");
    await client.listThreads("t", "com-1", {});
    await client.listPosts("t", "com-1", "thr-1", {});
    expect(
      calls[0]!.url.startsWith(
        "https://custom.invalid/beta/employeeExperience/communities",
      ),
    ).toBe(true);
    expect(calls[1]!.url).toContain(
      "https://custom.invalid/beta/employeeExperience/communities/com-1/threads",
    );
    expect(calls[2]!.url).toContain(
      "https://custom.invalid/beta/employeeExperience/communities/com-1/threads/thr-1/posts",
    );
    expect(calls[0]!.headers["Prefer"]).toBe("odata.maxpagesize=10");
  });
});
