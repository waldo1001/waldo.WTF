import { describe, expect, it } from "vitest";
import {
  GraphRateLimitedError,
  TokenExpiredError,
  type VivaPostPage,
  type VivaThreadPage,
} from "../sources/viva.js";
import { FakeVivaClient } from "./fake-viva-client.js";

describe("FakeVivaClient", () => {
  it("listNetworks returns scripted networks and records token", async () => {
    const networks = [
      { id: "111", name: "Acme Corp", permalink: "acme-corp" },
      { id: "222", name: "External", permalink: "external" },
    ] as const;
    const client = new FakeVivaClient({
      steps: [{ kind: "listNetworksOk", response: networks }],
    });
    const got = await client.listNetworks("token-1");
    expect(got).toBe(networks);
    expect(client.calls).toEqual([{ method: "listNetworks", token: "token-1" }]);
  });

  it("listCommunities returns scripted communities and records token", async () => {
    const communities = [
      { id: "com-1", displayName: "Engineering", networkId: "111" },
    ] as const;
    const client = new FakeVivaClient({
      steps: [{ kind: "listCommunitiesOk", response: communities }],
    });
    const got = await client.listCommunities("token-1");
    expect(got).toBe(communities);
    expect(client.calls).toEqual([
      { method: "listCommunities", token: "token-1" },
    ]);
  });

  it("listThreads returns scripted page and records communityId + olderThan", async () => {
    const page: VivaThreadPage = {
      value: [
        {
          id: "thr-1",
          topic: "release plans",
          lastPostedDateTime: "2026-04-21T08:00:00Z",
        },
      ],
      olderThanCursor: "thr-1",
    };
    const client = new FakeVivaClient({
      steps: [{ kind: "listThreadsOk", response: page }],
    });
    const got = await client.listThreads("t", "com-1", {
      olderThan: "thr-0",
    });
    expect(got).toBe(page);
    expect(client.calls).toEqual([
      {
        method: "listThreads",
        token: "t",
        communityId: "com-1",
        olderThan: "thr-0",
      },
    ]);
  });

  it("listThreads omits olderThan from call when not passed", async () => {
    const page: VivaThreadPage = { value: [] };
    const client = new FakeVivaClient({
      steps: [{ kind: "listThreadsOk", response: page }],
    });
    await client.listThreads("t", "com-2", {});
    expect(client.calls[0]).toEqual({
      method: "listThreads",
      token: "t",
      communityId: "com-2",
    });
  });

  it("listPosts returns scripted page and records threadId", async () => {
    const page: VivaPostPage = {
      value: [
        {
          id: "post-1",
          conversationId: "thr-1",
          createdDateTime: "2026-04-21T08:00:00Z",
          from: { user: { displayName: "Alice", id: "u-1" } },
          body: { contentType: "text", content: "hello" },
        },
      ],
    };
    const client = new FakeVivaClient({
      steps: [{ kind: "listPostsOk", response: page }],
    });
    const got = await client.listPosts("t", "thr-1", {});
    expect(got).toBe(page);
    expect(client.calls).toEqual([
      { method: "listPosts", token: "t", threadId: "thr-1" },
    ]);
  });

  it("listPosts records olderThan when provided", async () => {
    const page: VivaPostPage = { value: [] };
    const client = new FakeVivaClient({
      steps: [{ kind: "listPostsOk", response: page }],
    });
    await client.listPosts("t", "thr-1", { olderThan: "post-0" });
    expect(client.calls[0]).toEqual({
      method: "listPosts",
      token: "t",
      threadId: "thr-1",
      olderThan: "post-0",
    });
  });

  it("successive calls consume scripted steps in order", async () => {
    const networks = [{ id: "net-1", name: "Acme", permalink: "acme" }] as const;
    const communities = [
      { id: "com-1", displayName: "C", networkId: "net-1" },
    ] as const;
    const thrPage: VivaThreadPage = { value: [] };
    const client = new FakeVivaClient({
      steps: [
        { kind: "listNetworksOk", response: networks },
        { kind: "listCommunitiesOk", response: communities },
        { kind: "listThreadsOk", response: thrPage },
      ],
    });
    expect(client.remainingSteps).toBe(3);
    await client.listNetworks("t");
    expect(client.remainingSteps).toBe(2);
    await client.listCommunities("t");
    expect(client.remainingSteps).toBe(1);
    await client.listThreads("t", "com-1", {});
    expect(client.remainingSteps).toBe(0);
  });

  it("throws scripted errors (TokenExpiredError, GraphRateLimitedError)", async () => {
    const client = new FakeVivaClient({
      steps: [
        { kind: "error", error: new TokenExpiredError("401") },
        { kind: "error", error: new GraphRateLimitedError(7) },
        { kind: "error", error: new GraphRateLimitedError(3) },
        { kind: "error", error: new GraphRateLimitedError(5) },
      ],
    });
    await expect(client.listNetworks("t")).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
    await expect(
      client.listCommunities("t"),
    ).rejects.toBeInstanceOf(GraphRateLimitedError);
    await expect(
      client.listThreads("t", "com-1", {}),
    ).rejects.toBeInstanceOf(GraphRateLimitedError);
    await expect(
      client.listPosts("t", "thr-1", {}),
    ).rejects.toBeInstanceOf(GraphRateLimitedError);
  });

  it("throws an informative error when no scripted step remains", async () => {
    const client = new FakeVivaClient({ steps: [] });
    await expect(client.listNetworks("t")).rejects.toThrowError(
      /no scripted response for call #1 \(listNetworks\)/,
    );
  });

  it("rejects when step kind does not match the method called", async () => {
    const c1 = new FakeVivaClient({
      steps: [{ kind: "listThreadsOk", response: { value: [] } }],
    });
    await expect(c1.listNetworks("t")).rejects.toThrowError(
      /expected listNetworksOk step/,
    );

    const c2 = new FakeVivaClient({
      steps: [{ kind: "listNetworksOk", response: [] }],
    });
    await expect(c2.listCommunities("t")).rejects.toThrowError(
      /expected listCommunitiesOk step/,
    );

    const c3 = new FakeVivaClient({
      steps: [{ kind: "listNetworksOk", response: [] }],
    });
    await expect(c3.listThreads("t", "com-1", {})).rejects.toThrowError(
      /expected listThreadsOk step/,
    );

    const c4 = new FakeVivaClient({
      steps: [{ kind: "listNetworksOk", response: [] }],
    });
    await expect(c4.listPosts("t", "thr-1", {})).rejects.toThrowError(
      /expected listPostsOk step/,
    );
  });
});
