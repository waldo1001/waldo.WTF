import { describe, expect, it } from "vitest";
import {
  DeltaTokenInvalidError,
  GraphRateLimitedError,
  TokenExpiredError,
  type TeamsDeltaResponse,
  type TeamsMessage,
} from "../sources/teams.js";
import { FakeTeamsClient } from "./fake-teams-client.js";

function okPage(id: string, deltaLink?: string): TeamsDeltaResponse {
  const msg: TeamsMessage = {
    id,
    createdDateTime: "2026-04-13T09:00:00Z",
    chatId: "chat-1",
    messageType: "message",
    from: { user: { displayName: "Alice", id: "u-1" } },
    body: { contentType: "text", content: `body-${id}` },
  };
  return {
    value: [msg],
    ...(deltaLink ? { "@odata.deltaLink": deltaLink } : {}),
  };
}

describe("FakeTeamsClient", () => {
  it("getDelta returns the scripted response and records url + token", async () => {
    const response: TeamsDeltaResponse = {
      value: [
        {
          id: "1",
          createdDateTime: "2026-04-13T09:00:00Z",
          chatId: "chat-1",
          messageType: "message",
          replyToId: null,
          from: {
            user: {
              displayName: "Alice",
              id: "u-1",
              userPrincipalName: "alice@example.test",
            },
          },
          body: { contentType: "text", content: "hello" },
          mentions: [
            {
              id: 0,
              mentionText: "@bob",
              mentioned: {
                user: { displayName: "Bob", id: "u-2" },
              },
            },
          ],
          channelIdentity: null,
        },
      ],
      "@odata.deltaLink":
        "https://graph.microsoft.com/v1.0/me/chats/getAllMessages/delta?$deltatoken=abc",
    };
    const client = new FakeTeamsClient({ steps: [{ kind: "ok", response }] });

    const got = await client.getDelta(
      "/me/chats/getAllMessages/delta",
      "token-1",
    );
    expect(got).toBe(response);
    expect(client.calls).toEqual([
      { url: "/me/chats/getAllMessages/delta", token: "token-1" },
    ]);
  });

  it("successive calls consume scripted steps in order", async () => {
    const first = okPage("msg-1");
    const second = okPage("msg-2", "https://graph.microsoft.com/delta?token=zz");
    const client = new FakeTeamsClient({
      steps: [
        { kind: "ok", response: first },
        { kind: "ok", response: second },
      ],
    });
    expect(client.remainingSteps).toBe(2);
    expect(await client.getDelta("/delta", "t")).toBe(first);
    expect(client.remainingSteps).toBe(1);
    expect(await client.getDelta("/delta?page=2", "t")).toBe(second);
    expect(client.remainingSteps).toBe(0);
  });

  it("throws scripted error for that step", async () => {
    const client = new FakeTeamsClient({
      steps: [
        { kind: "error", error: new TokenExpiredError("401") },
        { kind: "error", error: new DeltaTokenInvalidError("410") },
        { kind: "error", error: new GraphRateLimitedError(7) },
      ],
    });
    await expect(client.getDelta("/delta", "t")).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
    await expect(client.getDelta("/delta", "t")).rejects.toBeInstanceOf(
      DeltaTokenInvalidError,
    );
    await expect(client.getDelta("/delta", "t")).rejects.toBeInstanceOf(
      GraphRateLimitedError,
    );
  });

  it("throws an informative error when no scripted step remains", async () => {
    const client = new FakeTeamsClient({ steps: [] });
    await expect(
      client.getDelta("/me/chats/getAllMessages/delta", "t"),
    ).rejects.toThrowError(
      /no scripted response for call #1 to \/me\/chats\/getAllMessages\/delta/,
    );
  });

  it("supports @removed tombstones in the scripted response", async () => {
    const response: TeamsDeltaResponse = {
      value: [
        {
          id: "removed-1",
          createdDateTime: "2026-04-13T09:00:00Z",
          "@removed": { reason: "deleted" },
        },
      ],
    };
    const client = new FakeTeamsClient({ steps: [{ kind: "ok", response }] });
    const got = await client.getDelta("/delta", "t");
    expect(got.value[0]?.["@removed"]).toEqual({ reason: "deleted" });
  });
});
