import type {
  VivaClient,
  VivaCommunity,
  VivaNetwork,
  VivaPostPage,
  VivaThreadPage,
} from "../sources/viva.js";

export type FakeVivaStep =
  | { kind: "listNetworksOk"; response: readonly VivaNetwork[] }
  | { kind: "listCommunitiesOk"; response: readonly VivaCommunity[] }
  | { kind: "listThreadsOk"; response: VivaThreadPage }
  | { kind: "listPostsOk"; response: VivaPostPage }
  | { kind: "error"; error: Error };

export interface FakeVivaScript {
  steps: FakeVivaStep[];
}

export type FakeVivaCall =
  | { method: "listNetworks"; token: string }
  | { method: "listCommunities"; token: string; networkId: string }
  | {
      method: "listThreads";
      token: string;
      communityId: string;
      olderThan?: string;
    }
  | {
      method: "listPosts";
      token: string;
      threadId: string;
      olderThan?: string;
    };

export class FakeVivaClient implements VivaClient {
  readonly calls: FakeVivaCall[] = [];
  private index = 0;

  constructor(private readonly script: FakeVivaScript) {}

  async listNetworks(token: string): Promise<readonly VivaNetwork[]> {
    this.calls.push({ method: "listNetworks", token });
    const step = this.nextStep("listNetworks");
    if (step.kind === "error") throw step.error;
    if (step.kind !== "listNetworksOk") {
      throw new Error(
        `FakeVivaClient: expected listNetworksOk step, got ${step.kind}`,
      );
    }
    return step.response;
  }

  async listCommunities(
    token: string,
    networkId: string,
  ): Promise<readonly VivaCommunity[]> {
    this.calls.push({ method: "listCommunities", token, networkId });
    const step = this.nextStep("listCommunities");
    if (step.kind === "error") throw step.error;
    if (step.kind !== "listCommunitiesOk") {
      throw new Error(
        `FakeVivaClient: expected listCommunitiesOk step, got ${step.kind}`,
      );
    }
    return step.response;
  }

  async listThreads(
    token: string,
    communityId: string,
    opts: { olderThan?: string },
  ): Promise<VivaThreadPage> {
    const call: FakeVivaCall = { method: "listThreads", token, communityId };
    if (opts.olderThan !== undefined)
      (call as { olderThan?: string }).olderThan = opts.olderThan;
    this.calls.push(call);
    const step = this.nextStep("listThreads");
    if (step.kind === "error") throw step.error;
    if (step.kind !== "listThreadsOk") {
      throw new Error(
        `FakeVivaClient: expected listThreadsOk step, got ${step.kind}`,
      );
    }
    return step.response;
  }

  async listPosts(
    token: string,
    threadId: string,
    opts: { olderThan?: string },
  ): Promise<VivaPostPage> {
    const call: FakeVivaCall = { method: "listPosts", token, threadId };
    if (opts.olderThan !== undefined)
      (call as { olderThan?: string }).olderThan = opts.olderThan;
    this.calls.push(call);
    const step = this.nextStep("listPosts");
    if (step.kind === "error") throw step.error;
    if (step.kind !== "listPostsOk") {
      throw new Error(
        `FakeVivaClient: expected listPostsOk step, got ${step.kind}`,
      );
    }
    return step.response;
  }

  private nextStep(method: string): FakeVivaStep {
    const step = this.script.steps[this.index];
    if (!step) {
      throw new Error(
        `FakeVivaClient: no scripted response for call #${this.index + 1} (${method})`,
      );
    }
    this.index += 1;
    return step;
  }

  get remainingSteps(): number {
    return this.script.steps.length - this.index;
  }
}
