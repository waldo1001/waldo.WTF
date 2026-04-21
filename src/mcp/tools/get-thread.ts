import type { Clock } from "../../clock.js";
import {
  DEFAULT_GET_THREAD_LIMIT,
  MAX_GET_THREAD_LIMIT,
  type MessageStore,
} from "../../store/message-store.js";
import type { ChatType, Message, MessageSource } from "../../store/types.js";
import { MAX_TOTAL_BODY_CHARS, projectBody } from "./body-projection.js";
import { InvalidParamsError } from "./get-recent-activity.js";

const SNIPPET_MAX = 280;

export interface GetThreadParams {
  readonly thread_id: string;
  readonly limit?: number;
  readonly include_body?: boolean;
}

export interface ProjectedThreadMessage {
  readonly id: string;
  readonly source: MessageSource;
  readonly account: string;
  readonly threadId?: string;
  readonly threadName?: string;
  readonly senderName?: string;
  readonly senderEmail?: string;
  readonly sentAt: string;
  readonly snippet?: string;
  readonly chatType?: ChatType;
  readonly replyToId?: string;
  readonly mentions?: readonly string[];
  readonly fromMe?: true;
  readonly body?: string;
  readonly bodyTruncated?: true;
}

export interface GetThreadResult {
  readonly count: number;
  readonly messages: readonly ProjectedThreadMessage[];
  readonly bodyBudgetExhausted?: true;
}

export const GET_THREAD_TOOL = {
  name: "get_thread",
  description: [
    "Return every message in a conversation (Teams chat) ordered oldest→newest. Pass the `threadId` field from a prior `search` / `get_recent_activity` result. Read-only.",
    "",
    'Prefer this over search when the user references a specific person or conversation by name ("did my wife send me...", "what did Gunter say about..."). A thread dump of ~50-200 messages is cheap and avoids the tokenization/language pitfalls of full-text search. Use search to find threads; use get_thread to read them.',
    "",
    'Pass `include_body: true` only when the user wants the *text* of the messages (e.g. "read me the mail", "what did it say", "summarize"). Otherwise the default (snippets only) is cheaper on context. Very long bodies are head-truncated and flagged with `bodyTruncated: true`; when the per-call body budget is exhausted, later messages are returned without a body and the response carries `bodyBudgetExhausted: true`.',
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      thread_id: {
        type: "string",
        minLength: 1,
        description:
          "Opaque thread id (Teams `chat.id`). Take it from a prior tool result.",
      },
      limit: {
        type: "number",
        exclusiveMinimum: 0,
        maximum: MAX_GET_THREAD_LIMIT,
        description: `Max messages to return. Default ${DEFAULT_GET_THREAD_LIMIT}, max ${MAX_GET_THREAD_LIMIT}.`,
      },
      include_body: {
        type: "boolean",
        description:
          "If true, project the plain-text body of each message (head-truncated per message; later messages may be omitted if the per-call budget is exhausted). Default false.",
      },
    },
    required: ["thread_id"],
    additionalProperties: false,
  },
} as const;

export async function handleGetThread(
  store: MessageStore,
  _clock: Clock,
  params: GetThreadParams,
): Promise<GetThreadResult> {
  const threadId = params.thread_id;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new InvalidParamsError("thread_id must be a non-empty string");
  }
  let limit: number | undefined = params.limit;
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
      throw new InvalidParamsError("limit must be a positive number");
    }
    if (limit > MAX_GET_THREAD_LIMIT) {
      throw new InvalidParamsError(
        `limit must be <= ${MAX_GET_THREAD_LIMIT}`,
      );
    }
  }
  if (
    params.include_body !== undefined &&
    typeof params.include_body !== "boolean"
  ) {
    throw new InvalidParamsError("include_body must be a boolean");
  }
  const rows = await store.getThread({
    threadId,
    ...(limit !== undefined && { limit }),
  });
  const includeBody = params.include_body === true;
  let remaining = MAX_TOTAL_BODY_CHARS;
  let exhausted = false;
  const messages = rows.map((m) => {
    const base = projectCore(m);
    if (!includeBody) return base;
    const bp = projectBody(m, remaining);
    if (bp.body === undefined) {
      if (m.body !== undefined) exhausted = true;
      return base;
    }
    remaining -= bp.consumed;
    return {
      ...base,
      body: bp.body,
      ...(bp.bodyTruncated && { bodyTruncated: bp.bodyTruncated }),
    };
  });
  return {
    count: rows.length,
    messages,
    ...(exhausted && { bodyBudgetExhausted: true as const }),
  };
}

function snippetFrom(m: Message): string | undefined {
  const raw = m.body ?? m.bodyHtml;
  if (raw === undefined) return undefined;
  return raw.length > SNIPPET_MAX ? raw.slice(0, SNIPPET_MAX) : raw;
}

function projectCore(m: Message): ProjectedThreadMessage {
  const snippet = snippetFrom(m);
  return {
    id: m.id,
    source: m.source,
    account: m.account,
    ...(m.threadId !== undefined && { threadId: m.threadId }),
    ...(m.threadName !== undefined && { threadName: m.threadName }),
    ...(m.senderName !== undefined && { senderName: m.senderName }),
    ...(m.senderEmail !== undefined && { senderEmail: m.senderEmail }),
    sentAt: m.sentAt.toISOString(),
    ...(snippet !== undefined && { snippet }),
    ...(m.chatType !== undefined && { chatType: m.chatType }),
    ...(m.replyToId !== undefined && { replyToId: m.replyToId }),
    ...(m.mentions !== undefined && { mentions: m.mentions }),
    ...(m.fromMe === true && { fromMe: true as const }),
  };
}
