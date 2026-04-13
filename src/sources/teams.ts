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

export interface TeamsChat {
  readonly id: string;
  readonly chatType?: string;
  readonly topic?: string | null;
  readonly lastUpdatedDateTime?: string;
}

export interface TeamsChatListPage {
  readonly value: readonly TeamsChat[];
  readonly "@odata.nextLink"?: string;
}

export interface TeamsMessagesPage {
  readonly value: readonly TeamsMessage[];
  readonly "@odata.nextLink"?: string;
}

/**
 * Polling Teams client. `/me/chats/getAllMessages/delta` is dead for
 * delegated auth (412 PreconditionFailed), so we enumerate chats and
 * pull per-chat messages.
 *
 * Error mapping (real HTTP impl translates; fakes throw directly):
 * - HTTP 401 → `TokenExpiredError`
 * - HTTP 429 → `GraphRateLimitedError`
 */
export interface TeamsClient {
  listChats(token: string, nextLink?: string): Promise<TeamsChatListPage>;
  getChatMessages(
    token: string,
    chatId: string,
    opts: { sinceIso?: string; nextLink?: string },
  ): Promise<TeamsMessagesPage>;
}

export { TokenExpiredError, GraphRateLimitedError } from "./graph.js";
