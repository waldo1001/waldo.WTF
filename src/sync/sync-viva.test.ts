import { describe, expect, it } from "vitest";
import { syncViva } from "./sync-viva.js";
import { FakeAuthClient } from "../testing/fake-auth-client.js";
import { FakeVivaClient } from "../testing/fake-viva-client.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { InMemoryVivaSubscriptionStore } from "../testing/in-memory-viva-subscription-store.js";
import { FakeClock } from "../testing/fake-clock.js";
import type { Account, AccessToken } from "../auth/types.js";
import type { Message } from "../store/types.js";
import { vivaAuthorityFor, YAMMER_SCOPE } from "../auth/msal-auth-client.js";
import { AuthError } from "../auth/types.js";
import {
  GraphRateLimitedError,
  TokenExpiredError,
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
  olderThanCursor?: string,
): VivaThreadPage =>
  olderThanCursor !== undefined ? { value, olderThanCursor } : { value };

const postsPage = (value: VivaPost[], olderThanCursor?: string): VivaPostPage =>
  olderThanCursor !== undefined ? { value, olderThanCursor } : { value };

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

  it("calls listThreads for each subscribed community on every sync run", async () => {
    // Slice 3 will implement cursor-based walk (olderThan). For now the stub
    // fetches a single page unconditionally and lastCursorAt is not forwarded.
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
      steps: [{ kind: "listThreadsOk", response: threadsPage([]) }],
    });
    const auth = authWithToken();
    await syncViva({ account, auth, viva, store, subs, clock });
    const call = viva.calls.find((c) => c.method === "listThreads");
    expect(call).toMatchObject({ method: "listThreads", communityId: "com-1" });
  });

  it("isolates per-community errors so other communities still sync", async () => {
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

  it("fetches one page of threads and one page of posts per thread per community", async () => {
    // Slice 2 stub: single-page fetch only. Slice 3 adds olderThan cursor walk.
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        {
          kind: "listThreadsOk",
          response: threadsPage([thread("thr-1"), thread("thr-2")]),
        },
        {
          kind: "listPostsOk",
          response: postsPage([makePost({ id: "p1", conversationId: "thr-1" })]),
        },
        {
          kind: "listPostsOk",
          response: postsPage([makePost({ id: "p2", conversationId: "thr-2" })]),
        },
      ],
    });
    const auth = authWithToken();
    const res = await syncViva({ account, auth, viva, store, subs, clock });
    expect(res.added).toBe(2);
    expect(viva.calls.filter((c) => c.method === "listThreads")).toHaveLength(1);
    expect(viva.calls.filter((c) => c.method === "listPosts")).toHaveLength(2);
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

  it("syncViva acquires token with YAMMER_SCOPE so the Viva API call uses the correct audience", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs);
    const clock = new FakeClock(new Date("2026-04-22T10:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        { kind: "listThreadsOk", response: threadsPage([]) },
      ],
    });
    const auth = authWithToken();

    await syncViva({ account, auth, viva, store, subs, clock });

    const tokenCall = auth.calls.find((c) => c.method === "getTokenSilent");
    expect(tokenCall).toBeDefined();
    expect(
      (tokenCall as Extract<typeof tokenCall, { method: "getTokenSilent" }>)
        ?.scopes,
    ).toEqual([YAMMER_SCOPE]);
  });

  // ── Per-tenant authority: same root cause as discover, different seam. ──
  // /common resolves to the account's home IDP, minting a Yammer token scoped
  // to the home network only. Subs pointing at external networks need a
  // token minted against an authority = vivaAuthorityFor(sub.tenantId).

  it("syncViva requests token with explicit home-tenant authority", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await subs.subscribe({
      account: account.username,
      tenantId: account.tenantId,
      networkId: "net-1",
      communityId: "com-1",
    });
    const clock = new FakeClock(new Date("2026-04-22T10:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [{ kind: "listThreadsOk", response: threadsPage([]) }],
    });
    const homeAuthority = vivaAuthorityFor(account.tenantId);
    const auth = new FakeAuthClient({
      accounts: [account],
      tokens: new Map([
        [`${account.homeAccountId}|${homeAuthority}`, accessToken],
      ]),
    });

    await syncViva({ account, auth, viva, store, subs, clock });

    const tokenCalls = auth.calls.filter((c) => c.method === "getTokenSilent");
    expect(tokenCalls).toHaveLength(1);
    expect(
      (tokenCalls[0] as Extract<(typeof tokenCalls)[number], { method: "getTokenSilent" }>)
        .authority,
    ).toBe(homeAuthority);
  });

  it("syncViva acquires a separate token per subscription tenantId", async () => {
    const HOME_TENANT = account.tenantId;
    const EXT_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    const HOME_AUTHORITY = vivaAuthorityFor(HOME_TENANT);
    const EXT_AUTHORITY = vivaAuthorityFor(EXT_TENANT);

    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await subs.subscribe({
      account: account.username,
      tenantId: HOME_TENANT,
      networkId: "net-home",
      communityId: "com-home",
    });
    await subs.subscribe({
      account: account.username,
      tenantId: EXT_TENANT,
      networkId: "net-ext",
      communityId: "com-ext",
    });
    const clock = new FakeClock(new Date("2026-04-22T10:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        { kind: "listThreadsOk", response: threadsPage([]) },
        { kind: "listThreadsOk", response: threadsPage([]) },
      ],
    });
    const homeToken: AccessToken = {
      token: "home-tok",
      expiresOn: new Date("2026-04-22T13:00:00Z"),
      account,
    };
    const extToken: AccessToken = {
      token: "ext-tok",
      expiresOn: new Date("2026-04-22T13:00:00Z"),
      account,
    };
    const auth = new FakeAuthClient({
      accounts: [account],
      tokens: new Map([
        [`${account.homeAccountId}|${HOME_AUTHORITY}`, homeToken],
        [`${account.homeAccountId}|${EXT_AUTHORITY}`, extToken],
      ]),
    });

    await syncViva({ account, auth, viva, store, subs, clock });

    const tokenCalls = auth.calls.filter((c) => c.method === "getTokenSilent");
    const authorities = tokenCalls.map(
      (c) =>
        (c as Extract<(typeof tokenCalls)[number], { method: "getTokenSilent" }>)
          .authority,
    );
    expect(authorities.sort()).toEqual([HOME_AUTHORITY, EXT_AUTHORITY].sort());

    const listThreadsCalls = viva.calls.filter(
      (c) => c.method === "listThreads",
    );
    const tokenByCommunity = new Map<string, string>();
    for (const c of listThreadsCalls) {
      const lt = c as Extract<(typeof listThreadsCalls)[number], { method: "listThreads" }>;
      tokenByCommunity.set(lt.communityId, lt.token);
    }
    expect(tokenByCommunity.get("com-home")).toBe("home-tok");
    expect(tokenByCommunity.get("com-ext")).toBe("ext-tok");
  });

  it("syncViva falls back to account tenant when subscription tenantId is missing", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await subs.subscribe({
      account: account.username,
      // tenantId omitted — simulates pre-slice-4b-2 row
      networkId: "net-1",
      communityId: "com-1",
    });
    const clock = new FakeClock(new Date("2026-04-22T10:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [{ kind: "listThreadsOk", response: threadsPage([]) }],
    });
    const homeAuthority = vivaAuthorityFor(account.tenantId);
    const auth = new FakeAuthClient({
      accounts: [account],
      tokens: new Map([
        [`${account.homeAccountId}|${homeAuthority}`, accessToken],
      ]),
    });

    await syncViva({ account, auth, viva, store, subs, clock });

    const tokenCalls = auth.calls.filter((c) => c.method === "getTokenSilent");
    expect(tokenCalls).toHaveLength(1);
    expect(
      (tokenCalls[0] as Extract<(typeof tokenCalls)[number], { method: "getTokenSilent" }>)
        .authority,
    ).toBe(homeAuthority);
  });

  it("syncViva isolates per-tenant token-acquisition failures", async () => {
    const HOME_TENANT = account.tenantId;
    const BAD_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    const HOME_AUTHORITY = vivaAuthorityFor(HOME_TENANT);
    const BAD_AUTHORITY = vivaAuthorityFor(BAD_TENANT);

    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await subs.subscribe({
      account: account.username,
      tenantId: HOME_TENANT,
      networkId: "net-home",
      communityId: "com-home",
    });
    await subs.subscribe({
      account: account.username,
      tenantId: BAD_TENANT,
      networkId: "net-bad",
      communityId: "com-bad",
    });
    const clock = new FakeClock(new Date("2026-04-22T10:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        // Only the home sub reaches listThreads — the bad-tenant sub fails
        // at token acquisition, before any Graph call.
        { kind: "listThreadsOk", response: threadsPage([]) },
      ],
    });
    const homeToken: AccessToken = {
      token: "home-tok",
      expiresOn: new Date("2026-04-22T13:00:00Z"),
      account,
    };
    const auth = new FakeAuthClient({
      accounts: [account],
      tokens: new Map([
        [`${account.homeAccountId}|${HOME_AUTHORITY}`, homeToken],
        [
          `${account.homeAccountId}|${BAD_AUTHORITY}`,
          new AuthError("silent-failed", "no token for bad tenant"),
        ],
      ]),
    });

    const res = await syncViva({ account, auth, viva, store, subs, clock });

    const homeRes = res.perCommunity.find((p) => p.communityId === "com-home");
    const badRes = res.perCommunity.find((p) => p.communityId === "com-bad");
    expect(homeRes).toEqual({ communityId: "com-home", added: 0 });
    expect(badRes?.error).toBeDefined();
    expect(badRes?.added).toBe(0);

    // No Graph call for the failed-token sub.
    const listThreadsCalls = viva.calls.filter(
      (c) => c.method === "listThreads",
    );
    expect(listThreadsCalls).toHaveLength(1);
    expect(
      (listThreadsCalls[0] as Extract<(typeof listThreadsCalls)[number], { method: "listThreads" }>)
        .communityId,
    ).toBe("com-home");
  });

  // ── Same-tick self-heal on Yammer 401 ──────────────────────────────────
  // Stale MSAL-cached AT (e.g. post-deploy tenant-consent churn) hits Yammer
  // and gets 401. syncViva re-acquires with forceRefresh=true and retries the
  // offending community once before either succeeding or recording a
  // per-community error. Investigation: docs/investigations/viva-sync-401.md.

  it("retries community once with forceRefresh after Yammer 401, ingesting fresh-token results", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await subs.subscribe({
      account: account.username,
      tenantId: account.tenantId,
      networkId: "net-1",
      communityId: "com-1",
    });
    const clock = new FakeClock(new Date("2026-04-24T09:05:00Z"));
    const authority = vivaAuthorityFor(account.tenantId);
    const staleToken: AccessToken = {
      token: "stale-tok",
      expiresOn: new Date("2026-04-24T10:00:00Z"),
      account,
    };
    const freshToken: AccessToken = {
      token: "fresh-tok",
      expiresOn: new Date("2026-04-24T10:05:00Z"),
      account,
    };
    const auth = new FakeAuthClient({
      accounts: [account],
      tokens: new Map([
        [`${account.homeAccountId}|${authority}`, staleToken],
        [`${account.homeAccountId}|${authority}|forceRefresh=true`, freshToken],
      ]),
    });
    const viva = new FakeVivaClient({
      steps: [
        // First listThreads with stale-tok 401s.
        { kind: "error", error: new TokenExpiredError("401") },
        // Retry after forceRefresh — fresh-tok succeeds.
        { kind: "listThreadsOk", response: threadsPage([thread("thr-1")]) },
        {
          kind: "listPostsOk",
          response: postsPage([
            makePost({
              id: "p-1",
              conversationId: "thr-1",
              // Within the 24h window relative to the test clock.
              createdDateTime: "2026-04-24T08:00:00Z",
            }),
          ]),
        },
      ],
    });

    const res = await syncViva({ account, auth, viva, store, subs, clock });

    expect(res.perCommunity).toEqual([{ communityId: "com-1", added: 1 }]);
    expect(res.added).toBe(1);

    const tokenCalls = auth.calls.filter((c) => c.method === "getTokenSilent");
    const forceRefreshCalls = tokenCalls.filter(
      (c) =>
        (c as Extract<(typeof tokenCalls)[number], { method: "getTokenSilent" }>)
          .forceRefresh === true,
    );
    expect(forceRefreshCalls).toHaveLength(1);

    const listThreadsCalls = viva.calls.filter((c) => c.method === "listThreads");
    expect(listThreadsCalls).toHaveLength(2);
    const tokens = listThreadsCalls.map(
      (c) =>
        (c as Extract<(typeof listThreadsCalls)[number], { method: "listThreads" }>)
          .token,
    );
    expect(tokens[0]).toBe("stale-tok");
    expect(tokens[1]).toBe("fresh-tok");
  });

  it("surfaces second 401 as per-community error and continues with other subs", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await subs.subscribe({
      account: account.username,
      tenantId: account.tenantId,
      networkId: "net-1",
      communityId: "com-bad",
    });
    await subs.subscribe({
      account: account.username,
      tenantId: account.tenantId,
      networkId: "net-1",
      communityId: "com-good",
    });
    const clock = new FakeClock(new Date("2026-04-24T09:05:00Z"));
    const authority = vivaAuthorityFor(account.tenantId);
    // Both the original and the force-refreshed token still 401 — simulates
    // a genuinely broken sub (revoked grant, network-disabled user, etc.).
    const anyToken: AccessToken = {
      token: "stale-still",
      expiresOn: new Date("2026-04-24T10:00:00Z"),
      account,
    };
    const auth = new FakeAuthClient({
      accounts: [account],
      tokens: new Map([[`${account.homeAccountId}|${authority}`, anyToken]]),
    });
    const viva = new FakeVivaClient({
      steps: [
        // com-bad: initial 401
        { kind: "error", error: new TokenExpiredError("401") },
        // com-bad retry: second 401
        { kind: "error", error: new TokenExpiredError("401") },
        // com-good: single success
        { kind: "listThreadsOk", response: threadsPage([]) },
      ],
    });

    const res = await syncViva({ account, auth, viva, store, subs, clock });

    const bad = res.perCommunity.find((p) => p.communityId === "com-bad");
    const good = res.perCommunity.find((p) => p.communityId === "com-good");
    expect(bad?.added).toBe(0);
    expect(bad?.error).toBeDefined();
    expect(bad?.error).toContain("401");
    expect(good).toEqual({ communityId: "com-good", added: 0 });
  });

  it("rethrows GraphRateLimitedError when 429 hits the forceRefresh retry", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await subs.subscribe({
      account: account.username,
      tenantId: account.tenantId,
      networkId: "net-1",
      communityId: "com-1",
    });
    const clock = new FakeClock(new Date("2026-04-24T09:05:00Z"));
    const authority = vivaAuthorityFor(account.tenantId);
    const staleToken: AccessToken = {
      token: "stale-tok",
      expiresOn: new Date("2026-04-24T10:00:00Z"),
      account,
    };
    const freshToken: AccessToken = {
      token: "fresh-tok",
      expiresOn: new Date("2026-04-24T10:05:00Z"),
      account,
    };
    const auth = new FakeAuthClient({
      accounts: [account],
      tokens: new Map([
        [`${account.homeAccountId}|${authority}`, staleToken],
        [`${account.homeAccountId}|${authority}|forceRefresh=true`, freshToken],
      ]),
    });
    const viva = new FakeVivaClient({
      steps: [
        // First listThreads → 401
        { kind: "error", error: new TokenExpiredError("401") },
        // Retry with fresh-tok → 429 (must abort the entire pass)
        { kind: "error", error: new GraphRateLimitedError(7) },
      ],
    });

    await expect(
      syncViva({ account, auth, viva, store, subs, clock }),
    ).rejects.toBeInstanceOf(GraphRateLimitedError);
  });

  it("does not retry on GraphRateLimitedError (429 path preserved)", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    const clock = new FakeClock(new Date("2026-04-24T09:05:00Z"));
    const viva = new FakeVivaClient({
      steps: [{ kind: "error", error: new GraphRateLimitedError(7) }],
    });
    const auth = authWithToken();

    await expect(
      syncViva({ account, auth, viva, store, subs, clock }),
    ).rejects.toBeInstanceOf(GraphRateLimitedError);

    const tokenCalls = auth.calls.filter((c) => c.method === "getTokenSilent");
    const forceRefreshCalls = tokenCalls.filter(
      (c) =>
        (c as Extract<(typeof tokenCalls)[number], { method: "getTokenSilent" }>)
          .forceRefresh === true,
    );
    expect(forceRefreshCalls).toHaveLength(0);
  });

  it("retry with forceRefresh fires once per 401 incident, not once per sub", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await subs.subscribe({
      account: account.username,
      tenantId: account.tenantId,
      networkId: "net-1",
      communityId: "com-A",
    });
    await subs.subscribe({
      account: account.username,
      tenantId: account.tenantId,
      networkId: "net-1",
      communityId: "com-B",
    });
    const clock = new FakeClock(new Date("2026-04-24T09:05:00Z"));
    const authority = vivaAuthorityFor(account.tenantId);
    const staleToken: AccessToken = {
      token: "stale-tok",
      expiresOn: new Date("2026-04-24T10:00:00Z"),
      account,
    };
    const freshToken: AccessToken = {
      token: "fresh-tok",
      expiresOn: new Date("2026-04-24T10:05:00Z"),
      account,
    };
    const auth = new FakeAuthClient({
      accounts: [account],
      tokens: new Map([
        [`${account.homeAccountId}|${authority}`, staleToken],
        [`${account.homeAccountId}|${authority}|forceRefresh=true`, freshToken],
      ]),
    });
    const viva = new FakeVivaClient({
      steps: [
        // com-A stale → 401
        { kind: "error", error: new TokenExpiredError("401") },
        // com-A retry with fresh → ok
        { kind: "listThreadsOk", response: threadsPage([]) },
        // com-B with whatever token it has → ok (should be fresh, see AC6)
        { kind: "listThreadsOk", response: threadsPage([]) },
      ],
    });

    await syncViva({ account, auth, viva, store, subs, clock });

    const tokenCalls = auth.calls.filter((c) => c.method === "getTokenSilent");
    const forceRefreshCalls = tokenCalls.filter(
      (c) =>
        (c as Extract<(typeof tokenCalls)[number], { method: "getTokenSilent" }>)
          .forceRefresh === true,
    );
    expect(forceRefreshCalls).toHaveLength(1);
  });

  it("records per-community error when forceRefresh acquisition itself fails", async () => {
    // If MSAL can't mint a new AT (e.g. refresh-token revoked, network blip on
    // the token endpoint), the retry cannot proceed. The sub gets a
    // per-community error carrying the refresh-failure message, and the pass
    // continues for other subs.
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await subs.subscribe({
      account: account.username,
      tenantId: account.tenantId,
      networkId: "net-1",
      communityId: "com-1",
    });
    const clock = new FakeClock(new Date("2026-04-24T09:05:00Z"));
    const authority = vivaAuthorityFor(account.tenantId);
    const staleToken: AccessToken = {
      token: "stale-tok",
      expiresOn: new Date("2026-04-24T10:00:00Z"),
      account,
    };
    const auth = new FakeAuthClient({
      accounts: [account],
      tokens: new Map<string, AccessToken | Error>([
        [`${account.homeAccountId}|${authority}`, staleToken],
        [
          `${account.homeAccountId}|${authority}|forceRefresh=true`,
          new AuthError("silent-failed", "refresh token revoked"),
        ],
      ]),
    });
    const viva = new FakeVivaClient({
      steps: [
        // First listThreads with stale-tok → 401.
        { kind: "error", error: new TokenExpiredError("401") },
        // No retry step expected — the forceRefresh fails before we get here.
      ],
    });

    const res = await syncViva({ account, auth, viva, store, subs, clock });

    const com = res.perCommunity.find((p) => p.communityId === "com-1");
    expect(com?.added).toBe(0);
    expect(com?.error).toContain("refresh token revoked");
  });

  it("force-refreshed token replaces tokenCache entry so subsequent same-tenant subs reuse it", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await subs.subscribe({
      account: account.username,
      tenantId: account.tenantId,
      networkId: "net-1",
      communityId: "com-A",
    });
    await subs.subscribe({
      account: account.username,
      tenantId: account.tenantId,
      networkId: "net-1",
      communityId: "com-C",
    });
    const clock = new FakeClock(new Date("2026-04-24T09:05:00Z"));
    const authority = vivaAuthorityFor(account.tenantId);
    const staleToken: AccessToken = {
      token: "stale-tok",
      expiresOn: new Date("2026-04-24T10:00:00Z"),
      account,
    };
    const freshToken: AccessToken = {
      token: "fresh-tok",
      expiresOn: new Date("2026-04-24T10:05:00Z"),
      account,
    };
    const auth = new FakeAuthClient({
      accounts: [account],
      tokens: new Map([
        [`${account.homeAccountId}|${authority}`, staleToken],
        [`${account.homeAccountId}|${authority}|forceRefresh=true`, freshToken],
      ]),
    });
    const viva = new FakeVivaClient({
      steps: [
        // com-A stale → 401
        { kind: "error", error: new TokenExpiredError("401") },
        // com-A retry → fresh ok
        { kind: "listThreadsOk", response: threadsPage([]) },
        // com-C (same tenant) — must use fresh, not trigger a second forceRefresh
        { kind: "listThreadsOk", response: threadsPage([]) },
      ],
    });

    await syncViva({ account, auth, viva, store, subs, clock });

    const listThreadsCalls = viva.calls.filter((c) => c.method === "listThreads");
    const tokens = listThreadsCalls.map(
      (c) =>
        (c as Extract<(typeof listThreadsCalls)[number], { method: "listThreads" }>)
          .token,
    );
    // Order: com-A stale (401), com-A fresh (retry), com-C fresh (reuse).
    expect(tokens).toEqual(["stale-tok", "fresh-tok", "fresh-tok"]);

    const tokenCalls = auth.calls.filter((c) => c.method === "getTokenSilent");
    const forceRefreshCalls = tokenCalls.filter(
      (c) =>
        (c as Extract<(typeof tokenCalls)[number], { method: "getTokenSilent" }>)
          .forceRefresh === true,
    );
    expect(forceRefreshCalls).toHaveLength(1);
  });

  // ── Rolling 24h window (replaces cursor-pagination) ────────────────────
  // Yammer REST has no delta API. The cursor walk re-fetched ~514 posts per
  // 5-minute cycle and reported r.added + r.updated as "added", inflating
  // the sync metric to ~83k/day. The window approach: one page of threads,
  // post pages walked backward only until createdDateTime < (now - 24h).
  // Plan: docs/plans/done/viva-sync-over-fetching.md.

  it("fetches a single page of threads per community (24h window mode)", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    // Cursor seeded but should be ignored — the window is now-relative.
    await subs.setCursor(
      account.username,
      "com-1",
      new Date("2026-04-20T00:00:00Z"),
    );
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        // Only one listThreads call — even if the API offers an
        // olderThanCursor, we don't follow it.
        {
          kind: "listThreadsOk",
          response: threadsPage([thread("thr-1")], "msg-100"),
        },
        {
          kind: "listPostsOk",
          response: postsPage([
            makePost({ id: "p-1", conversationId: "thr-1" }),
          ]),
        },
      ],
    });
    const auth = authWithToken();
    await syncViva({ account, auth, viva, store, subs, clock });
    const threadCalls = viva.calls.filter((c) => c.method === "listThreads");
    expect(threadCalls).toHaveLength(1);
    expect(
      (threadCalls[0] as Extract<(typeof threadCalls)[number], { method: "listThreads" }>)
        .olderThan,
    ).toBeUndefined();
  });

  it("skips posts older than the 24h window", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    // Cutoff = 2026-04-20T12:00:00Z. The page returns one in-window post
    // and one out-of-window post; walk should stop after this page.
    const viva = new FakeVivaClient({
      steps: [
        { kind: "listThreadsOk", response: threadsPage([thread("thr-1")]) },
        {
          kind: "listPostsOk",
          response: postsPage([
            makePost({
              id: "p-fresh",
              conversationId: "thr-1",
              createdDateTime: "2026-04-21T11:00:00Z",
            }),
            makePost({
              id: "p-stale",
              conversationId: "thr-1",
              createdDateTime: "2026-04-20T08:00:00Z",
            }),
          ]),
        },
      ],
    });
    const auth = authWithToken();
    const res = await syncViva({ account, auth, viva, store, subs, clock });
    expect(res.added).toBe(1);
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted.map((m) => m.nativeId)).toEqual(["p-fresh"]);
  });

  it("walks post pages backward until cutoff is crossed, then stops", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" });
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    // Page 1: two fresh posts (within 24h), olderThanCursor = "p-50".
    // Page 2: one fresh + one stale → walk stops, no third page fetched.
    const viva = new FakeVivaClient({
      steps: [
        { kind: "listThreadsOk", response: threadsPage([thread("thr-1")]) },
        {
          kind: "listPostsOk",
          response: postsPage(
            [
              makePost({
                id: "p-3",
                conversationId: "thr-1",
                createdDateTime: "2026-04-21T11:00:00Z",
              }),
              makePost({
                id: "p-2",
                conversationId: "thr-1",
                createdDateTime: "2026-04-21T01:00:00Z",
              }),
            ],
            "p-50",
          ),
        },
        {
          kind: "listPostsOk",
          response: postsPage(
            [
              makePost({
                id: "p-1",
                conversationId: "thr-1",
                createdDateTime: "2026-04-20T20:00:00Z",
              }),
              makePost({
                id: "p-old",
                conversationId: "thr-1",
                createdDateTime: "2026-04-19T20:00:00Z",
              }),
            ],
            "p-20",
          ),
        },
      ],
    });
    const auth = authWithToken();
    const res = await syncViva({ account, auth, viva, store, subs, clock });
    expect(res.added).toBe(3); // p-3, p-2, p-1; p-old excluded
    const postCalls = viva.calls.filter((c) => c.method === "listPosts");
    expect(postCalls).toHaveLength(2); // page1, page2 — no page3 fetched
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted.map((m) => m.nativeId).sort()).toEqual([
      "p-1",
      "p-2",
      "p-3",
    ]);
  });

  it("counts only newly-added posts (ignores updated upserts)", async () => {
    // Pre-seed the store with p-1 so the second sync pass updates rather
    // than adds it. The reported `added` must be 1 (p-2), not 2.
    const seededImportedAt = new Date("2026-04-21T11:00:00Z");
    const seededMessage: Message = {
      id: `viva-engage:${account.username}:p-1`,
      source: "viva-engage",
      account: account.username,
      nativeId: "p-1",
      sentAt: new Date("2026-04-21T11:00:00Z"),
      importedAt: seededImportedAt,
      rawJson: "{}",
      threadId: "viva:net-1:com-1:thr-1",
      chatType: "group",
    };
    const store = new InMemoryMessageStore({ seed: { messages: [seededMessage] } });
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
              createdDateTime: "2026-04-21T11:00:00Z",
            }),
            makePost({
              id: "p-2",
              conversationId: "thr-1",
              createdDateTime: "2026-04-21T11:30:00Z",
            }),
          ]),
        },
      ],
    });
    const auth = authWithToken();
    const res = await syncViva({ account, auth, viva, store, subs, clock });
    expect(res.added).toBe(1);
    expect(res.perCommunity).toEqual([{ communityId: "com-1", added: 1 }]);
  });

  it("does not advance subscription cursor (24h window is self-healing)", async () => {
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
              createdDateTime: "2026-04-21T11:00:00Z",
            }),
          ]),
        },
      ],
    });
    const auth = authWithToken();
    await syncViva({ account, auth, viva, store, subs, clock });
    const after = await subs.listForAccount(account.username);
    expect(after[0]?.lastCursorAt).toBeUndefined();
  });

  it("initial sync (no cursor) limits backfill to the 24h window", async () => {
    const store = new InMemoryMessageStore();
    const subs = new InMemoryVivaSubscriptionStore();
    await seedSub(subs, { communityId: "com-1" }); // no setCursor
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const viva = new FakeVivaClient({
      steps: [
        { kind: "listThreadsOk", response: threadsPage([thread("thr-1")]) },
        {
          kind: "listPostsOk",
          response: postsPage([
            makePost({
              id: "p-fresh",
              conversationId: "thr-1",
              createdDateTime: "2026-04-21T11:00:00Z",
            }),
            makePost({
              id: "p-ancient",
              conversationId: "thr-1",
              createdDateTime: "2026-01-01T00:00:00Z",
            }),
          ]),
        },
      ],
    });
    const auth = authWithToken();
    const res = await syncViva({ account, auth, viva, store, subs, clock });
    expect(res.added).toBe(1);
    const upserted = store.calls.flatMap((c) =>
      c.method === "upsertMessages" ? c.messages : [],
    );
    expect(upserted.map((m) => m.nativeId)).toEqual(["p-fresh"]);
  });
});
