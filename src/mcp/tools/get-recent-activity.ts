import type { Clock } from "../../clock.js";
import type { MessageStore } from "../../store/message-store.js";
import type { ChatType, Message, MessageSource } from "../../store/types.js";

export class InvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidParamsError";
  }
}

const KNOWN_SOURCES: ReadonlySet<MessageSource> = new Set([
  "outlook",
  "teams",
  "whatsapp",
]);

const MAX_HOURS = 720;
const DEFAULT_LIMIT = 200;
const SNIPPET_MAX = 280;

export interface GetRecentActivityParams {
  readonly hours: number;
  readonly sources?: readonly MessageSource[];
  readonly accounts?: readonly string[];
}

export interface ProjectedMessage {
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
}

export interface GetRecentActivityResult {
  readonly count: number;
  readonly messages: readonly ProjectedMessage[];
}

export const GET_RECENT_ACTIVITY_TOOL = {
  name: "get_recent_activity",
  description: [
    "Return recent messages from the lake within the last N hours, optionally filtered by source and/or account. Read-only.",
    "",
    'Use this as the source-of-truth probe when you need to confirm whether a given source (outlook, teams, whatsapp) has any recent data. A single call with sources: ["whatsapp"] and a wide hours window is the correct way to verify presence — more reliable than inferring from get_sync_status.',
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      hours: {
        type: "number",
        minimum: 0,
        exclusiveMinimum: 0,
        maximum: MAX_HOURS,
        description: "How many hours back to look. Max 720 (30 days).",
      },
      sources: {
        type: "array",
        items: { type: "string", enum: ["outlook", "teams", "whatsapp"] },
        description: "Optional source filter.",
      },
      accounts: {
        type: "array",
        items: { type: "string", minLength: 1 },
        description: "Optional account username filter.",
      },
    },
    required: ["hours"],
    additionalProperties: false,
  },
} as const;

export async function handleGetRecentActivity(
  store: MessageStore,
  clock: Clock,
  params: GetRecentActivityParams,
): Promise<GetRecentActivityResult> {
  const hours = params.hours;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) {
    throw new InvalidParamsError("hours must be a positive number");
  }
  if (hours > MAX_HOURS) {
    throw new InvalidParamsError(`hours must be <= ${MAX_HOURS}`);
  }
  if (params.sources !== undefined) {
    for (const s of params.sources) {
      if (!KNOWN_SOURCES.has(s)) {
        throw new InvalidParamsError(`unknown source: ${s}`);
      }
    }
  }
  if (params.accounts !== undefined) {
    for (const a of params.accounts) {
      if (typeof a !== "string" || a.length === 0) {
        throw new InvalidParamsError("accounts entries must be non-empty strings");
      }
    }
  }

  const since = new Date(clock.now().getTime() - hours * 3600 * 1000);
  const rows = await store.getRecentMessages({
    since,
    ...(params.sources !== undefined && { sources: params.sources }),
    ...(params.accounts !== undefined && { accounts: params.accounts }),
    limit: DEFAULT_LIMIT,
  });
  return {
    count: rows.length,
    messages: rows.map(project),
  };
}

function snippetFrom(m: Message): string | undefined {
  const raw = m.body ?? m.bodyHtml;
  if (raw === undefined) return undefined;
  return raw.length > SNIPPET_MAX ? raw.slice(0, SNIPPET_MAX) : raw;
}

function project(m: Message): ProjectedMessage {
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
  };
}
