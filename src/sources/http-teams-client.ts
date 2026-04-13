import {
  DeltaTokenInvalidError,
  GraphRateLimitedError,
  TokenExpiredError,
  type TeamsClient,
  type TeamsDeltaResponse,
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

  async getDelta(url: string, token: string): Promise<TeamsDeltaResponse> {
    const resolvedUrl = /^https?:\/\//i.test(url) ? url : `${this.#baseUrl}${url}`;
    const res = await this.#fetch(resolvedUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        Prefer: `odata.maxpagesize=${this.#preferMaxPageSize}`,
      },
    });

    if (res.status === 401) throw new TokenExpiredError();
    if (res.status === 410) throw new DeltaTokenInvalidError();
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
    return JSON.parse(text) as TeamsDeltaResponse;
  }
}
