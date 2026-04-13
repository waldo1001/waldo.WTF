import type {
  TeamsChatListPage,
  TeamsClient,
  TeamsMessagesPage,
} from "../sources/teams.js";

export type FakeTeamsStep =
  | { kind: "listChatsOk"; response: TeamsChatListPage }
  | { kind: "getChatMessagesOk"; response: TeamsMessagesPage }
  | { kind: "error"; error: Error };

export interface FakeTeamsScript {
  steps: FakeTeamsStep[];
}

export type FakeTeamsCall =
  | { method: "listChats"; token: string; nextLink?: string }
  | {
      method: "getChatMessages";
      token: string;
      chatId: string;
      sinceIso?: string;
      nextLink?: string;
    };

export class FakeTeamsClient implements TeamsClient {
  readonly calls: FakeTeamsCall[] = [];
  private index = 0;

  constructor(private readonly script: FakeTeamsScript) {}

  async listChats(
    token: string,
    nextLink?: string,
  ): Promise<TeamsChatListPage> {
    const call: FakeTeamsCall = { method: "listChats", token };
    if (nextLink !== undefined) call.nextLink = nextLink;
    this.calls.push(call);
    const step = this.nextStep("listChats");
    if (step.kind === "error") throw step.error;
    if (step.kind !== "listChatsOk") {
      throw new Error(
        `FakeTeamsClient: expected listChatsOk step, got ${step.kind}`,
      );
    }
    return step.response;
  }

  async getChatMessages(
    token: string,
    chatId: string,
    opts: { sinceIso?: string; nextLink?: string },
  ): Promise<TeamsMessagesPage> {
    const call: FakeTeamsCall = { method: "getChatMessages", token, chatId };
    if (opts.sinceIso !== undefined) call.sinceIso = opts.sinceIso;
    if (opts.nextLink !== undefined) call.nextLink = opts.nextLink;
    this.calls.push(call);
    const step = this.nextStep("getChatMessages");
    if (step.kind === "error") throw step.error;
    if (step.kind !== "getChatMessagesOk") {
      throw new Error(
        `FakeTeamsClient: expected getChatMessagesOk step, got ${step.kind}`,
      );
    }
    return step.response;
  }

  private nextStep(method: string): FakeTeamsStep {
    const step = this.script.steps[this.index];
    if (!step) {
      throw new Error(
        `FakeTeamsClient: no scripted response for call #${this.index + 1} (${method})`,
      );
    }
    this.index += 1;
    return step;
  }

  get remainingSteps(): number {
    return this.script.steps.length - this.index;
  }
}
