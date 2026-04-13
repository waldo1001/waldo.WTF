import type { Clock } from "../../clock.js";
import type { MessageStore } from "../../store/message-store.js";
import type { Message, SearchHit } from "../../store/types.js";
import { InvalidParamsError } from "./get-recent-activity.js";

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

export interface SearchParams {
  readonly query: string;
  readonly limit?: number;
}

export interface ProjectedSearchMessage {
  readonly id: string;
  readonly source: Message["source"];
  readonly account: string;
  readonly threadName?: string;
  readonly senderName?: string;
  readonly senderEmail?: string;
  readonly sentAt: string;
}

export interface ProjectedSearchHit {
  readonly message: ProjectedSearchMessage;
  readonly snippet: string;
  readonly rank: number;
}

export interface SearchResult {
  readonly count: number;
  readonly hits: readonly ProjectedSearchHit[];
}

export const SEARCH_TOOL = {
  name: "search",
  description:
    "Full-text search the message lake (FTS5, BM25-ranked). Returns hits with snippet and rank (lower = better). Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        description: "Free-text search query.",
      },
      limit: {
        type: "number",
        exclusiveMinimum: 0,
        maximum: MAX_SEARCH_LIMIT,
        description: `Max hits to return. Default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}.`,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

export async function handleSearch(
  store: MessageStore,
  _clock: Clock,
  params: SearchParams,
): Promise<SearchResult> {
  const query = params.query;
  if (typeof query !== "string") {
    throw new InvalidParamsError("query must be a string");
  }
  if (query.trim().length === 0) {
    throw new InvalidParamsError("query must be non-empty");
  }
  let limit = params.limit;
  if (limit === undefined) {
    limit = DEFAULT_SEARCH_LIMIT;
  } else {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
      throw new InvalidParamsError("limit must be a positive number");
    }
    if (limit > MAX_SEARCH_LIMIT) {
      throw new InvalidParamsError(`limit must be <= ${MAX_SEARCH_LIMIT}`);
    }
  }
  const hits = await store.searchMessages(query, limit);
  return {
    count: hits.length,
    hits: hits.map(project),
  };
}

function project(h: SearchHit): ProjectedSearchHit {
  const m = h.message;
  return {
    message: {
      id: m.id,
      source: m.source,
      account: m.account,
      ...(m.threadName !== undefined && { threadName: m.threadName }),
      ...(m.senderName !== undefined && { senderName: m.senderName }),
      ...(m.senderEmail !== undefined && { senderEmail: m.senderEmail }),
      sentAt: m.sentAt.toISOString(),
    },
    snippet: h.snippet,
    rank: h.rank,
  };
}
