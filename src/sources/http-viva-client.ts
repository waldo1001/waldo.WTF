import {
  GraphRateLimitedError,
  TokenExpiredError,
  type VivaClient,
  type VivaCommunityListPage,
  type VivaPostPage,
  type VivaThreadPage,
} from "./viva.js";
import type { FetchLike } from "./http-graph-client.js";

export interface HttpVivaClientOptions {
  readonly fetch: FetchLike;
  readonly baseUrl?: string;
  readonly preferMaxPageSize?: number;
}

const DEFAULT_BASE_URL = "https://graph.microsoft.com/beta";
const DEFAULT_PREFER_MAX_PAGE_SIZE = 50;

export class HttpVivaClient implements VivaClient {
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #preferMaxPageSize: number;

  constructor(opts: HttpVivaClientOptions) {
    this.#fetch = opts.fetch;
    this.#baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.#preferMaxPageSize =
      opts.preferMaxPageSize ?? DEFAULT_PREFER_MAX_PAGE_SIZE;
  }

  async listCommunities(
    token: string,
    nextLink?: string,
  ): Promise<VivaCommunityListPage> {
    const url = nextLink ?? `${this.#baseUrl}/employeeExperience/communities`;
    return this.#request<VivaCommunityListPage>(url, token);
  }

  async listThreads(
    token: string,
    communityId: string,
    opts: { sinceIso?: string; nextLink?: string },
  ): Promise<VivaThreadPage> {
    let url: string;
    if (opts.nextLink !== undefined) {
      url = opts.nextLink;
    } else {
      const encodedCommunity = encodeURIComponent(communityId);
      const params = new URLSearchParams();
      params.set("$orderby", "lastPostedDateTime desc");
      if (opts.sinceIso !== undefined) {
        params.set("$filter", `lastPostedDateTime gt ${opts.sinceIso}`);
      }
      url = `${this.#baseUrl}/employeeExperience/communities/${encodedCommunity}/threads?${params.toString()}`;
    }
    return this.#request<VivaThreadPage>(url, token);
  }

  async listPosts(
    token: string,
    communityId: string,
    threadId: string,
    opts: { nextLink?: string },
  ): Promise<VivaPostPage> {
    const url =
      opts.nextLink ??
      `${this.#baseUrl}/employeeExperience/communities/${encodeURIComponent(
        communityId,
      )}/threads/${encodeURIComponent(threadId)}/posts`;
    return this.#request<VivaPostPage>(url, token);
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
      throw new Error(`viva request failed: HTTP ${res.status}: ${body}`);
    }

    const text = await res.text();
    return JSON.parse(text) as T;
  }
}
