import type { FetchLike } from "./http-graph-client.js";
import { GraphRateLimitedError, TokenExpiredError } from "./graph.js";
import type {
  VivaClient,
  VivaNetwork,
  VivaCommunity,
  VivaThread,
  VivaThreadPage,
  VivaPost,
  VivaPostPage,
} from "./viva.js";
import type { YammerMessagesResponse, YammerUser } from "./yammer.js";

const BASE = "https://www.yammer.com/api/v1";
const DEFAULT_RETRY_AFTER_SECONDS = 6;

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function fetchAndCheck(
  fetch: FetchLike,
  url: string,
  token: string,
): Promise<string> {
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 401) throw new TokenExpiredError("Yammer 401");
  if (res.status === 429) {
    const raw = res.headers.get("Retry-After");
    const parsed = raw !== null ? parseInt(raw, 10) : NaN;
    throw new GraphRateLimitedError(
      Number.isFinite(parsed) ? parsed : DEFAULT_RETRY_AFTER_SECONDS,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    const body = await res.text();
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const safe = body.replace(new RegExp(escaped, "g"), "[REDACTED]");
    throw new Error(`Yammer ${res.status}: ${safe.slice(0, 200)}`);
  }
  return res.text();
}

function sid(id: string | number): string {
  return String(id);
}

function minId(ids: ReadonlyArray<string | number>): string | number {
  return ids.reduce<string | number>(
    (min, id) => (Number(id) < Number(min) ? id : min),
    ids[0]!,
  );
}

// Parse Yammer JSON preserving exact digit strings for integer-valued fields.
// JSON.parse loses precision for numbers > Number.MAX_SAFE_INTEGER (2^53-1).
// The TC39 "JSON.parse source text access" proposal (ES2025, Node 22+) lets the
// reviver read the raw source text before coercion to double.
function parseYammer<T>(text: string): T {
  return JSON.parse(text, function (_key, value, context) {
    if (
      typeof value === "number" &&
      typeof context?.source === "string" &&
      /^\d+$/.test(context.source)
    ) {
      return context.source; // keep as exact string, not rounded double
    }
    return value;
  }) as T;
}

function resolveUser(
  senderId: string | number,
  refs: YammerMessagesResponse["references"],
): ({ type: "user" } & YammerUser) | undefined {
  const senderKey = String(senderId);
  return refs.find(
    (r): r is { type: "user" } & YammerUser =>
      r.type === "user" && String(r.id) === senderKey,
  ) as ({ type: "user" } & YammerUser) | undefined;
}

export class HttpYammerClient implements VivaClient {
  private readonly fetch: FetchLike;

  constructor(opts: { fetch: FetchLike }) {
    this.fetch = opts.fetch;
  }

  async listNetworks(token: string): Promise<readonly VivaNetwork[]> {
    const text = await fetchAndCheck(
      this.fetch,
      `${BASE}/networks/current.json`,
      token,
    );
    const raw = parseYammer(text) as Array<{
      id: number;
      name: string;
      permalink: string;
    }>;
    return raw.map((n) => ({ id: sid(n.id), name: n.name, permalink: n.permalink }));
  }

  async listCommunities(
    token: string,
    networkId: string,
  ): Promise<readonly VivaCommunity[]> {
    const all: VivaCommunity[] = [];
    let page = 1;
    for (;;) {
      const text = await fetchAndCheck(
        this.fetch,
        `${BASE}/groups.json?network_id=${networkId}&page=${page}`,
        token,
      );
      const raw = parseYammer(text) as Array<{
        id: number;
        full_name: string;
        network_id: number;
        description?: string;
      }>;
      if (raw.length === 0) break;
      for (const g of raw) {
        all.push({
          id: sid(g.id),
          displayName: g.full_name,
          networkId: sid(g.network_id),
          ...(g.description !== undefined && { description: g.description }),
        });
      }
      page += 1;
    }
    return all;
  }

  async listThreads(
    token: string,
    communityId: string,
    opts: { olderThan?: string },
  ): Promise<VivaThreadPage> {
    let url = `${BASE}/messages/in_group/${communityId}.json?threaded=extended`;
    if (opts.olderThan !== undefined) url += `&older_than=${opts.olderThan}`;
    const text = await fetchAndCheck(this.fetch, url, token);
    const raw = parseYammer(text) as YammerMessagesResponse;
    const msgs = raw.messages;
    if (msgs.length === 0) return { value: [], olderThanCursor: undefined };

    const threads: VivaThread[] = msgs.map((m) => ({
      id: sid(m.id),
      lastPostedDateTime: m.created_at,
    }));
    return {
      value: threads,
      olderThanCursor: sid(minId(msgs.map((m) => m.id))),
    };
  }

  async listPosts(
    token: string,
    threadId: string,
    opts: { olderThan?: string },
  ): Promise<VivaPostPage> {
    let url = `${BASE}/messages/in_thread/${threadId}.json`;
    if (opts.olderThan !== undefined) url += `?older_than=${opts.olderThan}`;
    const text = await fetchAndCheck(this.fetch, url, token);
    const raw = parseYammer(text) as YammerMessagesResponse;
    const msgs = raw.messages;
    if (msgs.length === 0) return { value: [], olderThanCursor: undefined };

    const posts: VivaPost[] = msgs.map((m) => {
      const user = resolveUser(m.sender_id, raw.references);
      const body = m.body;
      return {
        id: sid(m.id),
        conversationId: sid(m.thread_id),
        createdDateTime: m.created_at,
        ...(user !== undefined && {
          from: {
            user: {
              id: sid(user.id),
              ...(user.full_name !== undefined && { displayName: user.full_name }),
              ...(user.email !== undefined && {
                userPrincipalName: user.email,
              }),
            },
          },
        }),
        ...(body.plain !== undefined
          ? { body: { contentType: "text" as const, content: body.plain } }
          : body.rich !== undefined
            ? { body: { contentType: "html" as const, content: body.rich } }
            : {}),
      };
    });
    return {
      value: posts,
      olderThanCursor: sid(minId(msgs.map((m) => m.id))),
    };
  }
}
