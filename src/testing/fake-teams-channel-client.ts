import type {
  TeamsChannel,
  TeamsChannelClient,
  TeamsChannelMessagesPage,
  TeamsJoinedTeam,
} from "../sources/teams-channel.js";

export type FakeTeamsChannelStep =
  | { kind: "listJoinedTeamsOk"; response: readonly TeamsJoinedTeam[] }
  | {
      kind: "listChannelsOk";
      teamId: string;
      response: readonly TeamsChannel[];
    }
  | {
      kind: "getChannelMessagesDeltaOk";
      response: TeamsChannelMessagesPage;
    }
  | { kind: "error"; error: Error };

export interface FakeTeamsChannelScript {
  steps: FakeTeamsChannelStep[];
}

export type FakeTeamsChannelCall =
  | { method: "listJoinedTeams"; token: string }
  | { method: "listChannels"; token: string; teamId: string }
  | {
      method: "getChannelMessagesDelta";
      token: string;
      teamId: string;
      channelId: string;
      deltaLink?: string;
      nextLink?: string;
      sinceIso?: string;
    };

export class FakeTeamsChannelClient implements TeamsChannelClient {
  readonly calls: FakeTeamsChannelCall[] = [];
  private index = 0;

  constructor(private readonly script: FakeTeamsChannelScript) {}

  async *listJoinedTeams(token: string): AsyncIterable<TeamsJoinedTeam> {
    this.calls.push({ method: "listJoinedTeams", token });
    const step = this.nextStep("listJoinedTeams");
    if (step.kind === "error") throw step.error;
    if (step.kind !== "listJoinedTeamsOk") {
      throw new Error(
        `FakeTeamsChannelClient: expected listJoinedTeamsOk, got ${step.kind}`,
      );
    }
    for (const t of step.response) yield t;
  }

  async *listChannels(
    token: string,
    teamId: string,
  ): AsyncIterable<TeamsChannel> {
    this.calls.push({ method: "listChannels", token, teamId });
    const step = this.nextStep("listChannels");
    if (step.kind === "error") throw step.error;
    if (step.kind !== "listChannelsOk") {
      throw new Error(
        `FakeTeamsChannelClient: expected listChannelsOk, got ${step.kind}`,
      );
    }
    for (const c of step.response) yield c;
  }

  async getChannelMessagesDelta(
    token: string,
    teamId: string,
    channelId: string,
    opts: {
      deltaLink?: string;
      nextLink?: string;
      sinceIso?: string;
    },
  ): Promise<TeamsChannelMessagesPage> {
    const call: FakeTeamsChannelCall = {
      method: "getChannelMessagesDelta",
      token,
      teamId,
      channelId,
    };
    if (opts.deltaLink !== undefined) call.deltaLink = opts.deltaLink;
    if (opts.nextLink !== undefined) call.nextLink = opts.nextLink;
    if (opts.sinceIso !== undefined) call.sinceIso = opts.sinceIso;
    this.calls.push(call);
    const step = this.nextStep("getChannelMessagesDelta");
    if (step.kind === "error") throw step.error;
    if (step.kind !== "getChannelMessagesDeltaOk") {
      throw new Error(
        `FakeTeamsChannelClient: expected getChannelMessagesDeltaOk, got ${step.kind}`,
      );
    }
    return step.response;
  }

  private nextStep(method: string): FakeTeamsChannelStep {
    const step = this.script.steps[this.index];
    if (!step) {
      throw new Error(
        `FakeTeamsChannelClient: no scripted response for call #${this.index + 1} (${method})`,
      );
    }
    this.index += 1;
    return step;
  }

  get remainingSteps(): number {
    return this.script.steps.length - this.index;
  }
}
