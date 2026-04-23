export interface VivaNetwork {
  readonly id: string;
  readonly name: string;
  readonly permalink: string;
}

export interface VivaCommunity {
  readonly id: string;
  readonly displayName: string;
  readonly networkId: string;
  readonly networkName?: string;
  readonly description?: string;
  readonly tenantId?: string;
}

export interface VivaPostAuthor {
  readonly id?: string;
  readonly displayName?: string;
  readonly userPrincipalName?: string;
}

export interface VivaPost {
  readonly id: string;
  readonly conversationId: string;
  readonly createdDateTime: string;
  readonly lastModifiedDateTime?: string;
  readonly from?: { readonly user?: VivaPostAuthor } | null;
  readonly body?: {
    readonly contentType?: "text" | "html";
    readonly content?: string;
  };
}

export interface VivaThread {
  readonly id: string;
  readonly topic?: string | null;
  readonly lastPostedDateTime?: string;
}

export interface VivaThreadPage {
  readonly value: readonly VivaThread[];
  /** Oldest message id from this page — pass as `olderThan` to get the next page. Undefined = last page. */
  readonly olderThanCursor?: string;
}

export interface VivaPostPage {
  readonly value: readonly VivaPost[];
  /** Oldest message id from this page — pass as `olderThan` to get the next page. Undefined = last page. */
  readonly olderThanCursor?: string;
}

/**
 * Yammer REST-backed Viva Engage client.
 * Token audience: https://api.yammer.com/
 * Request host: www.yammer.com/api/v1
 *
 * Error mapping (real HTTP impl translates; fakes throw directly):
 * - HTTP 401 → `TokenExpiredError`
 * - HTTP 429 → `GraphRateLimitedError` (retryAfterSeconds, default 6s for Yammer)
 */
export interface VivaClient {
  /** Returns all Yammer networks visible to this token. */
  listNetworks(token: string): Promise<readonly VivaNetwork[]>;
  /** Returns all communities the token holder has joined, across all networks reachable with this token. Single call, no pagination. */
  listCommunities(token: string): Promise<readonly VivaCommunity[]>;
  /** Returns a page of top-level threads in a community, newest-first. */
  listThreads(
    token: string,
    communityId: string,
    opts: { olderThan?: string },
  ): Promise<VivaThreadPage>;
  /** Returns a page of posts (replies) in a thread, newest-first. */
  listPosts(
    token: string,
    threadId: string,
    opts: { olderThan?: string },
  ): Promise<VivaPostPage>;
}

export { TokenExpiredError, GraphRateLimitedError } from "./graph.js";
