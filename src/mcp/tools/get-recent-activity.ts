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
  readonly include_muted?: boolean;
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
  readonly replied?: boolean;
}

export interface GetRecentActivityResult {
  readonly count: number;
  readonly messages: readonly ProjectedMessage[];
  readonly muted_count: number;
  readonly steering_hint?: string;
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
      include_muted: {
        type: "boolean",
        description:
          "If true, include messages matching steering rules. Default false (hard-exclude muted items).",
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
  const includeMuted = params.include_muted === true;
  const { messages, mutedCount } = await store.getRecentMessages({
    since,
    ...(params.sources !== undefined && { sources: params.sources }),
    ...(params.accounts !== undefined && { accounts: params.accounts }),
    limit: DEFAULT_LIMIT,
    includeMuted,
  });
  const hint =
    !includeMuted && mutedCount > 0
      ? `${mutedCount} message(s) hidden by steering rules. Pass include_muted=true to see them, or call get_steering to review active rules.`
      : undefined;
  const repliedByThread = computeRepliedByThread(messages);
  return {
    count: messages.length,
    messages: messages.map((m) => project(m, repliedByThread)),
    muted_count: mutedCount,
    ...(hint !== undefined && { steering_hint: hint }),
  };
}

// For each thread appearing in the result window, the annotation reflects the
// latest-by-sentAt row's fromMe. Threads with no in-window rows get no entry;
// messages without a threadId are never annotated.
function computeRepliedByThread(
  messages: readonly Message[],
): Map<string, boolean> {
  const latestByThread = new Map<string, Message>();
  for (const m of messages) {
    if (m.threadId === undefined) continue;
    const prev = latestByThread.get(m.threadId);
    if (prev === undefined || m.sentAt.getTime() > prev.sentAt.getTime()) {
      latestByThread.set(m.threadId, m);
    }
  }
  const out = new Map<string, boolean>();
  for (const [tid, m] of latestByThread) out.set(tid, m.fromMe === true);
  return out;
}

function snippetFrom(m: Message): string | undefined {
  const raw = m.body ?? m.bodyHtml;
  if (raw === undefined) return undefined;
  return raw.length > SNIPPET_MAX ? raw.slice(0, SNIPPET_MAX) : raw;
}

function project(
  m: Message,
  repliedByThread: ReadonlyMap<string, boolean>,
): ProjectedMessage {
  const snippet = snippetFrom(m);
  const replied =
    m.threadId !== undefined ? repliedByThread.get(m.threadId) : undefined;
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
    ...(replied !== undefined && { replied }),
  };
}
