import type { Clock } from "../../clock.js";
import type { MessageStore } from "../../store/message-store.js";
import type { ChatType, Message, SearchHit } from "../../store/types.js";
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
  readonly threadId?: string;
  readonly threadName?: string;
  readonly senderName?: string;
  readonly senderEmail?: string;
  readonly sentAt: string;
  readonly chatType?: ChatType;
  readonly replyToId?: string;
  readonly mentions?: readonly string[];
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
  description: [
    "Full-text search the message lake (FTS5, BM25-ranked). Returns hits with snippet and rank (lower = better). Read-only.",
    "",
    'Language matters. The lake contains messages in multiple languages (notably Dutch and English for Belgian users). FTS5 tokenizes on word boundaries, so compound words in Germanic languages won\'t match their English equivalents — "spaghettisaus" ≠ "spaghetti sauce", "boodschappenlijst" ≠ "shopping list", "verjaardag" ≠ "birthday". When searching for personal, family, or household content, try the user\'s native language first or in parallel. If a query returns zero hits, try: (1) the other language, (2) a root/stem rather than a compound (e.g. "saus" instead of "spaghettisaus"), (3) a related noun from the same context ("gehakt", "ajuin") before concluding the content doesn\'t exist.',
    "",
    "Empty results are not proof of absence. They usually mean the query didn't match the indexed tokens. Widen before concluding.",
  ].join("\n"),
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
      ...(m.threadId !== undefined && { threadId: m.threadId }),
      ...(m.threadName !== undefined && { threadName: m.threadName }),
      ...(m.senderName !== undefined && { senderName: m.senderName }),
      ...(m.senderEmail !== undefined && { senderEmail: m.senderEmail }),
      sentAt: m.sentAt.toISOString(),
      ...(m.chatType !== undefined && { chatType: m.chatType }),
      ...(m.replyToId !== undefined && { replyToId: m.replyToId }),
      ...(m.mentions !== undefined && { mentions: m.mentions }),
    },
    snippet: h.snippet,
    rank: h.rank,
  };
}
