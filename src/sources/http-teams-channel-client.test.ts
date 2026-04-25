import { describe, expect, it } from "vitest";
import {
  GraphRateLimitedError,
  TokenExpiredError,
} from "./teams-channel.js";
import type { FetchLike, FetchLikeResponse } from "./http-graph-client.js";
import { HttpTeamsChannelClient } from "./http-teams-channel-client.js";

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

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("HttpTeamsChannelClient.listJoinedTeams", () => {
  it("walks @odata.nextLink across pages", async () => {
    const page1 = {
      value: [{ id: "team-1", displayName: "T1" }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/joinedTeams?$skip=1",
    };
    const page2 = {
      value: [{ id: "team-2", displayName: "T2" }],
    };
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify(page1) }),
      response({ status: 200, body: JSON.stringify(page2) }),
    ]);
    const client = new HttpTeamsChannelClient({ fetch });
    const teams = await collect(client.listJoinedTeams("tok"));
    expect(teams.map((t) => t.id)).toEqual(["team-1", "team-2"]);
    expect(calls[0]!.url).toBe(
      "https://graph.microsoft.com/v1.0/me/joinedTeams",
    );
    expect(calls[1]!.url).toBe(page1["@odata.nextLink"]);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
  });
});

describe("HttpTeamsChannelClient.listChannels", () => {
  it("walks pages for a given teamId", async () => {
    const page1 = {
      value: [{ id: "chan-1", displayName: "General" }],
      "@odata.nextLink":
        "https://graph.microsoft.com/v1.0/teams/team-1/channels?$skip=1",
    };
    const page2 = {
      value: [{ id: "chan-2", displayName: "Random" }],
    };
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify(page1) }),
      response({ status: 200, body: JSON.stringify(page2) }),
    ]);
    const client = new HttpTeamsChannelClient({ fetch });
    const got = await collect(client.listChannels("tok", "team-1"));
    expect(got.map((c) => c.id)).toEqual(["chan-1", "chan-2"]);
    expect(calls[0]!.url).toBe(
      "https://graph.microsoft.com/v1.0/teams/team-1/channels",
    );
    expect(calls[1]!.url).toBe(page1["@odata.nextLink"]);
  });

  it("percent-encodes teamId with a URL-significant character", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsChannelClient({ fetch });
    await collect(client.listChannels("tok", "19:abc=thread.tacv2"));
    expect(calls[0]!.url).toContain(
      "/teams/19%3Aabc%3Dthread.tacv2/channels",
    );
  });
});

describe("HttpTeamsChannelClient.getChannelMessagesDelta", () => {
  it("first call builds delta URL with $expand=replies", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsChannelClient({ fetch });
    await client.getChannelMessagesDelta("tok", "team-1", "chan-1", {});
    const url = calls[0]!.url;
    expect(url).toContain(
      "/teams/team-1/channels/chan-1/messages/delta",
    );
    expect(url).toContain("%24expand=replies");
    expect(url).not.toContain("%24filter");
  });

  it("first call with sinceIso adds lastModifiedDateTime filter", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsChannelClient({ fetch });
    await client.getChannelMessagesDelta("tok", "team-1", "chan-1", {
      sinceIso: "2026-04-01T00:00:00Z",
    });
    expect(calls[0]!.url).toContain(
      "%24filter=lastModifiedDateTime+gt+2026-04-01T00%3A00%3A00Z",
    );
  });

  it("subsequent call uses the provided deltaLink verbatim", async () => {
    const deltaLink =
      "https://graph.microsoft.com/v1.0/teams/x/channels/y/messages/delta?$deltatoken=opaque";
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsChannelClient({ fetch });
    await client.getChannelMessagesDelta("tok", "team-1", "chan-1", {
      deltaLink,
    });
    expect(calls[0]!.url).toBe(deltaLink);
  });

  it("pagination uses nextLink verbatim", async () => {
    const nextLink =
      "https://graph.microsoft.com/v1.0/teams/x/channels/y/messages/delta?$skiptoken=abc";
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsChannelClient({ fetch });
    await client.getChannelMessagesDelta("tok", "team-1", "chan-1", {
      nextLink,
    });
    expect(calls[0]!.url).toBe(nextLink);
  });

  it("percent-encodes teamId and channelId in the delta URL", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsChannelClient({ fetch });
    await client.getChannelMessagesDelta(
      "tok",
      "19:team/v2",
      "19:chan/v2",
      {},
    );
    expect(calls[0]!.url).toContain(
      "/teams/19%3Ateam%2Fv2/channels/19%3Achan%2Fv2/messages/delta",
    );
  });

  it("maps HTTP 401 to TokenExpiredError", async () => {
    const { fetch } = scriptFetch([response({ status: 401, body: "no" })]);
    const client = new HttpTeamsChannelClient({ fetch });
    await expect(
      client.getChannelMessagesDelta("tok", "t", "c", {}),
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("maps HTTP 429 to GraphRateLimitedError and reads Retry-After", async () => {
    const { fetch } = scriptFetch([
      response({ status: 429, body: "", headers: { "Retry-After": "13" } }),
    ]);
    const client = new HttpTeamsChannelClient({ fetch });
    try {
      await client.getChannelMessagesDelta("tok", "t", "c", {});
      expect.fail("expected throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(GraphRateLimitedError);
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(13);
    }
  });

  it("maps HTTP 429 with no Retry-After to default 60s", async () => {
    const { fetch } = scriptFetch([response({ status: 429, body: "" })]);
    const client = new HttpTeamsChannelClient({ fetch });
    try {
      await client.getChannelMessagesDelta("tok", "t", "c", {});
      expect.fail("expected throw");
    } catch (caught) {
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(60);
    }
  });

  it("redacts the bearer token from non-2xx error bodies", async () => {
    const secret = "TOK-CHANNEL-SECRET";
    const { fetch } = scriptFetch([
      response({ status: 500, body: `boom ${secret}` }),
    ]);
    const client = new HttpTeamsChannelClient({ fetch });
    try {
      await client.getChannelMessagesDelta(secret, "t", "c", {});
      expect.fail("expected throw");
    } catch (caught) {
      const msg = (caught as Error).message;
      expect(msg).toContain("HTTP 500");
      expect(msg).toContain("[redacted]");
      expect(msg).not.toContain(secret);
    }
  });

  it("sends Prefer header with odata.maxpagesize on every request", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTeamsChannelClient({ fetch, preferMaxPageSize: 25 });
    await client.getChannelMessagesDelta("tok", "t", "c", {});
    await collect(client.listJoinedTeams("tok"));
    expect(calls[0]!.headers["Prefer"]).toBe("odata.maxpagesize=25");
    expect(calls[1]!.headers["Prefer"]).toBe("odata.maxpagesize=25");
  });

  it("exposes @odata.deltaLink and @odata.nextLink to caller", async () => {
    const payload = {
      value: [{ id: "m1", createdDateTime: "2026-04-21T08:00:00Z" }],
      "@odata.nextLink": "https://nl",
      "@odata.deltaLink": "https://dl",
    };
    const { fetch } = scriptFetch([
      response({ status: 200, body: JSON.stringify(payload) }),
    ]);
    const client = new HttpTeamsChannelClient({ fetch });
    const got = await client.getChannelMessagesDelta("tok", "t", "c", {});
    expect(got["@odata.nextLink"]).toBe("https://nl");
    expect(got["@odata.deltaLink"]).toBe("https://dl");
  });
});
