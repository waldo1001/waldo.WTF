import { describe, expect, it } from "vitest";
import {
  GraphRateLimitedError,
  TokenExpiredError,
  type VivaCommunityListPage,
  type VivaPostPage,
  type VivaThreadPage,
} from "../sources/viva.js";
import { FakeVivaClient } from "./fake-viva-client.js";

describe("FakeVivaClient", () => {
  it("listCommunities returns the scripted page and records token", async () => {
    const page: VivaCommunityListPage = {
      value: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          displayName: "Engineering",
          networkId: "00000000-0000-0000-0000-0000000000aa",
        },
      ],
    };
    const client = new FakeVivaClient({
      steps: [{ kind: "listCommunitiesOk", response: page }],
    });
    const got = await client.listCommunities("token-1");
    expect(got).toBe(page);
    expect(client.calls).toEqual([
      { method: "listCommunities", token: "token-1" },
    ]);
  });

  it("listCommunities records nextLink when present", async () => {
    const page: VivaCommunityListPage = { value: [] };
    const client = new FakeVivaClient({
      steps: [{ kind: "listCommunitiesOk", response: page }],
    });
    await client.listCommunities("t", "https://graph.microsoft.com/next");
    expect(client.calls[0]).toEqual({
      method: "listCommunities",
      token: "t",
      nextLink: "https://graph.microsoft.com/next",
    });
  });

  it("listThreads returns scripted page and records communityId + sinceIso", async () => {
    const page: VivaThreadPage = {
      value: [
        {
          id: "thr-1",
          topic: "release plans",
          lastPostedDateTime: "2026-04-21T08:00:00Z",
        },
      ],
    };
    const client = new FakeVivaClient({
      steps: [{ kind: "listThreadsOk", response: page }],
    });
    const got = await client.listThreads("t", "com-1", {
      sinceIso: "2026-04-13T00:00:00Z",
    });
    expect(got).toBe(page);
    expect(client.calls).toEqual([
      {
        method: "listThreads",
        token: "t",
        communityId: "com-1",
        sinceIso: "2026-04-13T00:00:00Z",
      },
    ]);
  });

  it("listThreads records nextLink and omits sinceIso when not passed", async () => {
    const page: VivaThreadPage = { value: [] };
    const client = new FakeVivaClient({
      steps: [{ kind: "listThreadsOk", response: page }],
    });
    await client.listThreads("t", "com-2", {
      nextLink: "https://graph.microsoft.com/next",
    });
    expect(client.calls[0]).toEqual({
      method: "listThreads",
      token: "t",
      communityId: "com-2",
      nextLink: "https://graph.microsoft.com/next",
    });
  });

  it("listPosts returns scripted page and records community + thread", async () => {
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
    const got = await client.listPosts("t", "com-1", "thr-1", {});
    expect(got).toBe(page);
    expect(client.calls).toEqual([
      {
        method: "listPosts",
        token: "t",
        communityId: "com-1",
        threadId: "thr-1",
      },
    ]);
  });

  it("listPosts records nextLink", async () => {
    const page: VivaPostPage = { value: [] };
    const client = new FakeVivaClient({
      steps: [{ kind: "listPostsOk", response: page }],
    });
    await client.listPosts("t", "com-1", "thr-1", {
      nextLink: "https://graph.microsoft.com/next",
    });
    expect(client.calls[0]).toEqual({
      method: "listPosts",
      token: "t",
      communityId: "com-1",
      threadId: "thr-1",
      nextLink: "https://graph.microsoft.com/next",
    });
  });

  it("successive calls consume scripted steps in order", async () => {
    const comPage: VivaCommunityListPage = {
      value: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          displayName: "C",
          networkId: "00000000-0000-0000-0000-0000000000aa",
        },
      ],
    };
    const thrPage: VivaThreadPage = { value: [] };
    const client = new FakeVivaClient({
      steps: [
        { kind: "listCommunitiesOk", response: comPage },
        { kind: "listThreadsOk", response: thrPage },
      ],
    });
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
      ],
    });
    await expect(client.listCommunities("t")).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
    await expect(
      client.listThreads("t", "com-1", {}),
    ).rejects.toBeInstanceOf(GraphRateLimitedError);
    await expect(
      client.listPosts("t", "com-1", "thr-1", {}),
    ).rejects.toBeInstanceOf(GraphRateLimitedError);
  });

  it("throws an informative error when no scripted step remains", async () => {
    const client = new FakeVivaClient({ steps: [] });
    await expect(client.listCommunities("t")).rejects.toThrowError(
      /no scripted response for call #1 \(listCommunities\)/,
    );
  });

  it("rejects when step kind does not match the method called", async () => {
    const client = new FakeVivaClient({
      steps: [{ kind: "listThreadsOk", response: { value: [] } }],
    });
    await expect(client.listCommunities("t")).rejects.toThrowError(
      /expected listCommunitiesOk step/,
    );
    const c2 = new FakeVivaClient({
      steps: [{ kind: "listCommunitiesOk", response: { value: [] } }],
    });
    await expect(c2.listThreads("t", "com-1", {})).rejects.toThrowError(
      /expected listThreadsOk step/,
    );
    const c3 = new FakeVivaClient({
      steps: [{ kind: "listCommunitiesOk", response: { value: [] } }],
    });
    await expect(
      c3.listPosts("t", "com-1", "thr-1", {}),
    ).rejects.toThrowError(/expected listPostsOk step/);
  });
});
