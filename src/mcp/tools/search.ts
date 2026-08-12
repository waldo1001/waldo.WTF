import type { Clock } from "../../clock.js";
import type { MessageStore } from "../../store/message-store.js";
import type {
  ChatType,
  Message,
  SearchHit,
  TranscriptSearchHit,
} from "../../store/types.js";
import { MAX_TOTAL_BODY_CHARS, projectBody } from "./body-projection.js";
import { InvalidParamsError } from "./get-recent-activity.js";

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

export type SearchKind = "message" | "transcript";

const KNOWN_KINDS: ReadonlySet<SearchKind> = new Set(["message", "transcript"]);
const DEFAULT_KINDS: readonly SearchKind[] = ["message"];

export interface SearchParams {
  readonly query?: string;
  readonly limit?: number;
  readonly include_body?: boolean;
  readonly include_muted?: boolean;
  readonly sender_email?: string;
  readonly sender_name?: string;
  readonly after?: string;
  readonly before?: string;
  readonly kinds?: readonly SearchKind[];
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

export interface ProjectedTranscriptSegment {
  readonly eventId: string;
  readonly transcriptId: string;
  readonly sequence: number;
  readonly speakerEmail?: string;
  readonly speakerDisplayName?: string;
  readonly startOffsetMs: number;
  readonly endOffsetMs: number;
  readonly text: string;
}

export type UnifiedSearchHit =
  | {
      readonly kind: "message";
      readonly message: ProjectedSearchMessage;
      readonly snippet: string;
      readonly rank: number;
    }
  | {
      readonly kind: "transcript";
      readonly segment: ProjectedTranscriptSegment;
      readonly snippet: string;
      readonly rank: number;
    };

export interface LegacySearchResult {
  readonly count: number;
  readonly hits: readonly ProjectedSearchHit[];
  readonly bodyBudgetExhausted?: true;
  readonly muted_count: number;
  readonly steering_hint?: string;
}

export interface UnifiedSearchResult {
  readonly count: number;
  readonly hits: readonly UnifiedSearchHit[];
  readonly bodyBudgetExhausted?: true;
  readonly muted_count: number;
  readonly steering_hint?: string;
}

export type SearchResult = LegacySearchResult | UnifiedSearchResult;

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
    "",
    'Default kinds is ["message"] — the original response shape (hits carry `message` directly). Pass kinds: ["transcript"] or ["message", "transcript"] to also search meeting transcripts (requires --transcripts-enable for the account); each hit then carries a `kind` field plus either `message` or `segment`. `sender_email`/`sender_name`/`after`/`before`/`include_body` are message-only filters — transcript hits only use `query`, and a transcript-kind search with no query text returns zero transcript hits rather than an error.',
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        description:
          "Free-text search query. Optional when sender_email or sender_name is set, but at least one of query/sender_email/sender_name is required.",
      },
      kinds: {
        type: "array",
        items: { type: "string", enum: ["message", "transcript"] },
        minItems: 1,
        description:
          'Which item kinds to include. Default ["message"] (original response shape). Pass ["transcript"] or ["message", "transcript"] to also search meeting transcripts.',
      },
      sender_email: {
        type: "string",
        minLength: 1,
        description:
          "Structured filter on the sender's email (case-insensitive exact match on the From header, independent of FTS). Useful for 'what has <person> sent me' questions where name/email may not appear in the body.",
      },
      sender_name: {
        type: "string",
        minLength: 1,
        description:
          "Structured filter on the sender's display name (case-insensitive substring match). Handles display-name variations like 'Gunter Peeters' vs 'Peeters, Gunter'.",
      },
      after: {
        type: "string",
        description:
          "Inclusive lower bound on sent_at, ISO 8601 (e.g. '2026-03-21T00:00:00Z' or '2026-03-21').",
      },
      before: {
        type: "string",
        description:
          "Exclusive upper bound on sent_at, ISO 8601.",
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
    additionalProperties: false,
  },
} as const;

export async function handleSearch(
  store: MessageStore,
  _clock: Clock,
  params: SearchParams,
): Promise<SearchResult> {
  const query = params.query;
  const queryProvided = query !== undefined;
  if (queryProvided) {
    if (typeof query !== "string") {
      throw new InvalidParamsError("query must be a string");
    }
    if (query.trim().length === 0) {
      throw new InvalidParamsError("query must be non-empty");
    }
  }
  const senderEmail = validateOptionalNonEmptyString(
    params.sender_email,
    "sender_email",
  );
  const senderName = validateOptionalNonEmptyString(
    params.sender_name,
    "sender_name",
  );
  if (
    !queryProvided &&
    senderEmail === undefined &&
    senderName === undefined
  ) {
    throw new InvalidParamsError(
      "at least one of query, sender_email, or sender_name is required",
    );
  }
  const after = validateOptionalIso(params.after, "after");
  const before = validateOptionalIso(params.before, "before");
  if (
    after !== undefined &&
    before !== undefined &&
    after.getTime() > before.getTime()
  ) {
    throw new InvalidParamsError("after must be <= before");
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
  const kinds = normalizeKinds(params.kinds);
  const includeMuted = params.include_muted === true;
  const includeBody = params.include_body === true;
  const storeQuery = queryProvided ? (query as string) : "";

  if (kinds.length === 1 && kinds[0] === "message") {
    const messages = await searchMessagesProjected(store, storeQuery, limit, {
      includeMuted,
      includeBody,
      ...(senderEmail !== undefined && { senderEmail }),
      ...(senderName !== undefined && { senderName }),
      ...(after !== undefined && { after }),
      ...(before !== undefined && { before }),
    });
    const hint = mutedHint(includeMuted, messages.mutedCount);
    return {
      count: messages.hits.length,
      hits: messages.hits,
      ...(messages.exhausted && { bodyBudgetExhausted: true as const }),
      muted_count: messages.mutedCount,
      ...(hint !== undefined && { steering_hint: hint }),
    };
  }

  // Past the legacy-only branch above, kinds always includes at least one
  // of "message"/"transcript" — sender_email/sender_name/after/before and
  // include_body only ever apply to the message side; a transcript-only
  // request with no query text simply yields zero transcript hits (the
  // store already treats an empty FTS phrase as "no match"), not an error.
  let messageHits: readonly UnifiedSearchHit[] = [];
  let mutedCount = 0;
  let exhausted = false;
  if (kinds.includes("message")) {
    const messages = await searchMessagesProjected(store, storeQuery, limit, {
      includeMuted,
      includeBody,
      ...(senderEmail !== undefined && { senderEmail }),
      ...(senderName !== undefined && { senderName }),
      ...(after !== undefined && { after }),
      ...(before !== undefined && { before }),
    });
    messageHits = messages.hits.map((h) => ({ kind: "message" as const, ...h }));
    mutedCount = messages.mutedCount;
    exhausted = messages.exhausted;
  }
  let transcriptHits: readonly UnifiedSearchHit[] = [];
  if (kinds.includes("transcript")) {
    const { hits } = await store.searchTranscriptSegments(storeQuery, limit);
    transcriptHits = hits.map((h) => ({
      kind: "transcript" as const,
      segment: projectSegment(h),
      snippet: h.snippet,
      rank: h.rank,
    }));
  }
  const hits = [...messageHits, ...transcriptHits];
  const hint = mutedHint(includeMuted, mutedCount);
  return {
    count: hits.length,
    hits,
    ...(exhausted && { bodyBudgetExhausted: true as const }),
    muted_count: mutedCount,
    ...(hint !== undefined && { steering_hint: hint }),
  };
}

function normalizeKinds(
  kinds: readonly SearchKind[] | undefined,
): readonly SearchKind[] {
  if (kinds === undefined) return DEFAULT_KINDS;
  if (kinds.length === 0) {
    throw new InvalidParamsError("kinds must not be empty");
  }
  for (const k of kinds) {
    if (!KNOWN_KINDS.has(k)) {
      throw new InvalidParamsError(`unknown kind: ${k}`);
    }
  }
  return kinds;
}

function mutedHint(includeMuted: boolean, mutedCount: number): string | undefined {
  return !includeMuted && mutedCount > 0
    ? `${mutedCount} hit(s) hidden by steering rules. Pass include_muted=true to see them, or call get_steering to review active rules.`
    : undefined;
}

interface SearchMessagesProjectedOptions {
  readonly includeMuted: boolean;
  readonly includeBody: boolean;
  readonly senderEmail?: string;
  readonly senderName?: string;
  readonly after?: Date;
  readonly before?: Date;
}

async function searchMessagesProjected(
  store: MessageStore,
  storeQuery: string,
  limit: number,
  opts: SearchMessagesProjectedOptions,
): Promise<{
  hits: readonly ProjectedSearchHit[];
  mutedCount: number;
  exhausted: boolean;
}> {
  const { hits, mutedCount } = await store.searchMessages(storeQuery, limit, {
    includeMuted: opts.includeMuted,
    ...(opts.senderEmail !== undefined && { senderEmail: opts.senderEmail }),
    ...(opts.senderName !== undefined && { senderName: opts.senderName }),
    ...(opts.after !== undefined && { after: opts.after }),
    ...(opts.before !== undefined && { before: opts.before }),
  });
  let remaining = MAX_TOTAL_BODY_CHARS;
  let exhausted = false;
  const projected = hits.map((h) => {
    const base = projectCore(h);
    if (!opts.includeBody) return base;
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
  return { hits: projected, mutedCount, exhausted };
}

function validateOptionalNonEmptyString(
  value: unknown,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new InvalidParamsError(`${name} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new InvalidParamsError(`${name} must be non-empty`);
  }
  return value;
}

function validateOptionalIso(
  value: unknown,
  name: string,
): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new InvalidParamsError(`${name} must be an ISO 8601 string`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidParamsError(`${name} must be a valid ISO 8601 string`);
  }
  return parsed;
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

function projectSegment(h: TranscriptSearchHit): ProjectedTranscriptSegment {
  const s = h.segment;
  return {
    eventId: s.eventId,
    transcriptId: s.transcriptId,
    sequence: s.sequence,
    ...(s.speakerEmail !== undefined && { speakerEmail: s.speakerEmail }),
    ...(s.speakerDisplayName !== undefined && {
      speakerDisplayName: s.speakerDisplayName,
    }),
    startOffsetMs: s.startOffsetMs,
    endOffsetMs: s.endOffsetMs,
    text: s.text,
  };
}
