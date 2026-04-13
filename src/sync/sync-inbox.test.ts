import { describe, it, expect } from "vitest";
import { syncInbox, DEFAULT_INBOX_DELTA_ENDPOINT } from "./sync-inbox.js";
import { FakeAuthClient } from "../testing/fake-auth-client.js";
import { FakeGraphClient } from "../testing/fake-graph-client.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { FakeClock } from "../testing/fake-clock.js";
import type { Account, AccessToken } from "../auth/types.js";
import type { GraphMessage, GraphDeltaResponse } from "../sources/graph.js";
import {
  TokenExpiredError,
  DeltaTokenInvalidError,
} from "../sources/graph.js";

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

const authWithToken = () =>
  new FakeAuthClient({
    accounts: [account],
    tokens: new Map([[account.homeAccountId, accessToken]]),
  });

const makeGraphMessage = (overrides: Partial<GraphMessage> = {}): GraphMessage => ({
  id: "msg-1",
  receivedDateTime: "2026-04-13T10:00:00Z",
  subject: "hello",
  from: { emailAddress: { name: "Alice", address: "alice@example.invalid" } },
  body: { contentType: "text", content: "body text" },
  ...overrides,
});

const okResponse = (r: Partial<GraphDeltaResponse>): GraphDeltaResponse => ({
  value: [],
  ...r,
});

describe("syncInbox", () => {
  it("on first run, starts at default endpoint, upserts one message, stores deltaLink, returns {added:1, removed:0}", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [makeGraphMessage({ id: "msg-1" })],
            "@odata.deltaLink": "https://graph/delta?token=d1",
          }),
        },
      ],
    });
    const auth = authWithToken();

    const result = await syncInbox({ account, auth, graph, store, clock });

    expect(result).toEqual({ added: 1, removed: 0 });
    expect(graph.calls[0]?.url).toBe(DEFAULT_INBOX_DELTA_ENDPOINT);
    expect(graph.calls[0]?.token).toBe("graph-tok");
    const state = await store.getSyncState(account.username, "outlook");
    expect(state?.deltaToken).toBe("https://graph/delta?token=d1");
    expect(state?.lastSyncAt?.toISOString()).toBe("2026-04-13T12:00:00.000Z");
  });

  it("on subsequent run, starts from stored deltaToken instead of default endpoint", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        syncState: [
          {
            account: account.username,
            source: "outlook",
            deltaToken: "https://graph/delta?token=prev",
            lastSyncAt: new Date("2026-04-13T11:00:00Z"),
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

    await syncInbox({ account, auth, graph, store, clock });

    expect(graph.calls[0]?.url).toBe("https://graph/delta?token=prev");
  });

  it("follows @odata.nextLink across pages and stores final deltaLink", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [makeGraphMessage({ id: "msg-1" })],
            "@odata.nextLink": "https://graph/delta?skiptoken=abc",
          }),
        },
        {
          kind: "ok",
          response: okResponse({
            value: [makeGraphMessage({ id: "msg-2" })],
            "@odata.deltaLink": "https://graph/delta?token=final",
          }),
        },
      ],
    });
    const auth = authWithToken();

    const result = await syncInbox({ account, auth, graph, store, clock });

    expect(result.added).toBe(2);
    expect(graph.calls).toHaveLength(2);
    expect(graph.calls[1]?.url).toBe("https://graph/delta?skiptoken=abc");
    const state = await store.getSyncState(account.username, "outlook");
    expect(state?.deltaToken).toBe("https://graph/delta?token=final");
  });

  it("routes @removed messages to deleteMessages, not upsertMessages", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        messages: [
          {
            id: `outlook:${account.username}:to-remove`,
            source: "outlook",
            account: account.username,
            nativeId: "to-remove",
            sentAt: new Date("2026-04-12T09:00:00Z"),
            importedAt: new Date("2026-04-12T10:00:00Z"),
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
            value: [
              {
                id: "to-remove",
                receivedDateTime: "2026-04-12T09:00:00Z",
                subject: null,
                "@removed": { reason: "deleted" },
              },
            ],
            "@odata.deltaLink": "https://graph/delta?token=d1",
          }),
        },
      ],
    });
    const auth = authWithToken();

    const result = await syncInbox({ account, auth, graph, store, clock });

    expect(result).toEqual({ added: 0, removed: 1 });
    const deleteCalls = store.calls.filter((c) => c.method === "deleteMessages");
    const upsertCalls = store.calls.filter(
      (c) => c.method === "upsertMessages" && c.messages.length > 0,
    );
    expect(deleteCalls).toHaveLength(1);
    expect(upsertCalls).toHaveLength(0);
  });

  it("parses receivedDateTime into sentAt and stamps importedAt from clock", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:34:56Z"));
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [
              makeGraphMessage({
                id: "msg-ts",
                receivedDateTime: "2026-04-10T07:08:09Z",
              }),
            ],
            "@odata.deltaLink": "d",
          }),
        },
      ],
    });
    const auth = authWithToken();

    await syncInbox({ account, auth, graph, store, clock });

    const upserted = store.calls
      .flatMap((c) => (c.method === "upsertMessages" ? c.messages : []))
      .find((m) => m.nativeId === "msg-ts");
    expect(upserted?.sentAt.toISOString()).toBe("2026-04-10T07:08:09.000Z");
    expect(upserted?.importedAt.toISOString()).toBe("2026-04-13T12:34:56.000Z");
  });

  it("propagates TokenExpiredError without updating syncState", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [{ kind: "error", error: new TokenExpiredError("401") }],
    });
    const auth = authWithToken();

    await expect(
      syncInbox({ account, auth, graph, store, clock }),
    ).rejects.toBeInstanceOf(TokenExpiredError);

    expect(
      store.calls.some((c) => c.method === "setSyncState"),
    ).toBe(false);
  });

  it("propagates DeltaTokenInvalidError without updating syncState", async () => {
    const store = new InMemoryMessageStore({
      seed: {
        syncState: [
          {
            account: account.username,
            source: "outlook",
            deltaToken: "https://graph/delta?token=stale",
          },
        ],
      },
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [{ kind: "error", error: new DeltaTokenInvalidError("410") }],
    });
    const auth = authWithToken();

    await expect(
      syncInbox({ account, auth, graph, store, clock }),
    ).rejects.toBeInstanceOf(DeltaTokenInvalidError);

    const state = await store.getSyncState(account.username, "outlook");
    expect(state?.deltaToken).toBe("https://graph/delta?token=stale");
  });

  it("maps Graph from/body onto senderName, senderEmail, body, bodyHtml", async () => {
    const store = new InMemoryMessageStore();
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const graph = new FakeGraphClient({
      steps: [
        {
          kind: "ok",
          response: okResponse({
            value: [
              makeGraphMessage({
                id: "msg-text",
                from: {
                  emailAddress: { name: "Bob", address: "bob@example.invalid" },
                },
                body: { contentType: "text", content: "plain content" },
              }),
              makeGraphMessage({
                id: "msg-html",
                from: {
                  emailAddress: { name: "Carol", address: "carol@example.invalid" },
                },
                body: { contentType: "html", content: "<p>rich</p>" },
              }),
            ],
            "@odata.deltaLink": "d",
          }),
        },
      ],
    });
    const auth = authWithToken();

    await syncInbox({ account, auth, graph, store, clock });

    const upserted = store.calls
      .flatMap((c) => (c.method === "upsertMessages" ? c.messages : []));
    const text = upserted.find((m) => m.nativeId === "msg-text");
    const html = upserted.find((m) => m.nativeId === "msg-html");
    expect(text?.senderName).toBe("Bob");
    expect(text?.senderEmail).toBe("bob@example.invalid");
    expect(text?.body).toBe("plain content");
    expect(text?.bodyHtml).toBeUndefined();
    expect(html?.senderName).toBe("Carol");
    expect(html?.bodyHtml).toBe("<p>rich</p>");
    expect(html?.body).toBeUndefined();
  });
});
