import { describe, expect, it } from "vitest";
import { DEFAULT_SENT_DELTA_ENDPOINT, syncSent } from "./sync-sent.js";
import { FakeAuthClient } from "../testing/fake-auth-client.js";
import { FakeGraphClient } from "../testing/fake-graph-client.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { FakeClock } from "../testing/fake-clock.js";
import type { Account, AccessToken } from "../auth/types.js";
import type { GraphDeltaResponse, GraphMessage } from "../sources/graph.js";

const account: Account = {
  username: "alice@example.invalid",
  homeAccountId: "home-alice",
  tenantId: "tenant-alice",
};

const accessToken: AccessToken = {
  token: "graph-tok",
  expiresOn: new Date("2026-04-13T11:00:00Z"),
  account,
};

const authWithToken = (): FakeAuthClient =>
  new FakeAuthClient({
    accounts: [account],
    tokens: new Map([[account.homeAccountId, accessToken]]),
  });

const sentMsg = (overrides: Partial<GraphMessage> = {}): GraphMessage => ({
  id: "sent-1",
  receivedDateTime: "2026-04-13T10:00:00Z",
  subject: "Re: hello",
  conversationId: "conv-1",
  from: {
    emailAddress: { name: "Alice", address: "alice@example.invalid" },
  },
  body: { contentType: "text", content: "reply body" },
  ...overrides,
});

const okResponse = (r: Partial<GraphDeltaResponse>): GraphDeltaResponse => ({
  value: [],
  ...r,
});

describe("syncSent", () => {
  it("hits /me/mailFolders/sentitems/messages/delta on first run", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [sentMsg()],
            "@odata.deltaLink": "https://graph/delta?token=s1",
          }),
        },
      ],
    });
    const auth = authWithToken();

    const result = await syncSent({ account, auth, graph, store, clock });

    expect(result).toEqual({ added: 1, removed: 0 });
    expect(graph.calls[0]?.url).toBe(DEFAULT_SENT_DELTA_ENDPOINT);
    expect(graph.calls[0]?.token).toBe("graph-tok");
  });

  it("persists rows with fromMe=true sharing threadId with inbox", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [sentMsg({ id: "sent-1", conversationId: "conv-1" })],
            "@odata.deltaLink": "d",
          }),
        },
      ],
    });
    const auth = authWithToken();

    await syncSent({ account, auth, graph, store, clock });

    const thread = await store.getThread({ threadId: "conv-1" });
    expect(thread).toHaveLength(1);
    expect(thread[0]?.fromMe).toBe(true);
    expect(thread[0]?.threadId).toBe("conv-1");
    expect(thread[0]?.source).toBe("outlook");
  });

  it("stores its delta cursor under folder='sentitems', independent of inbox cursor", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        syncState: [
          {
            account: account.username,
            source: "outlook",
            folder: "",
            deltaToken: "inbox-cursor",
          },
        ],
      },
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [],
            "@odata.deltaLink": "sent-cursor",
          }),
        },
      ],
    });
    const auth = authWithToken();

    await syncSent({ account, auth, graph, store, clock });

    expect(graph.calls[0]?.url).toBe(DEFAULT_SENT_DELTA_ENDPOINT);
    const inbox = await store.getSyncState(account.username, "outlook");
    const sent = await store.getSyncState(
      account.username,
      "outlook",
      "sentitems",
    );
    expect(inbox?.deltaToken).toBe("inbox-cursor");
    expect(sent?.deltaToken).toBe("sent-cursor");
  });

  it("resumes from its own sentitems deltaToken on subsequent runs", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        syncState: [
          {
            account: account.username,
            source: "outlook",
            folder: "sentitems",
            deltaToken: "https://graph/delta?token=prev",
          },
        ],
      },
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [],
            "@odata.deltaLink": "https://graph/delta?token=next",
          }),
        },
      ],
    });
    const auth = authWithToken();

    await syncSent({ account, auth, graph, store, clock });

    expect(graph.calls[0]?.url).toBe("https://graph/delta?token=prev");
  });

  it("honors backfillDays the same way as inbox", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-20T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [],
            "@odata.deltaLink": "d",
          }),
        },
      ],
    });
    const auth = authWithToken();

    await syncSent({
      account,
      auth,
      graph,
      store,
      clock,
      backfillDays: 7,
    });

    const url = graph.calls[0]?.url ?? "";
    expect(url).toContain(DEFAULT_SENT_DELTA_ENDPOINT);
    expect(url).toContain("$filter=");
    expect(url).toContain("receivedDateTime");
    expect(url).toContain("ge");
    // 7 days prior to 2026-04-20T12:00:00Z = 2026-04-13T12:00:00.000Z
    expect(decodeURIComponent(url)).toContain("2026-04-13T12:00:00.000Z");
  });

  it("handles @removed tombstones by deleting the matching row", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [sentMsg({ id: "will-go" })],
            "@odata.deltaLink": "d1",
          }),
        },
        {
          kind: "ok",
          response: okResponse({
            value: [{ id: "will-go", "@removed": { reason: "deleted" } } as GraphMessage],
            "@odata.deltaLink": "d2",
          }),
        },
      ],
    });
    const auth = authWithToken();

    const first = await syncSent({ account, auth, graph, store, clock });
    expect(first.added).toBe(1);

    const second = await syncSent({ account, auth, graph, store, clock });
    expect(second.removed).toBe(1);
  });

  it("converts HTML body to text and preserves bodyHtml", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [
              sentMsg({
                id: "html-1",
                body: { contentType: "html", content: "<p>Hello <b>there</b></p>" },
              }),
            ],
            "@odata.deltaLink": "d",
          }),
        },
      ],
    });
    const auth = authWithToken();

    await syncSent({ account, auth, graph, store, clock });

    const thread = await store.getThread({ threadId: "conv-1" });
    expect(thread[0]?.bodyHtml).toBe("<p>Hello <b>there</b></p>");
    expect(thread[0]?.body).toContain("Hello");
    expect(thread[0]?.body).toContain("there");
  });

  it("handles messages with null subject and absent body", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [
              sentMsg({
                id: "bare-1",
                subject: null as unknown as string,
                body: undefined,
              }),
            ],
            "@odata.deltaLink": "d",
          }),
        },
      ],
    });
    const auth = authWithToken();

    await syncSent({ account, auth, graph, store, clock });

    const thread = await store.getThread({ threadId: "conv-1" });
    expect(thread).toHaveLength(1);
    expect(thread[0]?.threadName).toBeUndefined();
    expect(thread[0]?.body).toBeUndefined();
    expect(thread[0]?.bodyHtml).toBeUndefined();
  });

  it("follows @odata.nextLink pagination before storing final deltaLink", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [sentMsg({ id: "page1-a" })],
            "@odata.nextLink": "https://graph/delta?page=2",
          }),
        },
        {
          kind: "ok",
          response: okResponse({
            value: [sentMsg({ id: "page2-a", conversationId: "conv-2" })],
            "@odata.deltaLink": "https://graph/delta?token=final",
          }),
        },
      ],
    });
    const auth = authWithToken();

    const result = await syncSent({ account, auth, graph, store, clock });

    expect(result.added).toBe(2);
    expect(graph.calls).toHaveLength(2);
    expect(graph.calls[1]?.url).toBe("https://graph/delta?page=2");
    const sent = await store.getSyncState(
      account.username,
      "outlook",
      "sentitems",
    );
    expect(sent?.deltaToken).toBe("https://graph/delta?token=final");
  });

  it("synthesizes senderEmail from account.username when from field is missing (draft)", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [
              sentMsg({
                id: "draft-1",
                from: undefined,
                body: { contentType: "text", content: "draft body" },
              }),
            ],
            "@odata.deltaLink": "d",
          }),
        },
      ],
    });
    const auth = authWithToken();

    await syncSent({ account, auth, graph, store, clock });

    const thread = await store.getThread({ threadId: "conv-1" });
    expect(thread).toHaveLength(1);
    expect(thread[0]?.senderEmail).toBe("alice@example.invalid");
    expect(thread[0]?.fromMe).toBe(true);
    expect(thread[0]?.body).toBe("draft body");
  });
});
