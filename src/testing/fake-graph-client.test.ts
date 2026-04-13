import { describe, expect, it } from "vitest";
import {
  DeltaTokenInvalidError,
  GraphRateLimitedError,
  TokenExpiredError,
  type GraphDeltaResponse,
} from "../sources/graph.js";
import { FakeGraphClient } from "./fake-graph-client.js";

function okPage(id: string, deltaLink?: string): GraphDeltaResponse {
  return {
    value: [
      { id, receivedDateTime: "2026-04-13T09:00:00Z", subject: `subj-${id}` },
    ],
    ...(deltaLink ? { "@odata.deltaLink": deltaLink } : {}),
  };
}

describe("FakeGraphClient", () => {
  it("getDelta returns the scripted response and records url + token", async () => {
    const response: GraphDeltaResponse = {
      value: [
        {
          id: "AAMk-1",
          receivedDateTime: "2026-04-13T09:00:00Z",
          subject: "hello",
        },
      ],
      "@odata.deltaLink":
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc",
    };
    const client = new FakeGraphClient({
      steps: [{ kind: "ok", response }],
    });

    const result = await client.getDelta(
      "/me/mailFolders/inbox/messages/delta",
      "token-1",
    );

    expect(result).toBe(response);
    expect(client.calls).toEqual([
      { url: "/me/mailFolders/inbox/messages/delta", token: "token-1" },
    ]);
  });

  it("successive getDelta calls consume scripted steps in order", async () => {
    const first = okPage("msg-1");
    const second = okPage("msg-2", "https://graph.microsoft.com/delta?token=zz");
    const client = new FakeGraphClient({
      steps: [
        { kind: "ok", response: first },
        { kind: "ok", response: second },
      ],
    });
    expect(client.remainingSteps).toBe(2);

    const a = await client.getDelta("/delta", "t");
    expect(a).toBe(first);
    expect(client.remainingSteps).toBe(1);

    const b = await client.getDelta("/delta?nextLink=1", "t");
    expect(b).toBe(second);
    expect(client.remainingSteps).toBe(0);

    expect(client.calls.map((c) => c.url)).toEqual([
      "/delta",
      "/delta?nextLink=1",
    ]);
  });

  it("getDelta throws the scripted error for that step", async () => {
    const client = new FakeGraphClient({
      steps: [
        { kind: "error", error: new TokenExpiredError("401") },
        { kind: "error", error: new DeltaTokenInvalidError("410") },
      ],
    });

    await expect(client.getDelta("/delta", "t")).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
    await expect(client.getDelta("/delta", "t")).rejects.toBeInstanceOf(
      DeltaTokenInvalidError,
    );
    expect(client.calls).toHaveLength(2);
    expect(client.remainingSteps).toBe(0);
  });

  it("getDelta throws when no scripted step remains", async () => {
    const client = new FakeGraphClient({ steps: [] });
    await expect(
      client.getDelta("/me/mailFolders/inbox/messages/delta", "t"),
    ).rejects.toThrowError(
      /no scripted response for call #1 to \/me\/mailFolders\/inbox\/messages\/delta/,
    );
  });

  it("GraphRateLimitedError exposes retryAfterSeconds", async () => {
    const err = new GraphRateLimitedError(42);
    const client = new FakeGraphClient({
      steps: [{ kind: "error", error: err }],
    });

    try {
      await client.getDelta("/delta", "t");
      expect.fail("expected throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(GraphRateLimitedError);
      expect((caught as GraphRateLimitedError).retryAfterSeconds).toBe(42);
      expect((caught as Error).message).toContain("42");
    }
  });
});
