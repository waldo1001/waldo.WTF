export interface VivaCommunity {
  readonly id: string;
  readonly displayName: string;
  readonly networkId: string;
  readonly networkName?: string;
  readonly description?: string;
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

export interface VivaCommunityListPage {
  readonly value: readonly VivaCommunity[];
  readonly "@odata.nextLink"?: string;
}

export interface VivaThreadPage {
  readonly value: readonly VivaThread[];
  readonly "@odata.nextLink"?: string;
}

export interface VivaPostPage {
  readonly value: readonly VivaPost[];
  readonly "@odata.nextLink"?: string;
}

/**
 * Polling Viva Engage client. Microsoft Graph beta `/employeeExperience`
 * endpoints. No deltaLink — pagination via `@odata.nextLink`, incremental
 * sync via per-community timestamp cursor stored in `viva_subscriptions`.
 *
 * Error mapping (real HTTP impl translates; fakes throw directly):
 * - HTTP 401 → `TokenExpiredError`
 * - HTTP 429 → `GraphRateLimitedError`
 */
export interface VivaClient {
  listCommunities(
    token: string,
    nextLink?: string,
  ): Promise<VivaCommunityListPage>;
  listThreads(
    token: string,
    communityId: string,
    opts: { sinceIso?: string; nextLink?: string },
  ): Promise<VivaThreadPage>;
  listPosts(
    token: string,
    communityId: string,
    threadId: string,
    opts: { nextLink?: string },
  ): Promise<VivaPostPage>;
}

export { TokenExpiredError, GraphRateLimitedError } from "./graph.js";
