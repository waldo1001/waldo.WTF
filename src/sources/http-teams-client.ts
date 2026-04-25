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
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly maxRetries?: number;
}

const DEFAULT_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_PREFER_MAX_PAGE_SIZE = 50;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [250, 750] as const;
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export class HttpTeamsClient implements TeamsClient {
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #preferMaxPageSize: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #maxRetries: number;

  constructor(opts: HttpTeamsClientOptions) {
    this.#fetch = opts.fetch;
    this.#baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.#preferMaxPageSize =
      opts.preferMaxPageSize ?? DEFAULT_PREFER_MAX_PAGE_SIZE;
    this.#sleep =
      opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#random = opts.random ?? Math.random;
    this.#maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
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
    for (let attempt = 0; ; attempt++) {
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
        if (
          TRANSIENT_STATUSES.has(res.status) &&
          attempt < this.#maxRetries
        ) {
          const base = RETRY_BACKOFF_MS[attempt]!;
          await this.#sleep(base + this.#random() * base);
          continue;
        }
        throw new Error(`teams request failed: HTTP ${res.status}: ${body}`);
      }

      const text = await res.text();
      return JSON.parse(text) as T;
    }
  }
}
