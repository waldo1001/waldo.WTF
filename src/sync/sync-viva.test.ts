import { describe, expect, it } from "vitest";
import { syncViva } from "./sync-viva.js";
import { FakeAuthClient } from "../testing/fake-auth-client.js";
import { FakeVivaClient } from "../testing/fake-viva-client.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { InMemoryVivaSubscriptionStore } from "../testing/in-memory-viva-subscription-store.js";
import { FakeClock } from "../testing/fake-clock.js";
import type { Account, AccessToken } from "../auth/types.js";
import {
  GraphRateLimitedError,
  TokenExpiredError,
  type VivaCommunityListPage,
  type VivaPost,
  type VivaPostPage,
  type VivaThread,
  type VivaThreadPage,
} from "../sources/viva.js";

const account: Account = {
  username: "alice@example.invalid",
  homeAccountId: "home-alice",
  tenantId: "tenant-alice",
};

const accessToken: AccessToken = {
  token: "viva-tok",
  expiresOn: new Date("2026-04-21T13:00:00Z"),
  account,
};

const authWithToken = () =>
  new FakeAuthClient({
    accounts: [account],
    tokens: new Map([[account.homeAccountId, accessToken]]),
  });

const thread = (
  id: string,
  overrides: Partial<VivaThread> = {},
): VivaThread => ({
  id,
  topic: "release plans",
  lastPostedDateTime: "2026-04-21T08:00:00Z",
  ...overrides,
});

const threadsPage = (
  value: VivaThread[],
  nextLink?: string,
): VivaThreadPage =>
  nextLink !== undefined ? { value, "@odata.nextLink": nextLink } : { value };

const postsPage = (value: VivaPost[], nextLink?: string): VivaPostPage =>
  nextLink !== undefined ? { value, "@odata.nextLink": nextLink } : { value };

const makePost = (overrides: Partial<VivaPost> = {}): VivaPost => ({
  id: "p-1",
  conversationId: "thr-1",
  createdDateTime: "2026-04-21T08:00:00Z",
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

async function seedSub(
  subs: InMemoryVivaSubscriptionStore,
  overrides: {
    networkId?: string;
    networkName?: string;
    communityId?: string;
    communityName?: string;
  } = {},
): Promise<void> {
  await subs.subscribe({
    account: account.username,
    networkId: overrides.networkId ?? "net-1",
    ...(overrides.networkName !== undefined && {
      networkName: overrides.networkName,
    }),
    communityId: overrides.communityId ?? "com-1",
    ...(overrides.communityName !== undefined && {
      communityName: overrides.communityName,
    }),
  });
}

describe("syncViva", () => {
  it("fetches threads + posts for each enabled subscription and upserts messages", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1", communityName: "Eng" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        { kind: "listThreadsOk", response: threadsPage([thread("thr-1")]) },
        {
          kind: "listPostsOk",
          response: postsPage([
            makePost({ id: "p-1", conversationId: "thr-1" }),
            makePost({
              id: "p-2",
              conversationId: "thr-1",
              createdDateTime: "2026-04-21T09:00:00Z",
            }),
          ]),
        },
      ],
    });
    const auth = authWithToken();

    const res = await syncViva({ account, auth, viva, store, subs, clock });
    expect(res.added).toBe(2);
    expect(res.removed).toBe(0);
    expect(res.perCommunity).toEqual([{ communityId: "com-1", added: 2 }]);

    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted.map((m) => m.nativeId).sort()).toEqual(["p-1", "p-2"]);
    expect(upserted[0]?.source).toBe("viva-engage");
    expect(upserted[0]?.id).toBe(`viva-engage:${account.username}:p-1`);
    expect(upserted[0]?.threadId).toBe("viva:net-1:com-1:thr-1");
    expect(upserted[0]?.threadName).toBe("Eng / release plans");
    expect(upserted[0]?.chatType).toBe("group");
  });

  it("skips subscriptions that are disabled", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    await seedSub(subs, { communityId: "com-2" });
    await subs.toggleEnabled(account.username, "com-2", false);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        { kind: "listThreadsOk", response: threadsPage([]) },
      ],
    });
    const auth = authWithToken();

    const res = await syncViva({ account, auth, viva, store, subs, clock });
    expect(res.perCommunity.map((p) => p.communityId)).toEqual(["com-1"]);
    expect(viva.calls.filter((c) => c.method === "listThreads")).toHaveLength(
      1,
    );
  });

  it("uses lastCursorAt as sinceIso on subsequent runs", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    await subs.setCursor(
      account.username,
      "com-1",
      new Date("2026-04-21T07:00:00Z"),
    );
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        { kind: "listThreadsOk", response: threadsPage([]) },
      ],
    });
    const auth = authWithToken();
    await syncViva({ account, auth, viva, store, subs, clock });
    const call = viva.calls.find((c) => c.method === "listThreads");
    expect(call).toMatchObject({
      method: "listThreads",
      communityId: "com-1",
      sinceIso: "2026-04-21T07:00:00.000Z",
    });
  });

  it("advances lastCursorAt to the newest post sentAt only after success", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        { kind: "listThreadsOk", response: threadsPage([thread("thr-1")]) },
        {
          kind: "listPostsOk",
          response: postsPage([
            makePost({
              id: "p-1",
              conversationId: "thr-1",
              createdDateTime: "2026-04-21T08:00:00Z",
            }),
            makePost({
              id: "p-2",
              conversationId: "thr-1",
              createdDateTime: "2026-04-21T09:30:00Z",
            }),
          ]),
        },
      ],
    });
    const auth = authWithToken();
    await syncViva({ account, auth, viva, store, subs, clock });
    const after = await subs.listForAccount(account.username);
    expect(after[0]?.lastCursorAt?.toISOString()).toBe(
      "2026-04-21T09:30:00.000Z",
    );
  });

  it("does not advance cursor when listPosts errors for a community (per-community isolation)", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    await seedSub(subs, { communityId: "com-2" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        // com-1: listThreads ok, listPosts errors with non-hard-stop
        { kind: "listThreadsOk", response: threadsPage([thread("thr-1")]) },
        { kind: "error", error: new Error("boom") },
        // com-2: succeeds
        { kind: "listThreadsOk", response: threadsPage([thread("thr-2")]) },
        {
          kind: "listPostsOk",
          response: postsPage([
            makePost({
              id: "p-2",
              conversationId: "thr-2",
              createdDateTime: "2026-04-21T10:00:00Z",
            }),
          ]),
        },
      ],
    });
    const auth = authWithToken();
    const res = await syncViva({ account, auth, viva, store, subs, clock });
    expect(res.added).toBe(1);
    expect(
      res.perCommunity.find((p) => p.communityId === "com-1")?.error,
    ).toBeDefined();
    expect(
      res.perCommunity.find((p) => p.communityId === "com-2"),
    ).toEqual({ communityId: "com-2", added: 1 });

    const subsAfter = await subs.listForAccount(account.username);
    const com1 = subsAfter.find((s) => s.communityId === "com-1");
    const com2 = subsAfter.find((s) => s.communityId === "com-2");
    expect(com1?.lastCursorAt).toBeUndefined();
    expect(com2?.lastCursorAt?.toISOString()).toBe(
      "2026-04-21T10:00:00.000Z",
    );
  });

  it("rethrows TokenExpiredError without mutating sync state", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [{ kind: "error", error: new TokenExpiredError("401") }],
    });
    const auth = authWithToken();
    await expect(
      syncViva({ account, auth, viva, store, subs, clock }),
    ).rejects.toBeInstanceOf(TokenExpiredError);
    const setSync = store.calls.filter((c) => c.method === "setSyncState");
    expect(setSync).toHaveLength(0);
  });

  it("rethrows GraphRateLimitedError without mutating sync state", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [{ kind: "error", error: new GraphRateLimitedError(7) }],
    });
    const auth = authWithToken();
    await expect(
      syncViva({ account, auth, viva, store, subs, clock }),
    ).rejects.toBeInstanceOf(GraphRateLimitedError);
  });

  it("follows @odata.nextLink across both threads and posts pagination", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        {
          kind: "listThreadsOk",
          response: threadsPage(
            [thread("thr-1")],
            "https://graph/threads?skip=1",
          ),
        },
        { kind: "listThreadsOk", response: threadsPage([thread("thr-2")]) },
        {
          kind: "listPostsOk",
          response: postsPage(
            [makePost({ id: "p1", conversationId: "thr-1" })],
            "https://graph/posts?skip=1",
          ),
        },
        {
          kind: "listPostsOk",
          response: postsPage([makePost({ id: "p2", conversationId: "thr-1" })]),
        },
        {
          kind: "listPostsOk",
          response: postsPage([makePost({ id: "p3", conversationId: "thr-2" })]),
        },
      ],
    });
    const auth = authWithToken();
    const res = await syncViva({ account, auth, viva, store, subs, clock });
    expect(res.added).toBe(3);
    expect(viva.calls.filter((c) => c.method === "listThreads")).toHaveLength(
      2,
    );
    expect(viva.calls.filter((c) => c.method === "listPosts")).toHaveLength(3);
  });

  it("threads from different communities never share thread_id (community in key)", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-A", networkId: "net-1" });
    await seedSub(subs, { communityId: "com-B", networkId: "net-1" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        { kind: "listThreadsOk", response: threadsPage([thread("shared")]) },
        {
          kind: "listPostsOk",
          response: postsPage([
            makePost({ id: "pA", conversationId: "shared" }),
          ]),
        },
        { kind: "listThreadsOk", response: threadsPage([thread("shared")]) },
        {
          kind: "listPostsOk",
          response: postsPage([
            makePost({ id: "pB", conversationId: "shared" }),
          ]),
        },
      ],
    });
    const auth = authWithToken();
    await syncViva({ account, auth, viva, store, subs, clock });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    const pA = upserted.find((m) => m.nativeId === "pA");
    const pB = upserted.find((m) => m.nativeId === "pB");
    expect(pA?.threadId).toBe("viva:net-1:com-A:shared");
    expect(pB?.threadId).toBe("viva:net-1:com-B:shared");
  });

  it("maps text + html body and senderEmail correctly", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        { kind: "listThreadsOk", response: threadsPage([thread("thr-1")]) },
        {
          kind: "listPostsOk",
          response: postsPage([
            makePost({
              id: "plain",
              body: { contentType: "text", content: "plain" },
            }),
            makePost({
              id: "rich",
              body: { contentType: "html", content: "<p>rich</p>" },
            }),
          ]),
        },
      ],
    });
    const auth = authWithToken();
    await syncViva({ account, auth, viva, store, subs, clock });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    const p1 = upserted.find((m) => m.nativeId === "plain");
    const p2 = upserted.find((m) => m.nativeId === "rich");
    expect(p1?.body).toBe("plain");
    expect(p1?.bodyHtml).toBeUndefined();
    expect(p2?.bodyHtml).toBe("<p>rich</p>");
    expect(p2?.body).toBeUndefined();
    expect(p1?.senderEmail).toBe("alice@example.invalid");
    expect(p1?.senderName).toBe("Alice");
  });

  it("sets sync state with lastSyncAt on success", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    const now = new Date("2026-04-21T12:00:00Z");
    const clock = new FakeClock(now);
    const viva = new FakeVivaClient({
      steps: [{ kind: "listThreadsOk", response: threadsPage([]) }],
    });
    const auth = authWithToken();
    await syncViva({ account, auth, viva, store, subs, clock });
    const setSync = store.calls.find((c) => c.method === "setSyncState");
    expect(setSync).toEqual({
      method: "setSyncState",
      entry: {
        account: account.username,
        source: "viva-engage",
        lastSyncAt: now,
      },
    });
  });

  it("returns added=0 and an empty perCommunity when account has no subscriptions", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({ steps: [] });
    const auth = authWithToken();
    const res = await syncViva({ account, auth, viva, store, subs, clock });
    expect(res).toEqual({ added: 0, removed: 0, perCommunity: [] });
    expect(viva.calls).toEqual([]);
  });

  it("threadName falls back to community-only when topic is null", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1", communityName: "Eng" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        {
          kind: "listThreadsOk",
          response: threadsPage([thread("thr-1", { topic: null })]),
        },
        {
          kind: "listPostsOk",
          response: postsPage([makePost({ id: "p-1" })]),
        },
      ],
    });
    const auth = authWithToken();
    await syncViva({ account, auth, viva, store, subs, clock });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted[0]?.threadName).toBe("Eng");
  });

  it("threadName is omitted when neither community name nor topic is present", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        {
          kind: "listThreadsOk",
          response: threadsPage([thread("thr-1", { topic: null })]),
        },
        {
          kind: "listPostsOk",
          response: postsPage([makePost({ id: "p-1" })]),
        },
      ],
    });
    const auth = authWithToken();
    await syncViva({ account, auth, viva, store, subs, clock });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted[0]?.threadName).toBeUndefined();
  });

  it("threadName falls back to topic-only when community name absent", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        {
          kind: "listThreadsOk",
          response: threadsPage([thread("thr-1", { topic: "release plans" })]),
        },
        {
          kind: "listPostsOk",
          response: postsPage([makePost({ id: "p-1" })]),
        },
      ],
    });
    const auth = authWithToken();
    await syncViva({ account, auth, viva, store, subs, clock });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted[0]?.threadName).toBe("release plans");
  });

  it("does not regress cursor when newest post is older than stored cursor", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    const old = new Date("2026-04-21T11:00:00Z");
    await subs.setCursor(account.username, "com-1", old);
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        { kind: "listThreadsOk", response: threadsPage([thread("thr-1")]) },
        {
          kind: "listPostsOk",
          response: postsPage([
            makePost({
              id: "p-old",
              conversationId: "thr-1",
              createdDateTime: "2026-04-21T08:00:00Z",
            }),
          ]),
        },
      ],
    });
    const auth = authWithToken();
    await syncViva({ account, auth, viva, store, subs, clock });
    const after = await subs.listForAccount(account.username);
    expect(after[0]?.lastCursorAt?.toISOString()).toBe(old.toISOString());
  });

  it("truncates very long thread names to 200 chars", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, {
      communityId: "com-1",
      communityName: "C".repeat(150),
    });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        {
          kind: "listThreadsOk",
          response: threadsPage([thread("thr-1", { topic: "T".repeat(150) })]),
        },
        {
          kind: "listPostsOk",
          response: postsPage([makePost({ id: "p-1" })]),
        },
      ],
    });
    const auth = authWithToken();
    await syncViva({ account, auth, viva, store, subs, clock });
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted[0]?.threadName?.length).toBe(200);
  });
});
