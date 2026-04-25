import type { TeamsMention } from "./teams.js";

export interface TeamsChannelMessageBody {
  readonly contentType?: "text" | "html";
  readonly content?: string;
}

export interface TeamsChannelUser {
  readonly id?: string;
  readonly displayName?: string;
  readonly userPrincipalName?: string;
}

export interface TeamsChannelMessage {
  readonly id: string;
  readonly createdDateTime: string;
  readonly lastModifiedDateTime?: string;
  readonly messageType?: string;
  readonly replyToId?: string | null;
  readonly from?: { readonly user?: TeamsChannelUser } | null;
  readonly body?: TeamsChannelMessageBody;
  readonly mentions?: readonly TeamsMention[];
  readonly deletedDateTime?: string | null;
  readonly "@removed"?: { readonly reason: string };
  readonly replies?: readonly TeamsChannelMessage[];
  readonly "replies@odata.count"?: number;
}

export interface TeamsJoinedTeam {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
}

export interface TeamsChannel {
  readonly id: string;
  readonly displayName: string;
  readonly membershipType?: "standard" | "private" | "shared";
}

export interface TeamsChannelMessagesPage {
  readonly value: readonly TeamsChannelMessage[];
  readonly "@odata.nextLink"?: string;
  readonly "@odata.deltaLink"?: string;
}

/**
 * Channels client. Discovery + delta with $expand=replies.
 *
 * Error mapping (real HTTP impl translates; fakes throw directly):
 * - HTTP 401 → TokenExpiredError
 * - HTTP 429 → GraphRateLimitedError
 */
export interface TeamsChannelClient {
  listJoinedTeams(token: string): AsyncIterable<TeamsJoinedTeam>;
  listChannels(token: string, teamId: string): AsyncIterable<TeamsChannel>;
  getChannelMessagesDelta(
    token: string,
    teamId: string,
    channelId: string,
    opts: {
      readonly deltaLink?: string;
      readonly nextLink?: string;
      readonly sinceIso?: string;
    },
  ): Promise<TeamsChannelMessagesPage>;
}

export { TokenExpiredError, GraphRateLimitedError } from "./graph.js";
