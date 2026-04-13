import type {
  GraphClient,
  GraphDeltaResponse,
} from "../sources/graph.js";

export type FakeGraphStep =
  | { kind: "ok"; response: GraphDeltaResponse }
  | { kind: "error"; error: Error };

export interface FakeGraphScript {
  steps: FakeGraphStep[];
}

export class FakeGraphClient implements GraphClient {
  readonly calls: Array<{ url: string; token: string }> = [];
  private index = 0;

  constructor(private readonly script: FakeGraphScript) {}

  async getDelta(url: string, token: string): Promise<GraphDeltaResponse> {
    this.calls.push({ url, token });
    const step = this.script.steps[this.index];
    if (!step) {
      throw new Error(
        `FakeGraphClient: no scripted response for call #${this.index + 1} to ${url}`,
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
