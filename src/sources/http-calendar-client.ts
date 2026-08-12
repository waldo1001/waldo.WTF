import {
  mapGraphEventToCalendarEvent,
  type CalendarClient,
  type CalendarViewDeltaInput,
  type CalendarViewDeltaPage,
  type GraphCalendarEvent,
} from "./calendar.js";
import {
  DeltaTokenInvalidError,
  GraphRateLimitedError,
  TokenExpiredError,
} from "./graph.js";
import type { FetchLike } from "./http-graph-client.js";

// CalendarViewDeltaInput carries no token (unlike TeamsClient's
// token-per-call-argument shape) — the client resolves its own token per
// call via this callback, keyed by account. `forceRefresh` is threaded
// through so the client can self-heal a 401 (MSAL's cached token looked
// valid but Graph rejected it — the same "same-tick self-heal" scenario
// sync-viva.ts handles at its own layer): the sync loop has no way to
// force a fresh token into an already-constructed client, so that retry
// has to live here instead.
export type GetCalendarAccessToken = (
  account: string,
  scope: string,
  forceRefresh: boolean,
) => Promise<string>;

export interface HttpCalendarClientOptions {
  readonly fetch: FetchLike;
  readonly getAccessToken: GetCalendarAccessToken;
  readonly scope?: string;
  readonly baseUrl?: string;
  readonly preferMaxPageSize?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly maxRetries?: number;
}

interface GraphCalendarViewDeltaEntry extends GraphCalendarEvent {
  readonly "@removed"?: { readonly reason: string };
}

interface GraphCalendarViewDeltaResponse {
  readonly value: readonly GraphCalendarViewDeltaEntry[];
  readonly "@odata.nextLink"?: string;
  readonly "@odata.deltaLink"?: string;
}

const DEFAULT_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_PREFER_MAX_PAGE_SIZE = 50;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_SCOPE = "https://graph.microsoft.com/Calendars.Read";
const RETRY_BACKOFF_MS = [250, 750] as const;
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export class HttpCalendarClient implements CalendarClient {
  readonly #fetch: FetchLike;
  readonly #getAccessToken: GetCalendarAccessToken;
  readonly #scope: string;
  readonly #baseUrl: string;
  readonly #preferMaxPageSize: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #maxRetries: number;

  constructor(opts: HttpCalendarClientOptions) {
    this.#fetch = opts.fetch;
    this.#getAccessToken = opts.getAccessToken;
    this.#scope = opts.scope ?? DEFAULT_SCOPE;
    this.#baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.#preferMaxPageSize =
      opts.preferMaxPageSize ?? DEFAULT_PREFER_MAX_PAGE_SIZE;
    this.#sleep =
      opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#random = opts.random ?? Math.random;
    this.#maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async listCalendarViewDelta(
    input: CalendarViewDeltaInput,
  ): Promise<CalendarViewDeltaPage> {
    let url: string;
    if (input.cursor !== undefined) {
      if (!/^https:\/\/graph\.microsoft\.com\//i.test(input.cursor)) {
        throw new Error(
          `HttpCalendarClient: refusing cursor with unexpected host: ${input.cursor}`,
        );
      }
      url = input.cursor;
    } else {
      const params = new URLSearchParams();
      if (input.windowStartIso !== undefined) {
        params.set("startDateTime", input.windowStartIso);
      }
      if (input.windowEndIso !== undefined) {
        params.set("endDateTime", input.windowEndIso);
      }
      url = `${this.#baseUrl}/me/calendarView/delta?${params.toString()}`;
    }

    const raw = await this.#requestWithTokenRetry<GraphCalendarViewDeltaResponse>(
      url,
      input.account,
    );

    const events = [];
    const removedIds: string[] = [];
    for (const entry of raw.value) {
      if (entry["@removed"] !== undefined) {
        removedIds.push(entry.id);
      } else {
        events.push(mapGraphEventToCalendarEvent(entry, input.account));
      }
    }

    return {
      events,
      removedIds,
      ...(raw["@odata.nextLink"] !== undefined && {
        nextLink: raw["@odata.nextLink"],
      }),
      ...(raw["@odata.deltaLink"] !== undefined && {
        deltaLink: raw["@odata.deltaLink"],
      }),
    };
  }

  // 401 → force-refresh the token once and retry the same request. A
  // second 401 (forceRefresh already applied) surfaces as
  // TokenExpiredError to the caller — mirrors sync-viva.ts's per-tenant
  // self-heal, just relocated here since this client (unlike TeamsClient)
  // owns its own token resolution.
  async #requestWithTokenRetry<T>(url: string, account: string): Promise<T> {
    const token = await this.#getAccessToken(account, this.#scope, false);
    try {
      return await this.#request<T>(url, token);
    } catch (err) {
      if (!(err instanceof TokenExpiredError)) throw err;
      const freshToken = await this.#getAccessToken(
        account,
        this.#scope,
        true,
      );
      return this.#request<T>(url, freshToken);
    }
  }

  async #request<T>(url: string, token: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.#fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          Prefer: [
            'outlook.timezone="UTC"',
            'outlook.body-content-type="text"',
            `odata.maxpagesize=${this.#preferMaxPageSize}`,
          ].join(", "),
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
        if (
          TRANSIENT_STATUSES.has(res.status) &&
          attempt < this.#maxRetries
        ) {
          const base = RETRY_BACKOFF_MS[attempt]!;
          await this.#sleep(base + this.#random() * base);
          continue;
        }
        throw new Error(
          `calendar request failed: HTTP ${res.status}: ${body}`,
        );
      }

      const text = await res.text();
      return JSON.parse(text) as T;
    }
  }
}
