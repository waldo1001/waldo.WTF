import type {
  VivaClient,
  VivaCommunityListPage,
  VivaPostPage,
  VivaThreadPage,
} from "../sources/viva.js";

export type FakeVivaStep =
  | { kind: "listCommunitiesOk"; response: VivaCommunityListPage }
  | { kind: "listThreadsOk"; response: VivaThreadPage }
  | { kind: "listPostsOk"; response: VivaPostPage }
  | { kind: "error"; error: Error };

export interface FakeVivaScript {
  steps: FakeVivaStep[];
}

export type FakeVivaCall =
  | { method: "listCommunities"; token: string; nextLink?: string }
  | {
      method: "listThreads";
      token: string;
      communityId: string;
      sinceIso?: string;
      nextLink?: string;
    }
  | {
      method: "listPosts";
      token: string;
      communityId: string;
      threadId: string;
      nextLink?: string;
    };

export class FakeVivaClient implements VivaClient {
  readonly calls: FakeVivaCall[] = [];
  private index = 0;

  constructor(private readonly script: FakeVivaScript) {}

  async listCommunities(
    token: string,
    nextLink?: string,
  ): Promise<VivaCommunityListPage> {
    const call: FakeVivaCall = { method: "listCommunities", token };
    if (nextLink !== undefined) call.nextLink = nextLink;
    this.calls.push(call);
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
    opts: { sinceIso?: string; nextLink?: string },
  ): Promise<VivaThreadPage> {
    const call: FakeVivaCall = { method: "listThreads", token, communityId };
    if (opts.sinceIso !== undefined) call.sinceIso = opts.sinceIso;
    if (opts.nextLink !== undefined) call.nextLink = opts.nextLink;
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
    communityId: string,
    threadId: string,
    opts: { nextLink?: string },
  ): Promise<VivaPostPage> {
    const call: FakeVivaCall = {
      method: "listPosts",
      token,
      communityId,
      threadId,
    };
    if (opts.nextLink !== undefined) call.nextLink = opts.nextLink;
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
