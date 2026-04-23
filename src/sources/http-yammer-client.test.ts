import { describe, expect, it } from "vitest";
import { GraphRateLimitedError, TokenExpiredError } from "./viva.js";
import type { FetchLike, FetchLikeResponse } from "./http-graph-client.js";
import { HttpYammerClient } from "./http-yammer-client.js";

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

interface ScriptedCall {
  url: string;
  headers: Record<string, string>;
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

describe("HttpYammerClient.listNetworks", () => {
  it("hits /api/v1/networks/current.json with Bearer token and parses VivaNetwork array", async () => {
    const payload = [
      { id: 1234567, name: "Acme Corp", permalink: "acme-corp" },
      { id: 7654321, name: "External Partner", permalink: "external-partner" },
    ];
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const client = new HttpYammerClient({ fetch });
    const got = await client.listNetworks("tok-1");
    expect(got).toEqual([
      { id: "1234567", name: "Acme Corp", permalink: "acme-corp" },
      { id: "7654321", name: "External Partner", permalink: "external-partner" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://www.yammer.com/api/v1/networks/current.json",
    );
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-1");
  });

  it("maps 401 → TokenExpiredError", async () => {
    const { fetch } = scriptFetch([response({ status: 401 })]);
    await expect(
      new HttpYammerClient({ fetch }).listNetworks("t"),
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("maps 429 → GraphRateLimitedError defaulting to 6s (Yammer rate-limit)", async () => {
    const { fetch } = scriptFetch([response({ status: 429 })]);
    try {
      await new HttpYammerClient({ fetch }).listNetworks("t");
      expect.fail("expected throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(GraphRateLimitedError);
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(6);
    }
  });

  it("maps 429 with Retry-After header → GraphRateLimitedError with that value", async () => {
    const { fetch } = scriptFetch([
      response({ status: 429, headers: { "Retry-After": "15" } }),
    ]);
    try {
      await new HttpYammerClient({ fetch }).listNetworks("t");
      expect.fail("expected throw");
    } catch (caught) {
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(15);
    }
  });

  it("does not leak the bearer token in error messages", async () => {
    const secret = "tok-YAMMER-SECRET-do-not-leak";
    for (const status of [401, 429, 500]) {
      const { fetch } = scriptFetch([
        response({ status, body: `boom ${secret}` }),
      ]);
      try {
        await new HttpYammerClient({ fetch }).listNetworks(secret);
        expect.fail("expected throw");
      } catch (caught) {
        expect((caught as Error).message).not.toContain(secret);
      }
    }
  });
});

describe("HttpYammerClient.listCommunities", () => {
  it("hits /groups.json?mine=1 with bearer, maps to VivaCommunity[], paginates via page=2 until empty", async () => {
    const page1 = [
      { id: 111, full_name: "Engineering", network_id: 999 },
      { id: 222, full_name: "Sales", network_id: 999 },
    ];
    const page2 = [{ id: 333, full_name: "Marketing", network_id: 999 }];
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify(page1) }),
      response({ status: 200, body: JSON.stringify(page2) }),
      response({ status: 200, body: JSON.stringify([]) }),
    ]);
    const client = new HttpYammerClient({ fetch });
    const got = await client.listCommunities("tok-2");
    expect(got).toEqual([
      { id: "111", displayName: "Engineering", networkId: "999" },
      { id: "222", displayName: "Sales", networkId: "999" },
      { id: "333", displayName: "Marketing", networkId: "999" },
    ]);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toContain("/groups.json?mine=1&page=1");
    expect(calls[1]!.url).toContain("/groups.json?mine=1&page=2");
    expect(calls[2]!.url).toContain("/groups.json?mine=1&page=3");
    expect(calls[0]!.url).not.toContain("network_id");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-2");
  });

  it("stops after first empty page without making extra requests", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify([]) }),
    ]);
    const got = await new HttpYammerClient({ fetch }).listCommunities("t");
    expect(got).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("uses mine=1 and omits network_id to return joined groups across all networks", async () => {
    // Regression test: ?network_id= was removed because it only filters within the
    // home network context. External network communities (e.g. Microsoft Viva Engage)
    // are invisible when network_id is passed. ?mine=1 without network_id returns
    // all groups the authenticated user has joined, regardless of network.
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify([{ id: 42, full_name: "Insiders", network_id: 5 }]) }),
      response({ status: 200, body: JSON.stringify([]) }),
    ]);
    await new HttpYammerClient({ fetch }).listCommunities("tok-mine");
    expect(calls[0]!.url).toContain("mine=1");
    expect(calls[0]!.url).not.toContain("network_id");
    expect(calls[0]!.url).toContain("page=1");
  });

  it("maps 401/429 to typed errors", async () => {
    const { fetch: f1 } = scriptFetch([response({ status: 401 })]);
    await expect(
      new HttpYammerClient({ fetch: f1 }).listCommunities("t"),
    ).rejects.toBeInstanceOf(TokenExpiredError);

    const { fetch: f2 } = scriptFetch([response({ status: 429 })]);
    await expect(
      new HttpYammerClient({ fetch: f2 }).listCommunities("t"),
    ).rejects.toBeInstanceOf(GraphRateLimitedError);
  });
});

describe("HttpYammerClient.listThreads", () => {
  const makeThreadResponse = (msgs: Array<{ id: number; thread_id: number; sender_id: number; created_at: string }>) => ({
    messages: msgs.map((m) => ({
      ...m,
      body: { plain: "hello", rich: "<b>hello</b>" },
    })),
    references: [
      { type: "user", id: 55, full_name: "Alice Tester", email: "alice@example.invalid" },
    ],
    threaded_extended: {},
  });

  it("hits /messages/in_group/{id}.json?threaded=extended with bearer, maps to VivaThread[] + olderThanCursor", async () => {
    const payload = makeThreadResponse([
      { id: 1001, thread_id: 1001, sender_id: 55, created_at: "2026-04-20T10:00:00+00:00" },
      { id: 1000, thread_id: 1001, sender_id: 55, created_at: "2026-04-19T10:00:00+00:00" },
    ]);
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const client = new HttpYammerClient({ fetch });
    const got = await client.listThreads("tok-3", "111", {});
    expect(got.value).toHaveLength(2);
    expect(got.value[0]).toMatchObject({
      id: "1001",
      lastPostedDateTime: "2026-04-20T10:00:00+00:00",
    });
    expect(got.olderThanCursor).toBe("1000");
    expect(calls[0]!.url).toBe(
      "https://www.yammer.com/api/v1/messages/in_group/111.json?threaded=extended",
    );
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-3");
  });

  it("appends &older_than={id} when olderThan is provided", async () => {
    const payload = makeThreadResponse([
      { id: 900, thread_id: 900, sender_id: 55, created_at: "2026-04-18T10:00:00+00:00" },
    ]);
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    await new HttpYammerClient({ fetch }).listThreads("t", "111", {
      olderThan: "1000",
    });
    expect(calls[0]!.url).toContain("&older_than=1000");
  });

  it("returns olderThanCursor=undefined when messages array is empty (end of stream)", async () => {
    const payload = { messages: [], references: [], threaded_extended: {} };
    const { fetch } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const got = await new HttpYammerClient({ fetch }).listThreads("t", "111", {});
    expect(got.value).toHaveLength(0);
    expect(got.olderThanCursor).toBeUndefined();
  });

  it("maps 401 → TokenExpiredError", async () => {
    const { fetch } = scriptFetch([response({ status: 401 })]);
    await expect(
      new HttpYammerClient({ fetch }).listThreads("t", "111", {}),
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("maps 429 → GraphRateLimitedError with 6s default", async () => {
    const { fetch } = scriptFetch([response({ status: 429 })]);
    try {
      await new HttpYammerClient({ fetch }).listThreads("t", "111", {});
      expect.fail("expected throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(GraphRateLimitedError);
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(6);
    }
  });
});

describe("HttpYammerClient.listPosts", () => {
  const makePostResponse = (msgs: Array<{ id: number; thread_id: number; sender_id: number; created_at: string }>) => ({
    messages: msgs.map((m) => ({
      ...m,
      body: { plain: "reply text", rich: "<p>reply text</p>" },
    })),
    references: [
      { type: "user", id: 55, full_name: "Alice Tester", email: "alice@example.invalid" },
    ],
  });

  it("hits /messages/in_thread/{id}.json with bearer, maps to VivaPost[] with correct conversationId", async () => {
    const payload = makePostResponse([
      { id: 2001, thread_id: 2000, sender_id: 55, created_at: "2026-04-21T08:00:00+00:00" },
      { id: 2002, thread_id: 2000, sender_id: 55, created_at: "2026-04-21T09:00:00+00:00" },
    ]);
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const client = new HttpYammerClient({ fetch });
    const got = await client.listPosts("tok-4", "2000", {});
    expect(got.value).toHaveLength(2);
    expect(got.value[0]).toMatchObject({
      id: "2001",
      conversationId: "2000",
      createdDateTime: "2026-04-21T08:00:00+00:00",
      body: { contentType: "text", content: "reply text" },
      from: { user: { displayName: "Alice Tester" } },
    });
    expect(got.olderThanCursor).toBe("2001");
    expect(calls[0]!.url).toBe(
      "https://www.yammer.com/api/v1/messages/in_thread/2000.json",
    );
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-4");
  });

  it("appends ?older_than={id} when olderThan provided", async () => {
    const payload = makePostResponse([
      { id: 1900, thread_id: 2000, sender_id: 55, created_at: "2026-04-20T08:00:00+00:00" },
    ]);
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    await new HttpYammerClient({ fetch }).listPosts("t", "2000", {
      olderThan: "2001",
    });
    expect(calls[0]!.url).toContain("?older_than=2001");
  });

  it("returns olderThanCursor=undefined when messages is empty", async () => {
    const payload = { messages: [], references: [] };
    const { fetch } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const got = await new HttpYammerClient({ fetch }).listPosts("t", "2000", {});
    expect(got.value).toHaveLength(0);
    expect(got.olderThanCursor).toBeUndefined();
  });

  it("maps 401 → TokenExpiredError", async () => {
    const { fetch } = scriptFetch([response({ status: 401 })]);
    await expect(
      new HttpYammerClient({ fetch }).listPosts("t", "2000", {}),
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("numeric message id >2^53 round-trips losslessly as string", async () => {
    const bigId = "9007199254740993"; // 2^53 + 1 — not representable as IEEE754 double
    // Build the JSON body as a literal string so the large integer is not rounded by JS.
    // JSON.stringify({id: JSON.parse(bigId)}) would silently truncate to 9007199254740992.
    const body = `{"messages":[{"id":${bigId},"thread_id":${bigId},"sender_id":55,"created_at":"2026-04-21T08:00:00+00:00","body":{"plain":"big id test"}}],"references":[]}`;
    const { fetch } = scriptFetch([response({ status: 200, body })]);
    const got = await new HttpYammerClient({ fetch }).listPosts("t", bigId, {});
    expect(got.value[0]?.id).toBe(bigId);
    expect(got.value[0]?.conversationId).toBe(bigId);
  });
});
