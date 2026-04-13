export interface GraphMessage {
  id: string;
  receivedDateTime: string;
  subject: string | null;
  conversationId?: string;
  from?: { emailAddress: { name: string; address: string } };
  body?: { contentType: "text" | "html"; content: string };
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
   * (`/me/mailFolders/inbox/messages/delta`) or a nextLink/deltaLink from a
   * prior call. Implementations MUST NOT mutate `url`.
   *
   * Error mapping (real HTTP impl will translate; fakes throw directly):
   * - HTTP 401 → TokenExpiredError (caller should refresh the token)
   * - HTTP 429 → GraphRateLimitedError (caller should back off)
   * - HTTP 410 → DeltaTokenInvalidError (caller must restart full sync)
   */
  getDelta(url: string, token: string): Promise<GraphDeltaResponse>;
}

export class TokenExpiredError extends Error {}

export class GraphRateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`graph rate limited, retry after ${retryAfterSeconds}s`);
  }
}

export class DeltaTokenInvalidError extends Error {}
