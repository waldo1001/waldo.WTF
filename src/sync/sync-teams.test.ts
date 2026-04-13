import { describe, it, expect } from "vitest";
import { syncTeams, DEFAULT_TEAMS_DELTA_ENDPOINT } from "./sync-teams.js";
import { FakeAuthClient } from "../testing/fake-auth-client.js";
import { FakeTeamsClient } from "../testing/fake-teams-client.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { FakeClock } from "../testing/fake-clock.js";
import type { Account, AccessToken } from "../auth/types.js";
import {
  DeltaTokenInvalidError,
  TokenExpiredError,
  type TeamsDeltaResponse,
  type TeamsMessage,
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

const okResponse = (r: Partial<TeamsDeltaResponse>): TeamsDeltaResponse => ({
  value: [],
  ...r,
});

describe("syncTeams", () => {
  it("first run uses default endpoint, upserts one message with teams id prefix + source, stores deltaLink", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [makeTeamsMsg()],
            "@odata.deltaLink": "https://graph/teams/delta?token=d1",
          }),
        },
      ],
    });
    const auth = authWithToken();

    const result = await syncTeams({ account, auth, teams, store, clock });
    expect(result).toEqual({ added: 1, removed: 0 });
    expect(teams.calls[0]?.url).toBe(DEFAULT_TEAMS_DELTA_ENDPOINT);
    const upserted = store.calls
      .flatMap((c) => (c.method === "upsertMessages" ? c.messages : []))
      .find((m) => m.nativeId === "tmsg-1");
    expect(upserted?.source).toBe("teams");
    expect(upserted?.id).toBe(`teams:${account.username}:tmsg-1`);
    expect(upserted?.threadId).toBe("chat-1");
    expect(upserted?.senderName).toBe("Alice");
    expect(upserted?.senderEmail).toBe("alice@example.invalid");
    expect(upserted?.body).toBe("hi");

    const state = await store.getSyncState(account.username, "teams");
    expect(state?.deltaToken).toBe("https://graph/teams/delta?token=d1");
  });

  it("subsequent run starts from stored deltaToken", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        syncState: [
          {
            account: account.username,
            source: "teams",
            deltaToken: "https://graph/teams/delta?token=prev",
          },
        ],
      },
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [],
            "@odata.deltaLink": "https://graph/teams/delta?token=next",
          }),
        },
      ],
    });
    const auth = authWithToken();

    await syncTeams({ account, auth, teams, store, clock });
    expect(teams.calls[0]?.url).toBe("https://graph/teams/delta?token=prev");
  });

  it("follows @odata.nextLink across pages", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [makeTeamsMsg({ id: "a" })],
            "@odata.nextLink": "https://graph/teams?skip=1",
          }),
        },
        {
          kind: "ok",
          response: okResponse({
            value: [makeTeamsMsg({ id: "b" })],
            "@odata.deltaLink": "https://graph/teams?token=final",
          }),
        },
      ],
    });
    const auth = authWithToken();
    const result = await syncTeams({ account, auth, teams, store, clock });
    expect(result.added).toBe(2);
    expect(teams.calls).toHaveLength(2);
    expect(teams.calls[1]?.url).toBe("https://graph/teams?skip=1");
  });

  it("routes @removed messages to deleteMessages with the teams id prefix", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [
              {
                id: "to-remove",
                createdDateTime: "2026-04-13T10:00:00Z",
                "@removed": { reason: "deleted" },
              },
            ],
            "@odata.deltaLink": "d",
          }),
        },
      ],
    });
    const auth = authWithToken();
    const result = await syncTeams({ account, auth, teams, store, clock });
    expect(result.removed).toBe(0); // empty store, nothing to delete
    const delCall = store.calls.find((c) => c.method === "deleteMessages");
    expect(delCall).toBeDefined();
    if (delCall && delCall.method === "deleteMessages") {
      expect(delCall.ids).toEqual([`teams:${account.username}:to-remove`]);
    }
  });

  it("maps text + html body, channelIdentity → chatType=channel, replyToId, mentions", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [
              makeTeamsMsg({
                id: "plain-text",
                body: { contentType: "text", content: "plain" },
              }),
              makeTeamsMsg({
                id: "rich",
                body: { contentType: "html", content: "<p>rich</p>" },
              }),
              makeTeamsMsg({
                id: "in-channel",
                channelIdentity: { teamId: "team-1", channelId: "chan-1" },
              }),
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
                  {
                    id: 1,
                    mentionText: "@nameless",
                  },
                  {
                    id: 2,
                    mentioned: {
                      user: {
                        id: "u-3",
                        displayName: "Carol",
                      },
                    },
                  },
                  {
                    id: 3,
                    mentioned: { user: { id: "u-4" } },
                  },
                ],
              }),
            ],
            "@odata.deltaLink": "d",
          }),
        },
      ],
    });
    const auth = authWithToken();
    await syncTeams({ account, auth, teams, store, clock });
    const msgs = store.calls
      .flatMap((c) => (c.method === "upsertMessages" ? c.messages : []));
    const plain = msgs.find((m) => m.nativeId === "plain-text");
    const rich = msgs.find((m) => m.nativeId === "rich");
    const chan = msgs.find((m) => m.nativeId === "in-channel");
    const reply = msgs.find((m) => m.nativeId === "reply");

    expect(plain?.body).toBe("plain");
    expect(plain?.bodyHtml).toBeUndefined();
    expect(rich?.bodyHtml).toBe("<p>rich</p>");
    expect(rich?.body).toBeUndefined();
    expect(chan?.chatType).toBe("channel");
    expect(reply?.replyToId).toBe("root");
    expect(reply?.mentions).toEqual([
      "bob@example.invalid",
      "@nameless",
      "Carol",
    ]);
  });

  it("propagates TokenExpiredError without updating syncState", async () => {
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

  it("propagates DeltaTokenInvalidError leaving stored deltaToken intact", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        syncState: [
          {
            account: account.username,
            source: "teams",
            deltaToken: "https://graph/teams/delta?token=stale",
          },
        ],
      },
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const teams = new FakeTeamsClient({
      steps: [{ kind: "error", error: new DeltaTokenInvalidError("410") }],
    });
    const auth = authWithToken();
    await expect(
      syncTeams({ account, auth, teams, store, clock }),
    ).rejects.toBeInstanceOf(DeltaTokenInvalidError);
    const state = await store.getSyncState(account.username, "teams");
    expect(state?.deltaToken).toBe("https://graph/teams/delta?token=stale");
  });
});
