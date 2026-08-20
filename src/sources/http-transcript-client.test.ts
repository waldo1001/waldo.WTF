import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphRateLimitedError, TokenExpiredError } from "./graph.js";
import type { FetchLike, FetchLikeResponse } from "./http-graph-client.js";
import {
  TranscriptApiDisabledError,
  TranscriptNotAvailableError,
  TranscriptQuotaExhaustedError,
  TranscriptSpeakerAttributionDisabledError,
} from "./transcript.js";
import { HttpTranscriptClient, parseVtt } from "./http-transcript-client.js";

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

describe("HttpTranscriptClient.resolveOnlineMeetingId", () => {
  // Production joinUrl shape (tenant/oid digits zeroed).
  const JOIN_URL =
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0?context=%7b%22Tid%22%3a%22ff451c7f-0000%22%7d";

  it("resolveOnlineMeetingId returns the onlineMeeting id for a joinWebUrl", async () => {
    const { fetch, calls } = scriptFetch([
      response({
        status: 200,
        body: JSON.stringify({ value: [{ id: "MSp0ZXN0-meeting-id" }] }),
      }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("tok-1") });
    const id = await client.resolveOnlineMeetingId("a@example.test", JOIN_URL);
    expect(id).toBe("MSp0ZXN0-meeting-id");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-1");
    expect(calls[0]!.headers["Accept"]).toBe("application/json");
  });

  it("resolveOnlineMeetingId returns null when Graph matches no meeting", async () => {
    const { fetch } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    expect(
      await client.resolveOnlineMeetingId("a@example.test", JOIN_URL),
    ).toBeNull();
  });

  it("resolveOnlineMeetingId maps 404 to null rather than throwing", async () => {
    // The shared #request maps 404 → TranscriptNotAvailableError; for
    // resolution "no such meeting" is a normal answer, not a failure.
    const { fetch } = scriptFetch([response({ status: 404 })]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    expect(
      await client.resolveOnlineMeetingId("a@example.test", JOIN_URL),
    ).toBeNull();
  });

  it("resolveOnlineMeetingId URL-encodes the joinWebUrl filter and escapes single quotes", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    // A single quote in the URL would otherwise terminate the OData
    // string literal — doubled per OData, then percent-encoded.
    await client.resolveOnlineMeetingId(
      "a@example.test",
      "https://teams.microsoft.com/l/meetup-join/it's",
    );
    const url = calls[0]!.url;
    expect(url).toContain("/me/onlineMeetings?$filter=");
    expect(url).toContain(encodeURIComponent("it''s"));
    // The raw (unencoded) quote must not survive into the query string.
    expect(url).not.toContain("it's");
  });

  it("resolveOnlineMeetingId requests a token for the OnlineMeetings.Read scope", async () => {
    const tokenCalls: { account: string; scope: string; forceRefresh: boolean }[] = [];
    const { fetch } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTranscriptClient({
      fetch,
      getAccessToken: async (account, scope, forceRefresh) => {
        tokenCalls.push({ account, scope, forceRefresh });
        return "t";
      },
    });
    await client.resolveOnlineMeetingId("a@example.test", JOIN_URL);
    // NOT the transcript scope — resolution is a separate grant.
    expect(tokenCalls).toEqual([
      {
        account: "a@example.test",
        scope: "https://graph.microsoft.com/OnlineMeetings.Read",
        forceRefresh: false,
      },
    ]);
  });

  it("resolveOnlineMeetingId retries once with a forced-refresh token on 401", async () => {
    const tokenCalls: boolean[] = [];
    const { fetch, calls } = scriptFetch([
      response({ status: 401 }),
      response({ status: 200, body: JSON.stringify({ value: [{ id: "m-1" }] }) }),
    ]);
    const client = new HttpTranscriptClient({
      fetch,
      getAccessToken: async (_a, _s, forceRefresh) => {
        tokenCalls.push(forceRefresh);
        return forceRefresh ? "fresh" : "stale";
      },
    });
    const id = await client.resolveOnlineMeetingId("a@example.test", JOIN_URL);
    expect(id).toBe("m-1");
    expect(tokenCalls).toEqual([false, true]);
    expect(calls[1]!.headers["Authorization"]).toBe("Bearer fresh");
  });

  it("resolveOnlineMeetingId maps 429 to GraphRateLimitedError", async () => {
    const { fetch } = scriptFetch([
      response({ status: 429, headers: { "Retry-After": "17" } }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    await expect(
      client.resolveOnlineMeetingId("a@example.test", JOIN_URL),
    ).rejects.toBeInstanceOf(GraphRateLimitedError);
  });

  it("resolveOnlineMeetingId redacts the bearer token from error messages", async () => {
    const { fetch } = scriptFetch([
      response({ status: 500, body: "boom super-secret-token boom" }),
      response({ status: 500, body: "boom super-secret-token boom" }),
      response({ status: 500, body: "boom super-secret-token boom" }),
    ]);
    const client = new HttpTranscriptClient({
      fetch,
      getAccessToken: tokenFor("super-secret-token"),
      sleep: async () => {},
      random: () => 0,
    });
    await expect(
      client.resolveOnlineMeetingId("a@example.test", JOIN_URL),
    ).rejects.toThrow(/\[redacted\]/);
    await expect(
      client.resolveOnlineMeetingId("a@example.test", JOIN_URL),
    ).rejects.not.toThrow(/super-secret-token/);
  });
});

describe("HttpTranscriptClient.listTranscripts", () => {
  it("requests /me/onlineMeetings/{id}/transcripts with a bearer token", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("tok-1") });
    await client.listTranscripts("a@example.test", "meeting-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://graph.microsoft.com/v1.0/me/onlineMeetings/meeting-1/transcripts",
    );
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok-1");
    expect(calls[0]!.headers["Accept"]).toBe("application/json");
  });

  it("URL-encodes the onlineMeetingId", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    await client.listTranscripts("a@example.test", "meeting/with slash");
    expect(calls[0]!.url).toContain(encodeURIComponent("meeting/with slash"));
  });

  it("resolves the access token via account + scope, not a caller-supplied token", async () => {
    const tokenCalls: { account: string; scope: string; forceRefresh: boolean }[] = [];
    const { fetch } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTranscriptClient({
      fetch,
      getAccessToken: async (account, scope, forceRefresh) => {
        tokenCalls.push({ account, scope, forceRefresh });
        return "t";
      },
    });
    await client.listTranscripts("a@example.test", "meeting-1");
    expect(tokenCalls).toEqual([
      {
        account: "a@example.test",
        scope: "https://graph.microsoft.com/OnlineMeetingTranscript.Read.All",
        forceRefresh: false,
      },
    ]);
  });

  it("maps Graph list entries into TranscriptHandle rows", async () => {
    const { fetch } = scriptFetch([
      response({
        status: 200,
        body: JSON.stringify({
          value: [
            {
              id: "tr-1",
              createdDateTime: "2026-04-13T11:00:00Z",
              transcriptContentUrl: "https://example.test/content/tr-1",
            },
            { id: "tr-2", createdDateTime: "2026-04-13T12:00:00Z" },
          ],
        }),
      }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    const handles = await client.listTranscripts("a@example.test", "meeting-1");
    expect(handles).toEqual([
      {
        transcriptId: "tr-1",
        createdAt: "2026-04-13T11:00:00Z",
        contentUrl: "https://example.test/content/tr-1",
      },
      { transcriptId: "tr-2", createdAt: "2026-04-13T12:00:00Z" },
    ]);
    expect(Object.keys(handles[1]!)).not.toContain("contentUrl");
  });

  it("empty value[] produces an empty handle list", async () => {
    const { fetch } = scriptFetch([
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    await expect(client.listTranscripts("a@example.test", "meeting-1")).resolves.toEqual([]);
  });
});

describe("HttpTranscriptClient.fetchVttContent", () => {
  it("uses handle.contentUrl when present", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: "WEBVTT\n\nhello" }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    const result = await client.fetchVttContent("a@example.test", "meeting-1", {
      transcriptId: "tr-1",
      createdAt: "2026-04-13T11:00:00Z",
      contentUrl: "https://example.test/content/tr-1",
    });
    expect(calls[0]!.url).toBe("https://example.test/content/tr-1");
    expect(result).toEqual({ vtt: "WEBVTT\n\nhello" });
  });

  it("constructs the content URL from onlineMeetingId + transcriptId when contentUrl is absent", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 200, body: "WEBVTT\n\nhi" }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    await client.fetchVttContent("a@example.test", "meeting-1", {
      transcriptId: "tr-1",
      createdAt: "2026-04-13T11:00:00Z",
    });
    expect(calls[0]!.url).toBe(
      "https://graph.microsoft.com/v1.0/me/onlineMeetings/meeting-1/transcripts/tr-1/content?$format=text/vtt",
    );
    expect(calls[0]!.headers["Accept"]).toBe("text/vtt");
  });
});

describe("HttpTranscriptClient error mapping", () => {
  it("401 forces a token refresh and retries once; second 401 surfaces as TokenExpiredError", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 401, body: "no" }),
      response({ status: 401, body: "still no" }),
    ]);
    const tokenCalls: boolean[] = [];
    const client = new HttpTranscriptClient({
      fetch,
      getAccessToken: async (_a, _s, forceRefresh) => {
        tokenCalls.push(forceRefresh);
        return "t";
      },
    });
    await expect(client.listTranscripts("a@example.test", "meeting-1")).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
    expect(calls).toHaveLength(2);
    expect(tokenCalls).toEqual([false, true]);
  });

  it("401 then 200 succeeds on the forced-refresh retry", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 401, body: "no" }),
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    await expect(client.listTranscripts("a@example.test", "meeting-1")).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("402 surfaces as TranscriptQuotaExhaustedError (metered content-fetch limit)", async () => {
    const { fetch } = scriptFetch([response({ status: 402, body: "quota" })]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    await expect(
      client.fetchVttContent("a@example.test", "meeting-1", { transcriptId: "tr-1", createdAt: "x" }),
    ).rejects.toBeInstanceOf(TranscriptQuotaExhaustedError);
  });

  it("403 surfaces as TranscriptNotAvailableError", async () => {
    const { fetch } = scriptFetch([response({ status: 403, body: "no" })]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    await expect(client.listTranscripts("a@example.test", "meeting-1")).rejects.toBeInstanceOf(
      TranscriptNotAvailableError,
    );
  });

  // Real payload observed in production 2026-08-20 against the ifacto
  // tenant. Graph documents branching on innerError.code, not the message.
  const GRAPH_DISABLED_BODY = JSON.stringify({
    error: {
      code: "Forbidden",
      message: "Graph API access to transcripts is disabled for this tenant.",
      innerError: { code: "GraphAccessToTranscriptsDisabled" },
    },
  });

  const ATTRIBUTION_DISABLED_BODY = JSON.stringify({
    error: {
      code: "Forbidden",
      message: "Speaker attribution is not allowed.",
      innerError: { code: "SpeakerAttributionNotAllowed" },
    },
  });

  it("403 with GraphAccessToTranscriptsDisabled surfaces as TranscriptApiDisabledError, not not-available", async () => {
    const { fetch } = scriptFetch([
      response({ status: 403, body: GRAPH_DISABLED_BODY }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    const err = await client
      .listTranscripts("a@example.test", "meeting-1")
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptApiDisabledError);
    // Must NOT be treated as a permanent per-meeting fact.
    expect(err).not.toBeInstanceOf(TranscriptNotAvailableError);
  });

  it("403 with SpeakerAttributionNotAllowed surfaces as TranscriptSpeakerAttributionDisabledError", async () => {
    const { fetch } = scriptFetch([
      response({ status: 403, body: ATTRIBUTION_DISABLED_BODY }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    const err = await client
      .fetchVttContent("a@example.test", "meeting-1", {
        transcriptId: "tr-1",
        createdAt: "x",
      })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptSpeakerAttributionDisabledError);
    expect(err).not.toBeInstanceOf(TranscriptNotAvailableError);
  });

  it("both tenant-config errors name the admin toggle that fixes them", async () => {
    for (const [body, needle] of [
      [GRAPH_DISABLED_BODY, "EnableGraphTranscriptAccess"],
      [ATTRIBUTION_DISABLED_BODY, "EnableAttributedTranscripts"],
    ] as const) {
      const { fetch } = scriptFetch([response({ status: 403, body })]);
      const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
      await expect(
        client.listTranscripts("a@example.test", "meeting-1"),
      ).rejects.toThrow(new RegExp(needle));
    }
  });

  it("403 with an unrecognized innerError.code still surfaces as TranscriptNotAvailableError", async () => {
    const { fetch } = scriptFetch([
      response({
        status: 403,
        body: JSON.stringify({
          error: { innerError: { code: "SomethingElseEntirely" } },
        }),
      }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    await expect(
      client.listTranscripts("a@example.test", "meeting-1"),
    ).rejects.toBeInstanceOf(TranscriptNotAvailableError);
  });

  it("403 with a non-JSON body falls back to TranscriptNotAvailableError without throwing a parse error", async () => {
    const { fetch } = scriptFetch([
      response({ status: 403, body: "<html>gateway said no</html>" }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    await expect(
      client.listTranscripts("a@example.test", "meeting-1"),
    ).rejects.toBeInstanceOf(TranscriptNotAvailableError);
  });

  it("404 surfaces as TranscriptNotAvailableError", async () => {
    const { fetch } = scriptFetch([response({ status: 404, body: "no" })]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    await expect(client.listTranscripts("a@example.test", "meeting-1")).rejects.toBeInstanceOf(
      TranscriptNotAvailableError,
    );
  });

  it("429 surfaces as GraphRateLimitedError with Retry-After", async () => {
    const { fetch } = scriptFetch([
      response({ status: 429, body: "", headers: { "Retry-After": "7" } }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    try {
      await client.listTranscripts("a@example.test", "meeting-1");
      expect.fail("expected throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(GraphRateLimitedError);
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(7);
    }
  });

  it("429 defaults to 60s when Retry-After is missing or malformed", async () => {
    for (const hdr of [{}, { "Retry-After": "abc" }]) {
      const { fetch } = scriptFetch([response({ status: 429, body: "", headers: hdr })]);
      const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
      try {
        await client.listTranscripts("a@example.test", "meeting-1");
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
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    try {
      await client.listTranscripts("a@example.test", "meeting-1");
      expect.fail("expected throw");
    } catch (caught) {
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(60);
    }
  });

  it("429 with Retry-After: 0 uses 0, not the 60s default", async () => {
    const { fetch } = scriptFetch([
      response({ status: 429, body: "", headers: { "Retry-After": "0" } }),
    ]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    try {
      await client.listTranscripts("a@example.test", "meeting-1");
      expect.fail("expected throw");
    } catch (caught) {
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(0);
    }
  });

  it("jitter uses the injected random source for the exact sleep duration", async () => {
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
      const client = new HttpTranscriptClient({
        fetch,
        getAccessToken: tokenFor("t"),
        sleep,
        random: () => c.random,
      });
      await client.listTranscripts("a@example.test", "meeting-1");
      expect(sleeps[0]).toBe(c.expectedFirstSleep);
    }
  });

  it("non-2xx error body truncated to <=200 chars", async () => {
    const longBody = "x".repeat(500);
    const { fetch } = scriptFetch([response({ status: 500, body: longBody })]);
    const client = new HttpTranscriptClient({ fetch, getAccessToken: tokenFor("t") });
    try {
      await client.listTranscripts("a@example.test", "meeting-1");
      expect.fail("expected throw");
    } catch (caught) {
      const err = caught as Error;
      const excerpt = err.message.split("500: ")[1] ?? "";
      expect(excerpt.length).toBeLessThanOrEqual(200);
    }
  });

  it("bearer token is redacted from error messages", async () => {
    const secret = "tok-TRANSCRIPT-SECRET-do-not-leak";
    const { fetch } = scriptFetch([response({ status: 500, body: `boom ${secret}` })]);
    const client = new HttpTranscriptClient({
      fetch,
      getAccessToken: tokenFor(secret),
      sleep: async () => {},
      random: () => 0,
    });
    try {
      await client.listTranscripts("a@example.test", "meeting-1");
      expect.fail("expected throw");
    } catch (caught) {
      const msg = (caught as Error).message;
      expect(msg).not.toContain(secret);
      expect(msg).toContain("[redacted]");
    }
  });

  it("5xx retries once before surfacing transient-5xx: 503 then 200 succeeds", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 503, body: "unavailable" }),
      response({ status: 200, body: JSON.stringify({ value: [] }) }),
    ]);
    const { sleep, sleeps } = recordSleep();
    const client = new HttpTranscriptClient({
      fetch,
      getAccessToken: tokenFor("t"),
      sleep,
      random: () => 0.5,
    });
    await expect(client.listTranscripts("a@example.test", "meeting-1")).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it("gives up after maxRetries and surfaces transient-5xx", async () => {
    const { fetch, calls } = scriptFetch([
      response({ status: 503, body: "boom" }),
      response({ status: 503, body: "boom" }),
      response({ status: 503, body: "final boom" }),
    ]);
    const { sleep, sleeps } = recordSleep();
    const client = new HttpTranscriptClient({
      fetch,
      getAccessToken: tokenFor("t"),
      sleep,
      random: () => 0,
    });
    await expect(client.listTranscripts("a@example.test", "meeting-1")).rejects.toThrow(/HTTP 503/);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([250, 750]);
  });

  it("does not apply the 5xx backoff/retry path on 402, 403, 404, or 429 (single HTTP call)", async () => {
    for (const status of [402, 403, 404, 429]) {
      const { fetch, calls } = scriptFetch([response({ status, body: "no" })]);
      const { sleep, sleeps } = recordSleep();
      const client = new HttpTranscriptClient({
        fetch,
        getAccessToken: tokenFor("t"),
        sleep,
        random: () => 0,
      });
      await expect(client.listTranscripts("a@example.test", "meeting-1")).rejects.toBeInstanceOf(Error);
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });

  describe("default sleep", () => {
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
      const client = new HttpTranscriptClient({
        fetch,
        getAccessToken: tokenFor("t"),
        random: () => 0,
      });

      const promise = client.listTranscripts("a@example.test", "meeting-1");
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(250);
      await expect(promise).resolves.toEqual([]);
    });
  });
});

describe("parseVtt", () => {
  it("parses basic cues with timestamps and text", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:01.000 --> 00:00:04.500",
      "Hello everyone.",
      "",
      "2",
      "00:00:05.000 --> 00:00:08.000",
      "Let's get started.",
    ].join("\n");
    const cues = parseVtt(vtt);
    // toStrictEqual (not toEqual): speakerName/speakerEmail must be
    // genuinely absent keys here, not present-with-value-undefined.
    expect(cues).toStrictEqual([
      { sequence: 0, startMs: 1000, endMs: 4500, text: "Hello everyone." },
      { sequence: 1, startMs: 5000, endMs: 8000, text: "Let's get started." },
    ]);
  });

  it("parses a voice tag with name only", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "<v Kristof Peeters>Hello everyone.",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues[0]).toEqual({
      sequence: 0,
      startMs: 1000,
      endMs: 4000,
      speakerName: "Kristof Peeters",
      text: "Hello everyone.",
    });
  });

  it("parses a voice tag with an email-shaped class as speakerEmail", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "<v.kristof@example.test Kristof Peeters>Hello everyone.",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues[0]).toMatchObject({
      speakerName: "Kristof Peeters",
      speakerEmail: "kristof@example.test",
      text: "Hello everyone.",
    });
  });

  it("ignores a non-email-shaped voice tag class (e.g. loudness styling)", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "<v.loud Kristof>Hello!",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues[0]?.speakerEmail).toBeUndefined();
    expect(cues[0]?.speakerName).toBe("Kristof");
  });

  it("handles overlapping cue times without special-casing them", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:05.000",
      "First speaker talking over.",
      "",
      "00:00:03.000 --> 00:00:06.000",
      "Second speaker interjects.",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.startMs).toBe(1000);
    expect(cues[1]?.startMs).toBe(3000);
  });

  it("supports HH:MM:SS.mmm and MM:SS.mmm timestamp forms", () => {
    const vtt = [
      "WEBVTT",
      "",
      "01:00:01.500 --> 01:00:04.000",
      "with hours",
      "",
      "00:10.000 --> 00:12.000",
      "without hours",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues[0]?.startMs).toBe((60 * 60 + 1) * 1000 + 500);
    expect(cues[1]?.startMs).toBe(10 * 1000);
  });

  it("joins multi-line cue text into one string", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "First line",
      "second line",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues[0]?.text).toBe("First line second line");
  });

  it("handles unicode text", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "<v Café Speaker>Bonjour à tous ☕",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues[0]?.speakerName).toBe("Café Speaker");
    expect(cues[0]?.text).toBe("Bonjour à tous ☕");
  });

  it("returns an empty array for empty or header-only input", () => {
    expect(parseVtt("")).toEqual([]);
    expect(parseVtt("WEBVTT\n")).toEqual([]);
    expect(parseVtt("WEBVTT")).toEqual([]);
  });

  it("parses cues even when the WEBVTT header line is missing entirely", () => {
    const vtt = ["00:00:01.000 --> 00:00:02.000", "no header at all"].join("\n");
    expect(parseVtt(vtt)).toEqual([
      { sequence: 0, startMs: 1000, endMs: 2000, text: "no header at all" },
    ]);
  });

  it("rejects a timestamp with leading junk (^ anchor)", () => {
    const vtt = [
      "WEBVTT",
      "",
      "xx00:00:01.000 --> 00:00:02.000",
      "dropped",
    ].join("\n");
    expect(parseVtt(vtt)).toEqual([]);
  });

  it("rejects a timestamp with trailing junk ($ anchor)", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000xx --> 00:00:02.000",
      "dropped",
    ].join("\n");
    expect(parseVtt(vtt)).toEqual([]);
  });

  it("drops a cue whose start timestamp fails to parse but keeps later valid cues", () => {
    const vtt = [
      "WEBVTT",
      "",
      "bogus --> 00:00:02.000",
      "dropped",
      "",
      "00:00:03.000 --> 00:00:04.000",
      "kept",
    ].join("\n");
    expect(parseVtt(vtt)).toEqual([
      { sequence: 0, startMs: 3000, endMs: 4000, text: "kept" },
    ]);
  });

  it("drops a cue whose end timestamp fails to parse", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> bogus",
      "dropped",
    ].join("\n");
    expect(parseVtt(vtt)).toEqual([]);
  });

  it("drops a cue with a timing line but no text before the next blank line", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "",
      "00:00:03.000 --> 00:00:04.000",
      "kept",
    ].join("\n");
    expect(parseVtt(vtt)).toEqual([
      { sequence: 0, startMs: 3000, endMs: 4000, text: "kept" },
    ]);
  });

  it("does not treat a voice tag as a speaker when it isn't at the very start of the cue text", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "prefix <v Name>text",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues[0]?.speakerName).toBeUndefined();
    expect(cues[0]?.text).toBe("prefix <v Name>text");
  });

  it("treats a class token without a dot after @ as non-email-shaped", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "<v.kristof@examplecom Name>text",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues[0]?.speakerEmail).toBeUndefined();
  });

  it("leaves speakerName undefined when the voice tag's name is blank", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "<v >text",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues[0]?.speakerName).toBeUndefined();
    expect(cues[0]?.text).toBe("text");
  });

  it("strips a trailing closing </v> tag from the cue text", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "<v Name>text</v>",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues[0]?.text).toBe("text");
  });

  it("keeps a literal </v>-shaped substring that isn't a trailing close tag", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "<v Name>text</v> and more",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues[0]?.text).toBe("text</v> and more");
  });

  it("skips a NOTE/STYLE-shaped block that isn't a cue-identifier or timing line", () => {
    const vtt = [
      "WEBVTT",
      "",
      "NOTE",
      "this is a comment block, not a cue",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "real cue",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues).toEqual([
      { sequence: 0, startMs: 1000, endMs: 2000, text: "real cue" },
    ]);
  });

  it("assigns sequence by order of appearance, not by any cue-identifier line", () => {
    const vtt = [
      "WEBVTT",
      "",
      "cue-id-99",
      "00:00:01.000 --> 00:00:02.000",
      "first",
      "",
      "cue-id-1",
      "00:00:03.000 --> 00:00:04.000",
      "second",
    ].join("\n");
    const cues = parseVtt(vtt);
    expect(cues.map((c) => c.sequence)).toEqual([0, 1]);
    expect(cues.map((c) => c.text)).toEqual(["first", "second"]);
  });
});
