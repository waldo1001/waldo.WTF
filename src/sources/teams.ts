export interface TeamsUser {
  readonly id?: string;
  readonly displayName?: string;
  readonly userPrincipalName?: string;
}

export interface TeamsMentionedEntity {
  readonly user?: TeamsUser;
}

export interface TeamsMention {
  readonly id?: number;
  readonly mentionText?: string;
  readonly mentioned?: TeamsMentionedEntity;
}

export interface TeamsChannelIdentity {
  readonly teamId?: string;
  readonly channelId?: string;
}

export interface TeamsMessage {
  readonly id: string;
  readonly createdDateTime: string;
  readonly chatId?: string;
  readonly messageType?: string;
  readonly replyToId?: string | null;
  readonly from?: { readonly user?: TeamsUser } | null;
  readonly body?: {
    readonly contentType?: "text" | "html";
    readonly content?: string;
  };
  readonly mentions?: readonly TeamsMention[];
  readonly channelIdentity?: TeamsChannelIdentity | null;
  readonly deletedDateTime?: string | null;
  readonly "@removed"?: { readonly reason: string };
}

export interface TeamsDeltaResponse {
  readonly value: readonly TeamsMessage[];
  readonly "@odata.nextLink"?: string;
  readonly "@odata.deltaLink"?: string;
}

/**
 * Fetch a Teams delta page. `url` is either the initial endpoint
 * (`/me/chats/getAllMessages/delta`) or a nextLink/deltaLink from a
 * prior call. Implementations MUST NOT mutate `url`.
 *
 * Error mapping (real HTTP impl will translate; fakes throw directly):
 * - HTTP 401 → `TokenExpiredError`
 * - HTTP 429 → `GraphRateLimitedError`
 * - HTTP 410 → `DeltaTokenInvalidError`
 */
export interface TeamsClient {
  getDelta(url: string, token: string): Promise<TeamsDeltaResponse>;
}

export {
  TokenExpiredError,
  GraphRateLimitedError,
  DeltaTokenInvalidError,
} from "./graph.js";
