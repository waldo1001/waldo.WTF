import type { Clock } from "../../clock.js";
import type { ActivityKind, MessageStore } from "../../store/message-store.js";
import type {
  CalendarEvent,
  ChatType,
  Message,
  MessageSource,
} from "../../store/types.js";

export class InvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidParamsError";
  }
}

const KNOWN_SOURCES: ReadonlySet<MessageSource> = new Set([
  "outlook",
  "teams",
  "teams-channel",
  "whatsapp",
  "viva-engage",
]);

const KNOWN_KINDS: ReadonlySet<ActivityKind> = new Set(["message", "event"]);
const DEFAULT_KINDS: readonly ActivityKind[] = ["message", "event"];

const MAX_HOURS = 720;
const DEFAULT_LIMIT = 200;
const SNIPPET_MAX = 280;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EVENT_WINDOW_FORWARD_DAYS = 7;

export interface GetRecentActivityParams {
  readonly hours: number;
  readonly sources?: readonly MessageSource[];
  readonly accounts?: readonly string[];
  readonly include_muted?: boolean;
  readonly kinds?: readonly ActivityKind[];
  readonly to?: string;
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

export type ProjectedItem =
  | { readonly kind: "message"; readonly at: string; readonly message: ProjectedMessage }
  | { readonly kind: "event"; readonly at: string; readonly event: CalendarEvent };

export interface LegacyGetRecentActivityResult {
  readonly count: number;
  readonly messages: readonly ProjectedMessage[];
  readonly muted_count: number;
  readonly steering_hint?: string;
}

export interface UnifiedGetRecentActivityResult {
  readonly items: readonly ProjectedItem[];
  readonly muted_count: number;
  readonly steering_hint?: string;
}

export type GetRecentActivityResult =
  | LegacyGetRecentActivityResult
  | UnifiedGetRecentActivityResult;

export const GET_RECENT_ACTIVITY_TOOL = {
  name: "get_recent_activity",
  description: [
    "Return recent activity from the lake within a time window — messages by default, plus upcoming/recent calendar events when kinds includes \"event\". Read-only.",
    "",
    "Default kinds is [\"message\", \"event\"]: a mixed, chronologically ordered feed of past messages and upcoming meetings within the window (\"what's on my plate\"). Pass kinds: [\"message\"] to get the original messages-only response shape unchanged.",
    "",
    "hours sets the lower bound (from = now - hours). to sets the upper bound; when kinds includes \"event\" it defaults to now + 7 days so upcoming meetings are covered — recent activity now includes things that haven't happened yet.",
    "",
    'Use this as the source-of-truth probe when you need to confirm whether a given source (outlook, teams, whatsapp, viva-engage) has any recent data. A single call with sources: ["whatsapp"] and a wide hours window is the correct way to verify presence — more reliable than inferring from get_sync_status.',
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
        items: {
          type: "string",
          enum: ["outlook", "teams", "teams-channel", "whatsapp", "viva-engage"],
        },
        description: "Optional source filter. Only applies to message items.",
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
      kinds: {
        type: "array",
        items: { type: "string", enum: ["message", "event"] },
        minItems: 1,
        description:
          'Which item kinds to include. Default ["message", "event"]. Pass ["message"] to keep the original messages-only response shape.',
      },
      to: {
        type: "string",
        description:
          "ISO datetime upper bound. Default now, or now + 7 days when kinds includes \"event\".",
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
  const kinds = normalizeKinds(params.kinds);

  const since = new Date(clock.now().getTime() - hours * 3600 * 1000);
  const includeMuted = params.include_muted === true;

  if (kinds.length === 1 && kinds[0] === "message") {
    const { messages, mutedCount } = await store.getRecentMessages({
      since,
      ...(params.sources !== undefined && { sources: params.sources }),
      ...(params.accounts !== undefined && { accounts: params.accounts }),
      limit: DEFAULT_LIMIT,
      includeMuted,
    });
    const hint = mutedHint(includeMuted, mutedCount);
    const repliedByThread = computeRepliedByThread(messages);
    return {
      count: messages.length,
      messages: messages.map((m) => project(m, repliedByThread)),
      muted_count: mutedCount,
      ...(hint !== undefined && { steering_hint: hint }),
    };
  }

  // Past the legacy-only branch above, kinds always includes "event" —
  // the only other normalized shape is ["message", "event"] or ["event"].
  const to =
    params.to !== undefined
      ? new Date(params.to)
      : new Date(
          clock.now().getTime() + DEFAULT_EVENT_WINDOW_FORWARD_DAYS * DAY_MS,
        );

  const { items, mutedCount } = await store.getRecentItems({
    from: since,
    to,
    kinds,
    ...(params.sources !== undefined && { sources: params.sources }),
    ...(params.accounts !== undefined && { accounts: params.accounts }),
    includeMuted,
  });
  const hint = mutedHint(includeMuted, mutedCount);
  const messageItems = items
    .filter((i): i is { kind: "message"; at: Date; message: Message } =>
      i.kind === "message",
    )
    .map((i) => i.message);
  const repliedByThread = computeRepliedByThread(messageItems);

  return {
    items: items.map((item): ProjectedItem =>
      item.kind === "message"
        ? {
            kind: "message",
            at: item.at.toISOString(),
            message: project(item.message, repliedByThread),
          }
        : {
            kind: "event",
            at: item.at.toISOString(),
            event: item.event,
          },
    ),
    muted_count: mutedCount,
    ...(hint !== undefined && { steering_hint: hint }),
  };
}

function normalizeKinds(
  kinds: readonly ActivityKind[] | undefined,
): readonly ActivityKind[] {
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
    ? `${mutedCount} message(s) hidden by steering rules. Pass include_muted=true to see them, or call get_steering to review active rules.`
    : undefined;
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
