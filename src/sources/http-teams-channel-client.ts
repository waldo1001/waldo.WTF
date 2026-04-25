import type { FetchLike } from "./http-graph-client.js";
import {
  GraphRateLimitedError,
  TokenExpiredError,
  type TeamsChannel,
  type TeamsChannelClient,
  type TeamsChannelMessagesPage,
  type TeamsJoinedTeam,
} from "./teams-channel.js";

export interface HttpTeamsChannelClientOptions {
  readonly fetch: FetchLike;
  readonly baseUrl?: string;
  readonly preferMaxPageSize?: number;
}

interface PagedResponse<T> {
  readonly value: readonly T[];
  readonly "@odata.nextLink"?: string;
}

const DEFAULT_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_PREFER_MAX_PAGE_SIZE = 50;

export class HttpTeamsChannelClient implements TeamsChannelClient {
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #preferMaxPageSize: number;

  constructor(opts: HttpTeamsChannelClientOptions) {
    this.#fetch = opts.fetch;
    this.#baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.#preferMaxPageSize =
      opts.preferMaxPageSize ?? DEFAULT_PREFER_MAX_PAGE_SIZE;
  }

  async *listJoinedTeams(token: string): AsyncIterable<TeamsJoinedTeam> {
    let url: string | undefined = `${this.#baseUrl}/me/joinedTeams`;
    while (url !== undefined) {
      const page: PagedResponse<TeamsJoinedTeam> = await this.#request<
        PagedResponse<TeamsJoinedTeam>
      >(url, token);
      for (const t of page.value) yield t;
      url = page["@odata.nextLink"];
    }
  }

  async *listChannels(
    token: string,
    teamId: string,
  ): AsyncIterable<TeamsChannel> {
    const encodedTeamId = encodeURIComponent(teamId);
    let url: string | undefined = `${this.#baseUrl}/teams/${encodedTeamId}/channels`;
    while (url !== undefined) {
      const page: PagedResponse<TeamsChannel> = await this.#request<
        PagedResponse<TeamsChannel>
      >(url, token);
      for (const c of page.value) yield c;
      url = page["@odata.nextLink"];
    }
  }

  async getChannelMessagesDelta(
    token: string,
    teamId: string,
    channelId: string,
    opts: {
      readonly deltaLink?: string;
      readonly nextLink?: string;
      readonly sinceIso?: string;
    },
  ): Promise<TeamsChannelMessagesPage> {
    let url: string;
    if (opts.deltaLink !== undefined) {
      url = opts.deltaLink;
    } else if (opts.nextLink !== undefined) {
      url = opts.nextLink;
    } else {
      const encodedTeamId = encodeURIComponent(teamId);
      const encodedChannelId = encodeURIComponent(channelId);
      const params = new URLSearchParams();
      params.set("$expand", "replies");
      if (opts.sinceIso !== undefined) {
        params.set("$filter", `lastModifiedDateTime gt ${opts.sinceIso}`);
      }
      url = `${this.#baseUrl}/teams/${encodedTeamId}/channels/${encodedChannelId}/messages/delta?${params.toString()}`;
    }
    return this.#request<TeamsChannelMessagesPage>(url, token);
  }

  async #request<T>(url: string, token: string): Promise<T> {
    const res = await this.#fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        Prefer: `odata.maxpagesize=${this.#preferMaxPageSize}`,
      },
    });

    if (res.status === 401) throw new TokenExpiredError();
    if (res.status === 429) {
      const header = res.headers.get("Retry-After");
      const parsed = header ? Number.parseInt(header, 10) : Number.NaN;
      const retryAfterSeconds =
        Number.isFinite(parsed) && parsed >= 0 ? parsed : 60;
      throw new GraphRateLimitedError(retryAfterSeconds);
    }
    if (res.status < 200 || res.status >= 300) {
      const raw = (await res.text()).slice(0, 200);
      const body = raw.split(token).join("[redacted]");
      throw new Error(
        `teams-channel request failed: HTTP ${res.status}: ${body}`,
      );
    }
    const text = await res.text();
    return JSON.parse(text) as T;
  }
}
