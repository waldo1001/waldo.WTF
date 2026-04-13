import type {
  TeamsClient,
  TeamsDeltaResponse,
} from "../sources/teams.js";

export type FakeTeamsStep =
  | { kind: "ok"; response: TeamsDeltaResponse }
  | { kind: "error"; error: Error };

export interface FakeTeamsScript {
  steps: FakeTeamsStep[];
}

export class FakeTeamsClient implements TeamsClient {
  readonly calls: Array<{ url: string; token: string }> = [];
  private index = 0;

  constructor(private readonly script: FakeTeamsScript) {}

  async getDelta(url: string, token: string): Promise<TeamsDeltaResponse> {
    this.calls.push({ url, token });
    const step = this.script.steps[this.index];
    if (!step) {
      throw new Error(
        `FakeTeamsClient: no scripted response for call #${this.index + 1} to ${url}`,
      );
    }
    this.index += 1;
    if (step.kind === "error") throw step.error;
    return step.response;
  }

  get remainingSteps(): number {
    return this.script.steps.length - this.index;
  }
}
