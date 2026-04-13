import {
  GraphRateLimitedError,
  TokenExpiredError,
  type TeamsChatListPage,
  type TeamsClient,
  type TeamsMessagesPage,
} from "./teams.js";
import type { FetchLike } from "./http-graph-client.js";

export interface HttpTeamsClientOptions {
  readonly fetch: FetchLike;
  readonly baseUrl?: string;
  readonly preferMaxPageSize?: number;
}

const DEFAULT_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_PREFER_MAX_PAGE_SIZE = 50;

export class HttpTeamsClient implements TeamsClient {
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #preferMaxPageSize: number;

  constructor(opts: HttpTeamsClientOptions) {
    this.#fetch = opts.fetch;
    this.#baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.#preferMaxPageSize =
      opts.preferMaxPageSize ?? DEFAULT_PREFER_MAX_PAGE_SIZE;
  }

  async listChats(
    token: string,
    nextLink?: string,
  ): Promise<TeamsChatListPage> {
    const url = nextLink ?? `${this.#baseUrl}/me/chats`;
    return this.#request<TeamsChatListPage>(url, token);
  }

  async getChatMessages(
    token: string,
    chatId: string,
    opts: { sinceIso?: string; nextLink?: string },
  ): Promise<TeamsMessagesPage> {
    let url: string;
    if (opts.nextLink !== undefined) {
      url = opts.nextLink;
    } else {
      const encodedChatId = encodeURIComponent(chatId);
      const params = new URLSearchParams();
      params.set("$orderby", "lastModifiedDateTime desc");
      if (opts.sinceIso !== undefined) {
        params.set("$filter", `lastModifiedDateTime gt ${opts.sinceIso}`);
      }
      url = `${this.#baseUrl}/me/chats/${encodedChatId}/messages?${params.toString()}`;
    }
    return this.#request<TeamsMessagesPage>(url, token);
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
      throw new Error(`teams request failed: HTTP ${res.status}: ${body}`);
    }

    const text = await res.text();
    return JSON.parse(text) as T;
  }
}
