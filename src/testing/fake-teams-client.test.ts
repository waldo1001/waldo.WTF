import { describe, expect, it } from "vitest";
import {
  GraphRateLimitedError,
  TokenExpiredError,
  type TeamsChatListPage,
  type TeamsMessagesPage,
} from "../sources/teams.js";
import { FakeTeamsClient } from "./fake-teams-client.js";

describe("FakeTeamsClient", () => {
  it("listChats returns the scripted page and records token + nextLink", async () => {
    const page: TeamsChatListPage = {
      value: [
        { id: "chat-1", chatType: "oneOnOne", topic: null },
        { id: "chat-2", chatType: "group", topic: "Hiking" },
      ],
    };
    const client = new FakeTeamsClient({
      steps: [{ kind: "listChatsOk", response: page }],
    });
    const got = await client.listChats("token-1");
    expect(got).toBe(page);
    expect(client.calls).toEqual([{ method: "listChats", token: "token-1" }]);
  });

  it("listChats records nextLink when present", async () => {
    const page: TeamsChatListPage = { value: [] };
    const client = new FakeTeamsClient({
      steps: [{ kind: "listChatsOk", response: page }],
    });
    await client.listChats("t", "https://graph.microsoft.com/next");
    expect(client.calls[0]).toEqual({
      method: "listChats",
      token: "t",
      nextLink: "https://graph.microsoft.com/next",
    });
  });

  it("getChatMessages returns scripted page and records chatId + sinceIso", async () => {
    const page: TeamsMessagesPage = {
      value: [
        {
          id: "msg-1",
          createdDateTime: "2026-04-13T09:00:00Z",
          chatId: "chat-1",
          messageType: "message",
          from: { user: { displayName: "Alice", id: "u-1" } },
          body: { contentType: "text", content: "hello" },
        },
      ],
    };
    const client = new FakeTeamsClient({
      steps: [{ kind: "getChatMessagesOk", response: page }],
    });
    const got = await client.getChatMessages("t", "chat-1", {
      sinceIso: "2026-04-13T00:00:00Z",
    });
    expect(got).toBe(page);
    expect(client.calls).toEqual([
      {
        method: "getChatMessages",
        token: "t",
        chatId: "chat-1",
        sinceIso: "2026-04-13T00:00:00Z",
      },
    ]);
  });

  it("getChatMessages records nextLink and omits sinceIso when not passed", async () => {
    const page: TeamsMessagesPage = { value: [] };
    const client = new FakeTeamsClient({
      steps: [{ kind: "getChatMessagesOk", response: page }],
    });
    await client.getChatMessages("t", "chat-2", {
      nextLink: "https://graph.microsoft.com/next",
    });
    expect(client.calls[0]).toEqual({
      method: "getChatMessages",
      token: "t",
      chatId: "chat-2",
      nextLink: "https://graph.microsoft.com/next",
    });
  });

  it("successive calls consume scripted steps in order", async () => {
    const chatsPage: TeamsChatListPage = { value: [{ id: "chat-1" }] };
    const msgsPage: TeamsMessagesPage = { value: [] };
    const client = new FakeTeamsClient({
      steps: [
        { kind: "listChatsOk", response: chatsPage },
        { kind: "getChatMessagesOk", response: msgsPage },
      ],
    });
    expect(client.remainingSteps).toBe(2);
    await client.listChats("t");
    expect(client.remainingSteps).toBe(1);
    await client.getChatMessages("t", "chat-1", {});
    expect(client.remainingSteps).toBe(0);
  });

  it("throws scripted error for that step", async () => {
    const client = new FakeTeamsClient({
      steps: [
        { kind: "error", error: new TokenExpiredError("401") },
        { kind: "error", error: new GraphRateLimitedError(7) },
      ],
    });
    await expect(client.listChats("t")).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
    await expect(
      client.getChatMessages("t", "chat-1", {}),
    ).rejects.toBeInstanceOf(GraphRateLimitedError);
  });

  it("throws an informative error when no scripted step remains", async () => {
    const client = new FakeTeamsClient({ steps: [] });
    await expect(client.listChats("t")).rejects.toThrowError(
      /no scripted response for call #1 \(listChats\)/,
    );
  });

  it("rejects when step kind does not match the method called", async () => {
    const client = new FakeTeamsClient({
      steps: [{ kind: "getChatMessagesOk", response: { value: [] } }],
    });
    await expect(client.listChats("t")).rejects.toThrowError(
      /expected listChatsOk step/,
    );
  });

  it("supports @removed tombstones in messages pages", async () => {
    const page: TeamsMessagesPage = {
      value: [
        {
          id: "removed-1",
          createdDateTime: "2026-04-13T09:00:00Z",
          "@removed": { reason: "deleted" },
        },
      ],
    };
    const client = new FakeTeamsClient({
      steps: [{ kind: "getChatMessagesOk", response: page }],
    });
    const got = await client.getChatMessages("t", "chat-1", {});
    expect(got.value[0]?.["@removed"]).toEqual({ reason: "deleted" });
  });
});
