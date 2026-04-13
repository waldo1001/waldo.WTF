import { describe, it, expect } from "vitest";
import { syncTeams } from "./sync-teams.js";
import { FakeAuthClient } from "../testing/fake-auth-client.js";
import { FakeTeamsClient } from "../testing/fake-teams-client.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { FakeClock } from "../testing/fake-clock.js";
import type { Account, AccessToken } from "../auth/types.js";
import {
  GraphRateLimitedError,
  TokenExpiredError,
  type TeamsChat,
  type TeamsChatListPage,
  type TeamsMessage,
  type TeamsMessagesPage,
} from "../sources/teams.js";

const account: Account = {
  username: "alice@example.invalid",
  homeAccountId: "home-alice",
  tenantId: "tenant-alice",
};

const accessToken: AccessToken = {
  token: "teams-tok",
  expiresOn: new Date("2026-04-13T11:00:00Z"),
  account,
};

const authWithToken = () =>
  new FakeAuthClient({
    accounts: [account],
    tokens: new Map([[account.homeAccountId, accessToken]]),
  });

const chat = (id: string, overrides: Partial<TeamsChat> = {}): TeamsChat => ({
  id,
  chatType: "oneOnOne",
  topic: null,
  ...overrides,
});

const chatsPage = (value: TeamsChat[], nextLink?: string): TeamsChatListPage =>
  nextLink !== undefined ? { value, "@odata.nextLink": nextLink } : { value };

const msgsPage = (
  value: TeamsMessage[],
  nextLink?: string,
): TeamsMessagesPage =>
  nextLink !== undefined ? { value, "@odata.nextLink": nextLink } : { value };

const makeTeamsMsg = (overrides: Partial<TeamsMessage> = {}): TeamsMessage => ({
  id: "tmsg-1",
  createdDateTime: "2026-04-13T10:00:00Z",
  chatId: "chat-1",
  messageType: "message",
  from: {
    user: {
      id: "u-1",
      displayName: "Alice",
      userPrincipalName: "alice@example.invalid",
    },
  },
  body: { contentType: "text", content: "hi" },
  ...overrides,
});

describe("syncTeams (polling)", () => {
  it("enumerates chats via listChats, fetches messages per chat, upserts them", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        { kind: "listChatsOk", response: chatsPage([chat("chat-1"), chat("chat-2")]) },
        { kind: "getChatMessagesOk", response: msgsPage([makeTeamsMsg({ id: "m1", chatId: "chat-1" })]) },
        { kind: "getChatMessagesOk", response: msgsPage([makeTeamsMsg({ id: "m2", chatId: "chat-2" })]) },
      ],
    });
    const auth = authWithToken();

    const result = await syncTeams({ account, auth, teams, store, clock });
    expect(result).toEqual({ added: 2, removed: 0 });

    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted.map((m) => m.nativeId).sort()).toEqual(["m1", "m2"]);
    expect(upserted[0]?.source).toBe("teams");
    expect(upserted[0]?.id).toBe(`teams:${account.username}:m1`);
  });

  it("reads per-chat cursor, passes sinceIso on subsequent runs, and advances cursor", async () => {
    const store = new InMemoryMessageStore();
    await store.setChatCursor({
      account: account.username,
      chatId: "chat-1",
      cursor: "2026-04-13T09:00:00.000Z",
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        { kind: "listChatsOk", response: chatsPage([chat("chat-1")]) },
        {
          kind: "getChatMessagesOk",
          response: msgsPage([
            makeTeamsMsg({ id: "newer", createdDateTime: "2026-04-13T10:30:00Z" }),
          ]),
        },
      ],
    });
    const auth = authWithToken();

    await syncTeams({ account, auth, teams, store, clock });

    const getMsgsCall = teams.calls.find((c) => c.method === "getChatMessages");
    expect(getMsgsCall).toMatchObject({
      method: "getChatMessages",
      chatId: "chat-1",
      sinceIso: "2026-04-13T09:00:00.000Z",
    });
    const newCursor = await store.getChatCursor(account.username, "chat-1");
    expect(newCursor).toBe("2026-04-13T10:30:00Z");
  });

  it("with backfillDays and no stored cursor, seeds sinceIso from clock.now() - N days", async () => {
    const store = new InMemoryMessageStore();
    const now = new Date("2026-04-13T12:00:00Z");
    const clock = new FakeClock(now);
    const teams = new FakeTeamsClient({
      steps: [
        { kind: "listChatsOk", response: chatsPage([chat("chat-1")]) },
        { kind: "getChatMessagesOk", response: msgsPage([]) },
      ],
    });
    const auth = authWithToken();

    await syncTeams({ account, auth, teams, store, clock, backfillDays: 7 });

    const expected = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const getMsgsCall = teams.calls.find((c) => c.method === "getChatMessages");
    expect(getMsgsCall).toMatchObject({
      method: "getChatMessages",
      chatId: "chat-1",
      sinceIso: expected,
    });
  });

  it("without backfillDays and no stored cursor, passes no sinceIso (full chat backfill)", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        { kind: "listChatsOk", response: chatsPage([chat("chat-1")]) },
        { kind: "getChatMessagesOk", response: msgsPage([]) },
      ],
    });
    const auth = authWithToken();

    await syncTeams({ account, auth, teams, store, clock });

    const getMsgsCall = teams.calls.find((c) => c.method === "getChatMessages");
    if (getMsgsCall?.method !== "getChatMessages") throw new Error("expected call");
    expect(getMsgsCall.sinceIso).toBeUndefined();
  });

  it("follows @odata.nextLink across both chat-listing and per-chat pages", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        { kind: "listChatsOk", response: chatsPage([chat("chat-1")], "https://graph/chats?skip=1") },
        { kind: "listChatsOk", response: chatsPage([chat("chat-2")]) },
        {
          kind: "getChatMessagesOk",
          response: msgsPage([makeTeamsMsg({ id: "a", chatId: "chat-1" })], "https://graph/c1?skip=1"),
        },
        {
          kind: "getChatMessagesOk",
          response: msgsPage([makeTeamsMsg({ id: "b", chatId: "chat-1" })]),
        },
        {
          kind: "getChatMessagesOk",
          response: msgsPage([makeTeamsMsg({ id: "c", chatId: "chat-2" })]),
        },
      ],
    });
    const auth = authWithToken();

    const res = await syncTeams({ account, auth, teams, store, clock });
    expect(res.added).toBe(3);
    expect(teams.calls.filter((c) => c.method === "listChats")).toHaveLength(2);
    expect(teams.calls.filter((c) => c.method === "getChatMessages")).toHaveLength(3);
  });

  it("maps oneOnOne → chatType=oneOnOne, group → group, topic → threadName", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        {
          kind: "listChatsOk",
          response: chatsPage([
            chat("chat-1", { chatType: "oneOnOne" }),
            chat("chat-2", { chatType: "group", topic: "Hiking" }),
          ]),
        },
        { kind: "getChatMessagesOk", response: msgsPage([makeTeamsMsg({ id: "p1", chatId: "chat-1" })]) },
        { kind: "getChatMessagesOk", response: msgsPage([makeTeamsMsg({ id: "p2", chatId: "chat-2" })]) },
      ],
    });
    const auth = authWithToken();
    await syncTeams({ account, auth, teams, store, clock });
    const msgs = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    const p1 = msgs.find((m) => m.nativeId === "p1");
    const p2 = msgs.find((m) => m.nativeId === "p2");
    expect(p1?.chatType).toBe("oneOnOne");
    expect(p2?.chatType).toBe("group");
    expect(p2?.threadName).toBe("Hiking");
  });

  it("maps text + html body, replyToId, mentions", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        { kind: "listChatsOk", response: chatsPage([chat("chat-1")]) },
        {
          kind: "getChatMessagesOk",
          response: msgsPage([
            makeTeamsMsg({ id: "plain", body: { contentType: "text", content: "plain" } }),
            makeTeamsMsg({ id: "rich", body: { contentType: "html", content: "<p>rich</p>" } }),
            makeTeamsMsg({
              id: "reply",
              replyToId: "root",
              mentions: [
                {
                  id: 0,
                  mentionText: "@bob",
                  mentioned: {
                    user: {
                      id: "u-2",
                      displayName: "Bob",
                      userPrincipalName: "bob@example.invalid",
                    },
                  },
                },
                { id: 1, mentionText: "@nameless" },
                { id: 2, mentioned: { user: { id: "u-3", displayName: "Carol" } } },
                { id: 3, mentioned: { user: { id: "u-4" } } },
              ],
            }),
          ]),
        },
      ],
    });
    const auth = authWithToken();
    await syncTeams({ account, auth, teams, store, clock });
    const msgs = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    const plain = msgs.find((m) => m.nativeId === "plain");
    const rich = msgs.find((m) => m.nativeId === "rich");
    const reply = msgs.find((m) => m.nativeId === "reply");
    expect(plain?.body).toBe("plain");
    expect(plain?.bodyHtml).toBeUndefined();
    expect(rich?.bodyHtml).toBe("<p>rich</p>");
    expect(rich?.body).toBeUndefined();
    expect(reply?.replyToId).toBe("root");
    expect(reply?.mentions).toEqual(["bob@example.invalid", "@nameless", "Carol"]);
  });

  it("TokenExpiredError from listChats propagates without writing syncState", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [{ kind: "error", error: new TokenExpiredError("401") }],
    });
    const auth = authWithToken();

    await expect(
      syncTeams({ account, auth, teams, store, clock }),
    ).rejects.toBeInstanceOf(TokenExpiredError);
    expect(
      store.calls.some(
        (c) => c.method === "setSyncState" && c.entry.source === "teams",
      ),
    ).toBe(false);
  });

  it("TokenExpiredError from getChatMessages propagates (hard stop)", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        { kind: "listChatsOk", response: chatsPage([chat("chat-1")]) },
        { kind: "error", error: new TokenExpiredError("401") },
      ],
    });
    const auth = authWithToken();
    await expect(
      syncTeams({ account, auth, teams, store, clock }),
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("GraphRateLimitedError from getChatMessages propagates (hard stop)", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        { kind: "listChatsOk", response: chatsPage([chat("chat-1")]) },
        { kind: "error", error: new GraphRateLimitedError(30) },
      ],
    });
    const auth = authWithToken();
    await expect(
      syncTeams({ account, auth, teams, store, clock }),
    ).rejects.toBeInstanceOf(GraphRateLimitedError);
  });

  it("non-hard-stop error on one chat is isolated — other chats still sync", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        { kind: "listChatsOk", response: chatsPage([chat("chat-bad"), chat("chat-good")]) },
        { kind: "error", error: new Error("teams request failed: HTTP 500") },
        { kind: "getChatMessagesOk", response: msgsPage([makeTeamsMsg({ id: "ok", chatId: "chat-good" })]) },
      ],
    });
    const auth = authWithToken();
    const res = await syncTeams({ account, auth, teams, store, clock });
    expect(res.added).toBe(1);
    const state = await store.getSyncState(account.username, "teams");
    expect(state?.lastSyncAt).toBeDefined();
  });

  it("persists rawJson as stringified Teams DTO on upsert", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const dto = makeTeamsMsg({
      id: "tmsg-raw",
      replyToId: "root-1",
      mentions: [
        {
          id: 0,
          mentionText: "Alice",
          mentioned: {
            user: {
              id: "u-a",
              displayName: "Alice",
              userPrincipalName: "alice@example.invalid",
            },
          },
        },
      ],
    });
    const teams = new FakeTeamsClient({
      steps: [
        { kind: "listChatsOk", response: chatsPage([chat("chat-1")]) },
        { kind: "getChatMessagesOk", response: msgsPage([dto]) },
      ],
    });
    const auth = authWithToken();
    await syncTeams({ account, auth, teams, store, clock });
    const upserted = store.calls
      .flatMap((c) => (c.method === "upsertMessages" ? c.messages : []))
      .find((m) => m.nativeId === "tmsg-raw");
    expect(upserted?.rawJson).toBe(JSON.stringify(dto));
  });

  it("skips @removed entries (no upsert, cursor unaffected by tombstone)", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        { kind: "listChatsOk", response: chatsPage([chat("chat-1")]) },
        {
          kind: "getChatMessagesOk",
          response: msgsPage([
            {
              id: "gone",
              createdDateTime: "2026-04-12T09:00:00Z",
              messageType: "message",
              "@removed": { reason: "deleted" },
            },
          ]),
        },
      ],
    });
    const auth = authWithToken();
    await syncTeams({ account, auth, teams, store, clock });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted).toHaveLength(0);
  });
});
