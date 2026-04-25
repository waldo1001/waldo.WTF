import { describe, expect, it } from "vitest";
import { syncTeamsChannels } from "./sync-teams-channels.js";
import { teamsAuthorityFor } from "../auth/msal-auth-client.js";
import { FakeAuthClient } from "../testing/fake-auth-client.js";
import { FakeTeamsChannelClient } from "../testing/fake-teams-channel-client.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { InMemoryTeamsChannelSubscriptionStore } from "../testing/in-memory-teams-channel-subscription-store.js";
import { FakeClock } from "../testing/fake-clock.js";
import {
  GraphRateLimitedError,
  TokenExpiredError,
  type TeamsChannelMessage,
  type TeamsChannelMessagesPage,
} from "../sources/teams-channel.js";
import { AuthError, type AccessToken, type Account } from "../auth/types.js";

const account: Account = {
  username: "alice@example.invalid",
  homeAccountId: "home-alice",
  tenantId: "tenant-alice",
};

const TOKEN = "tch-tok";

function singleTenantAuth(token: string = TOKEN): FakeAuthClient {
  return new FakeAuthClient({
    accounts: [account],
    tokens: new Map<string, AccessToken | Error>([
      [
        `${account.homeAccountId}|${teamsAuthorityFor(account.tenantId)}`,
        {
          token,
          expiresOn: new Date("2026-04-30"),
          account,
        },
      ],
    ]),
  });
}

interface MakeMsgOverrides {
  id?: string;
  createdDateTime?: string;
  replyToId?: string | null;
  messageType?: string;
  removed?: boolean;
  body?: TeamsChannelMessage["body"];
  from?: TeamsChannelMessage["from"];
  mentions?: TeamsChannelMessage["mentions"];
  replies?: readonly TeamsChannelMessage[];
  repliesTotal?: number;
}

const makeMsg = (overrides: MakeMsgOverrides = {}): TeamsChannelMessage => {
  const base: Record<string, unknown> = {
    id: overrides.id ?? "m-1",
    createdDateTime: overrides.createdDateTime ?? "2026-04-21T08:00:00Z",
    messageType: overrides.messageType ?? "message",
    from: overrides.from ?? {
      user: {
        id: "u-1",
        displayName: "Alice",
        userPrincipalName: "alice@example.invalid",
      },
    },
    body: overrides.body ?? { contentType: "text", content: "hello" },
  };
  if (overrides.replyToId !== undefined) base.replyToId = overrides.replyToId;
  if (overrides.removed === true) base["@removed"] = { reason: "deleted" };
  if (overrides.mentions !== undefined) base.mentions = overrides.mentions;
  if (overrides.replies !== undefined) base.replies = overrides.replies;
  if (overrides.repliesTotal !== undefined) {
    base["replies@odata.count"] = overrides.repliesTotal;
  }
  return base as TeamsChannelMessage;
};

const page = (
  value: readonly TeamsChannelMessage[],
  opts: { nextLink?: string; deltaLink?: string } = {},
): TeamsChannelMessagesPage => {
  const out: Record<string, unknown> = { value };
  if (opts.nextLink !== undefined) out["@odata.nextLink"] = opts.nextLink;
  if (opts.deltaLink !== undefined) out["@odata.deltaLink"] = opts.deltaLink;
  return out as TeamsChannelMessagesPage;
};

async function seedSub(
  subs: InMemoryTeamsChannelSubscriptionStore,
  overrides: {
    teamId?: string;
    teamName?: string;
    channelId?: string;
    channelName?: string;
  } = {},
): Promise<void> {
  await subs.subscribe({
    account: account.username,
    teamId: overrides.teamId ?? "team-1",
    ...(overrides.teamName !== undefined && { teamName: overrides.teamName }),
    channelId: overrides.channelId ?? "chan-1",
    ...(overrides.channelName !== undefined && {
      channelName: overrides.channelName,
    }),
  });
}

describe("syncTeamsChannels", () => {
  it("first run without cursor bootstraps with sinceIso window", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const now = new Date("2026-04-21T12:00:00Z");
    const clock = new FakeClock(now);
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([], { deltaLink: "delta-1" }),
        },
      ],
    });

    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
      backfillDays: 30,
    });

    const call = client.calls.find(
      (c) => c.method === "getChannelMessagesDelta",
    );
    expect(call).toBeDefined();
    const expectedSince = new Date(
      now.getTime() - 30 * 86_400_000,
    ).toISOString();
    expect(
      (call as Extract<typeof call, { method: "getChannelMessagesDelta" }>)
        ?.sinceIso,
    ).toBe(expectedSince);
  });

  it("subsequent run passes the persisted deltaLink", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    await store.setChatCursor({
      account: account.username,
      chatId: "channel:team-1:chan-1",
      cursor: "delta-prev",
    });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([], { deltaLink: "delta-next" }),
        },
      ],
    });
    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    const call = client.calls.find(
      (c) => c.method === "getChannelMessagesDelta",
    );
    expect(
      (call as Extract<typeof call, { method: "getChannelMessagesDelta" }>)
        ?.deltaLink,
    ).toBe("delta-prev");
    expect(
      (call as Extract<typeof call, { method: "getChannelMessagesDelta" }>)
        ?.sinceIso,
    ).toBeUndefined();
  });

  it("drains all nextLink pages and persists only the final deltaLink", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([makeMsg({ id: "m-1" })], { nextLink: "next-1" }),
        },
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([makeMsg({ id: "m-2" })], { nextLink: "next-2" }),
        },
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([makeMsg({ id: "m-3" })], { deltaLink: "delta-final" }),
        },
      ],
    });
    const res = await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    expect(res.added).toBe(3);

    const setCursorCalls = store.calls.filter(
      (c) => c.method === "setChatCursor",
    );
    expect(setCursorCalls).toHaveLength(1);
    expect(
      (setCursorCalls[0] as Extract<(typeof setCursorCalls)[number], { method: "setChatCursor" }>)
        .entry,
    ).toEqual({
      account: account.username,
      chatId: "channel:team-1:chan-1",
      cursor: "delta-final",
    });
  });

  it("expands replies into individual Message rows", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const root = makeMsg({
      id: "root-1",
      replyToId: null,
      replies: [
        makeMsg({ id: "rep-1", replyToId: "root-1" }),
        makeMsg({ id: "rep-2", replyToId: "root-1" }),
      ],
    });
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([root], { deltaLink: "d" }),
        },
      ],
    });
    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted.map((m) => m.nativeId).sort()).toEqual([
      "rep-1",
      "rep-2",
      "root-1",
    ]);
    const rep1 = upserted.find((m) => m.nativeId === "rep-1");
    expect(rep1?.replyToId).toBe(
      `teams-channel:${account.username}:team-1:chan-1:root-1`,
    );
    const rootRow = upserted.find((m) => m.nativeId === "root-1");
    expect(rootRow?.replyToId).toBeUndefined();
  });

  it("top-level post with no replies produces one row", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([makeMsg({ id: "solo" })], { deltaLink: "d" }),
        },
      ],
    });
    const res = await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    expect(res.added).toBe(1);
  });

  it("skips @removed entries (root and reply)", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const root = makeMsg({
      id: "root-1",
      replyToId: null,
      replies: [
        makeMsg({ id: "rep-keep", replyToId: "root-1" }),
        makeMsg({ id: "rep-gone", replyToId: "root-1", removed: true }),
      ],
    });
    const removedRoot = makeMsg({ id: "ghost", removed: true });
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([root, removedRoot], { deltaLink: "d" }),
        },
      ],
    });
    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted.map((m) => m.nativeId).sort()).toEqual([
      "rep-keep",
      "root-1",
    ]);
  });

  it("skips systemEventMessage rows", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page(
            [
              makeMsg({ id: "real" }),
              makeMsg({ id: "sys", messageType: "systemEventMessage" }),
            ],
            { deltaLink: "d" },
          ),
        },
      ],
    });
    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted.map((m) => m.nativeId)).toEqual(["real"]);
  });

  it("threadId uses the root post id, not the channel id", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const root = makeMsg({
      id: "root-x",
      replyToId: null,
      replies: [makeMsg({ id: "rep-y", replyToId: "root-x" })],
    });
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([root], { deltaLink: "d" }),
        },
      ],
    });
    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    const r = upserted.find((m) => m.nativeId === "root-x");
    const c = upserted.find((m) => m.nativeId === "rep-y");
    expect(r?.threadId).toBe("teams-channel:team-1:chan-1:root-x");
    expect(c?.threadId).toBe("teams-channel:team-1:chan-1:root-x");
  });

  it("threadName includes team and channel names", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs, { teamName: "Contoso R&D", channelName: "Announcements" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const root = makeMsg({
      id: "root-1",
      body: { contentType: "text", content: "hello world from the team" },
      replies: [makeMsg({ id: "rep-1", replyToId: "root-1" })],
    });
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([root], { deltaLink: "d" }),
        },
      ],
    });
    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    const rootRow = upserted.find((m) => m.nativeId === "root-1");
    const rep = upserted.find((m) => m.nativeId === "rep-1");
    expect(rootRow?.threadName).toBe(
      "Contoso R&D / Announcements / hello world from the team",
    );
    expect(rep?.threadName).toBe(rootRow?.threadName);
  });

  it("every row has chatType='channel' and source='teams-channel'", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page(
            [
              makeMsg({
                id: "r",
                replies: [makeMsg({ id: "c", replyToId: "r" })],
              }),
            ],
            { deltaLink: "d" },
          ),
        },
      ],
    });
    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted).toHaveLength(2);
    for (const m of upserted) {
      expect(m.chatType).toBe("channel");
      expect(m.source).toBe("teams-channel");
      expect(m.account).toBe(account.username);
      expect(m.id.startsWith("teams-channel:")).toBe(true);
    }
  });

  it("extracts mentions into the mentions array", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page(
            [
              makeMsg({
                id: "m1",
                mentions: [
                  {
                    id: 0,
                    mentionText: "Alice",
                    mentioned: {
                      user: {
                        displayName: "Alice",
                        userPrincipalName: "alice@example.invalid",
                      },
                    },
                  },
                  {
                    id: 1,
                    mentionText: "@team",
                    mentioned: {},
                  },
                ],
              }),
            ],
            { deltaLink: "d" },
          ),
        },
      ],
    });
    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted[0]?.mentions).toEqual([
      "alice@example.invalid",
      "@team",
    ]);
  });

  it("preserves raw Graph payload as rawJson", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const msg = makeMsg({ id: "m1" });
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([msg], { deltaLink: "d" }),
        },
      ],
    });
    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted[0]?.rawJson).toBe(JSON.stringify(msg));
  });

  it("importedAt is set from injected clock", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const now = new Date("2026-04-22T03:14:15Z");
    const clock = new FakeClock(now);
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([makeMsg({ id: "m1" })], { deltaLink: "d" }),
        },
      ],
    });
    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted[0]?.importedAt.toISOString()).toBe(now.toISOString());
  });

  it("writes deltaLink to chat_cursors with channel:<teamId>:<channelId> key", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs, { teamId: "T-99", channelId: "C-77" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([], { deltaLink: "d-final" }),
        },
      ],
    });
    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    const cur = await store.getChatCursor(account.username, "channel:T-99:C-77");
    expect(cur).toBe("d-final");
  });

  it("does not advance chat_cursors on mid-drain error", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    await store.setChatCursor({
      account: account.username,
      chatId: "channel:team-1:chan-1",
      cursor: "old-delta",
    });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([makeMsg({ id: "m1" })], { nextLink: "next-1" }),
        },
        { kind: "error", error: new Error("network blip") },
      ],
    });
    const res = await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    expect(res.perSubscription[0]?.error).toBeDefined();
    const cur = await store.getChatCursor(
      account.username,
      "channel:team-1:chan-1",
    );
    expect(cur).toBe("old-delta");
  });

  it("updates TeamsChannelSubscriptionStore.lastCursorAt on success", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const now = new Date("2026-04-22T15:00:00Z");
    const clock = new FakeClock(now);
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([], { deltaLink: "d" }),
        },
      ],
    });
    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    const after = await subs.listForAccount(account.username);
    expect(after[0]?.lastCursorAt?.toISOString()).toBe(now.toISOString());
  });

  it("propagates TokenExpiredError from the delta call", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({
      steps: [{ kind: "error", error: new TokenExpiredError("401") }],
    });
    await expect(
      syncTeamsChannels({
        account,
        auth: singleTenantAuth(),
        client,
        store,
        subs,
        clock,
      }),
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("propagates GraphRateLimitedError", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({
      steps: [{ kind: "error", error: new GraphRateLimitedError(11) }],
    });
    await expect(
      syncTeamsChannels({
        account,
        auth: singleTenantAuth(),
        client,
        store,
        subs,
        clock,
      }),
    ).rejects.toBeInstanceOf(GraphRateLimitedError);
  });

  it("soft errors on one subscription do not block others", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs, { channelId: "chan-bad" });
    await seedSub(subs, { channelId: "chan-good" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({
      steps: [
        { kind: "error", error: new Error("boom") },
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([makeMsg({ id: "m-good" })], { deltaLink: "d" }),
        },
      ],
    });
    const res = await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    const bad = res.perSubscription.find((p) => p.channelId === "chan-bad");
    const good = res.perSubscription.find((p) => p.channelId === "chan-good");
    expect(bad?.error).toContain("boom");
    expect(bad?.added).toBe(0);
    expect(good?.added).toBe(1);
    expect(good?.error).toBeUndefined();
    expect(res.added).toBe(1);
  });

  it("logs teams_channel_reply_clipped when replies array is truncated", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const root = makeMsg({
      id: "root-clip",
      replies: [
        makeMsg({ id: "r1", replyToId: "root-clip" }),
        makeMsg({ id: "r2", replyToId: "root-clip" }),
      ],
      repliesTotal: 50,
    });
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([root], { deltaLink: "d" }),
        },
      ],
    });
    const lines: string[] = [];
    const logger = {
      info: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
    };
    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
      logger,
    });
    expect(
      lines.some((l) =>
        l.includes("teams_channel_reply_clipped") &&
        l.includes("rootMessageId=root-clip") &&
        l.includes("returned=2") &&
        l.includes("total=50"),
      ),
    ).toBe(true);
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted.map((m) => m.nativeId).sort()).toEqual([
      "r1",
      "r2",
      "root-clip",
    ]);
  });

  it("no-op when account has zero enabled subscriptions", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({ steps: [] });
    const res = await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    expect(res).toEqual({ added: 0, removed: 0, perSubscription: [] });
    expect(client.calls).toEqual([]);
  });

  it("disabled subscriptions are skipped", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await seedSub(subs, { channelId: "chan-1" });
    await seedSub(subs, { channelId: "chan-2" });
    await subs.toggleEnabled(account.username, "team-1", "chan-2", false);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([], { deltaLink: "d" }),
        },
      ],
    });
    await syncTeamsChannels({
      account,
      auth: singleTenantAuth(),
      client,
      store,
      subs,
      clock,
    });
    expect(
      client.calls.filter((c) => c.method === "getChannelMessagesDelta"),
    ).toHaveLength(1);
  });

  it("syncTeamsChannels fans out across tenants and isolates per-tenant token failures", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    await subs.subscribe({
      account: account.username,
      tenantId: "tenant-A",
      teamId: "team-A1",
      channelId: "chan-A1",
    });
    await subs.subscribe({
      account: account.username,
      tenantId: "tenant-A",
      teamId: "team-A2",
      channelId: "chan-A2",
    });
    await subs.subscribe({
      account: account.username,
      tenantId: "tenant-B",
      teamId: "team-B1",
      channelId: "chan-B1",
    });

    const consentError = new AuthError(
      "silent-failed",
      "MSAL silent token acquisition failed",
      { cause: new Error("AADSTS65001: consent required") },
    );
    const auth = new FakeAuthClient({
      accounts: [account],
      tokens: new Map<string, AccessToken | Error>([
        [
          `${account.homeAccountId}|${teamsAuthorityFor("tenant-A")}`,
          {
            token: "tok-A",
            expiresOn: new Date("2026-04-30"),
            account,
          },
        ],
        [
          `${account.homeAccountId}|${teamsAuthorityFor("tenant-B")}`,
          consentError,
        ],
      ]),
    });

    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([], { deltaLink: "d-A1" }),
        },
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([], { deltaLink: "d-A2" }),
        },
      ],
    });

    const result = await syncTeamsChannels({
      account,
      auth,
      client,
      store,
      subs,
      clock,
    });

    const silent = auth.calls.filter((c) => c.method === "getTokenSilent");
    const authorities = new Set(
      silent
        .map(
          (c) =>
            (c as Extract<typeof silent[number], { method: "getTokenSilent" }>)
              .authority,
        )
        .filter((a): a is string => a !== undefined),
    );
    expect(authorities).toEqual(
      new Set([
        teamsAuthorityFor("tenant-A"),
        teamsAuthorityFor("tenant-B"),
      ]),
    );

    const successSubs = result.perSubscription.filter(
      (p) => p.error === undefined,
    );
    expect(successSubs.map((s) => s.channelId).sort()).toEqual([
      "chan-A1",
      "chan-A2",
    ]);
    const failed = result.perSubscription.filter(
      (p) => p.error !== undefined,
    );
    expect(failed.map((s) => s.channelId)).toEqual(["chan-B1"]);
  });

  it("syncTeamsChannels falls back to account.tenantId when subscription tenantId is missing", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryTeamsChannelSubscriptionStore();
    // legacy subscription — no tenantId set
    await subs.subscribe({
      account: account.username,
      teamId: "team-legacy",
      channelId: "chan-legacy",
    });

    const auth = new FakeAuthClient({
      accounts: [account],
      tokens: new Map<string, AccessToken | Error>([
        [
          `${account.homeAccountId}|${teamsAuthorityFor(account.tenantId)}`,
          {
            token: "tok-home",
            expiresOn: new Date("2026-04-30"),
            account,
          },
        ],
      ]),
    });

    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const client = new FakeTeamsChannelClient({
      steps: [
        {
          kind: "getChannelMessagesDeltaOk",
          response: page([], { deltaLink: "d-legacy" }),
        },
      ],
    });

    await syncTeamsChannels({
      account,
      auth,
      client,
      store,
      subs,
      clock,
    });

    const silent = auth.calls.filter((c) => c.method === "getTokenSilent");
    const call = silent[0] as Extract<
      typeof silent[number],
      { method: "getTokenSilent" }
    >;
    expect(call.authority).toBe(teamsAuthorityFor(account.tenantId));
  });
});
