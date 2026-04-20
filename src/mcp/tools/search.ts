import type { Clock } from "../../clock.js";
import type { MessageStore } from "../../store/message-store.js";
import type { ChatType, Message, SearchHit } from "../../store/types.js";
import { MAX_TOTAL_BODY_CHARS, projectBody } from "./body-projection.js";
import { InvalidParamsError } from "./get-recent-activity.js";

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

export interface SearchParams {
  readonly query: string;
  readonly limit?: number;
  readonly include_body?: boolean;
  readonly include_muted?: boolean;
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
  readonly body?: string;
  readonly bodyTruncated?: true;
}

export interface ProjectedSearchHit {
  readonly message: ProjectedSearchMessage;
  readonly snippet: string;
  readonly rank: number;
}

export interface SearchResult {
  readonly count: number;
  readonly hits: readonly ProjectedSearchHit[];
  readonly bodyBudgetExhausted?: true;
  readonly muted_count: number;
  readonly steering_hint?: string;
}

export const SEARCH_TOOL = {
  name: "search",
  description: [
    "Full-text search the message lake (FTS5, BM25-ranked). Returns hits with snippet and rank (lower = better). Read-only.",
    "",
    'Language matters. The lake contains messages in multiple languages (notably Dutch and English for Belgian users). FTS5 tokenizes on word boundaries, so compound words in Germanic languages won\'t match their English equivalents — "spaghettisaus" ≠ "spaghetti sauce", "boodschappenlijst" ≠ "shopping list", "verjaardag" ≠ "birthday". When searching for personal, family, or household content, try the user\'s native language first or in parallel. If a query returns zero hits, try: (1) the other language, (2) a root/stem rather than a compound (e.g. "saus" instead of "spaghettisaus"), (3) a related noun from the same context ("gehakt", "ajuin") before concluding the content doesn\'t exist.',
    "",
    "Empty results are not proof of absence. They usually mean the query didn't match the indexed tokens. Widen before concluding.",
    "",
    'Pass `include_body: true` only when the user wants the full text of the matched messages (e.g. "read me the mail", "quote what it said"). Otherwise snippets are enough. Bodies are head-truncated per message (flagged with `bodyTruncated: true`) and the response carries `bodyBudgetExhausted: true` when later hits had to be returned without a body to protect context.',
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
      include_body: {
        type: "boolean",
        description:
          "If true, project the plain-text body of each hit (head-truncated per message; later hits may be omitted if the per-call budget is exhausted). Default false.",
      },
      include_muted: {
        type: "boolean",
        description:
          "If true, include hits matching steering rules. Default false (hard-exclude muted items).",
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
  if (
    params.include_body !== undefined &&
    typeof params.include_body !== "boolean"
  ) {
    throw new InvalidParamsError("include_body must be a boolean");
  }
  if (
    params.include_muted !== undefined &&
    typeof params.include_muted !== "boolean"
  ) {
    throw new InvalidParamsError("include_muted must be a boolean");
  }
  const includeMuted = params.include_muted === true;
  const { hits, mutedCount } = await store.searchMessages(query, limit, {
    includeMuted,
  });
  const includeBody = params.include_body === true;
  let remaining = MAX_TOTAL_BODY_CHARS;
  let exhausted = false;
  const projected = hits.map((h) => {
    const base = projectCore(h);
    if (!includeBody) return base;
    const bp = projectBody(h.message, remaining);
    if (bp.body === undefined) {
      if (h.message.body !== undefined) exhausted = true;
      return base;
    }
    remaining -= bp.consumed;
    return {
      ...base,
      message: {
        ...base.message,
        body: bp.body,
        ...(bp.bodyTruncated && { bodyTruncated: bp.bodyTruncated }),
      },
    };
  });
  const hint =
    !includeMuted && mutedCount > 0
      ? `${mutedCount} hit(s) hidden by steering rules. Pass include_muted=true to see them, or call get_steering to review active rules.`
      : undefined;
  return {
    count: hits.length,
    hits: projected,
    ...(exhausted && { bodyBudgetExhausted: true as const }),
    muted_count: mutedCount,
    ...(hint !== undefined && { steering_hint: hint }),
  };
}

function projectCore(h: SearchHit): ProjectedSearchHit {
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
