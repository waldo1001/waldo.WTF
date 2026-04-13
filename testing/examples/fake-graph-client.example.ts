// Example: deterministic fake for the Microsoft Graph seam.
// Port to src/testing/fake-graph-client.ts at Weekend 2.
// Reference: ../../docs/tdd/testability-patterns.md §3.1
//
// The REAL implementation lives at src/sources/graph-http.ts and is the ONLY
// place `fetch` against graph.microsoft.com is allowed. Every other module
// depends on the GraphClient interface, never on fetch directly.

export interface GraphMessage {
  id: string;
  receivedDateTime: string;
  subject: string | null;
  from?: { emailAddress: { name: string; address: string } };
  body?: { contentType: "text" | "html"; content: string };
  // Delta-specific marker. When present, the row is a tombstone.
  "@removed"?: { reason: string };
}

export interface GraphDeltaResponse {
  value: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export interface GraphClient {
  /**
   * Fetch a delta page. `url` is either the initial endpoint
   * (`/me/mailFolders/inbox/messages/delta`) or a nextLink/deltaLink returned
   * by a prior call. Implementations MUST NOT mutate `url`.
   *
   * Errors:
   * - HTTP 401 → TokenExpiredError (caller should refresh)
   * - HTTP 429 → GraphRateLimitedError (caller should back off)
   * - HTTP 410 → DeltaTokenInvalidError (caller must restart full sync)
   */
  getDelta(url: string, token: string): Promise<GraphDeltaResponse>;
}

export class TokenExpiredError extends Error {}
export class GraphRateLimitedError extends Error {
  constructor(public retryAfterSeconds: number) {
    super(`graph rate limited, retry after ${retryAfterSeconds}s`);
  }
}
export class DeltaTokenInvalidError extends Error {}

type Script = {
  // One entry per getDelta call. `error` wins if set.
  steps: Array<
    | { kind: "ok"; response: GraphDeltaResponse }
    | { kind: "error"; error: Error }
  >;
};

export class FakeGraphClient implements GraphClient {
  calls: Array<{ url: string; token: string }> = [];
  private index = 0;

  constructor(private script: Script) {}

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
