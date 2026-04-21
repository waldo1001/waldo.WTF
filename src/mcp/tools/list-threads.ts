import type { Clock } from "../../clock.js";
import type { MessageStore } from "../../store/message-store.js";
import type { MessageSource, ThreadSummary } from "../../store/types.js";
import { InvalidParamsError } from "./get-recent-activity.js";

const KNOWN_SOURCES: ReadonlySet<MessageSource> = new Set([
  "outlook",
  "teams",
  "whatsapp",
]);

export interface ListThreadsParams {
  readonly source: MessageSource;
}

export interface ProjectedThreadSummary {
  readonly source: MessageSource;
  readonly threadId: string;
  readonly threadName?: string;
  readonly messageCount: number;
  readonly newestSentAt: string;
  readonly oldestSentAt: string;
}

export interface ListThreadsResult {
  readonly count: number;
  readonly threads: readonly ProjectedThreadSummary[];
}

export const LIST_THREADS_TOOL = {
  name: "list_threads",
  description: [
    "Return every distinct thread stored for a given source, with message count and sent-at date range. Ordered newest-first by the latest message in each thread. Read-only.",
    "",
    "Use this to: (a) discover the opaque `threadId` values that `get_thread` expects, (b) detect bifurcated threads (e.g. a WhatsApp conversation re-exported under two different chat names produces two rows with the same display name), (c) see a source's inventory at a glance.",
    "",
    "Not affected by steering rules — this is a diagnostic tool and always returns the full inventory.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        enum: ["outlook", "teams", "whatsapp"],
        description: "Which message source to enumerate threads for.",
      },
    },
    required: ["source"],
    additionalProperties: false,
  },
} as const;

export async function handleListThreads(
  store: MessageStore,
  _clock: Clock,
  params: ListThreadsParams,
): Promise<ListThreadsResult> {
  const source = params.source;
  if (typeof source !== "string") {
    throw new InvalidParamsError("source must be a string");
  }
  if (!KNOWN_SOURCES.has(source as MessageSource)) {
    throw new InvalidParamsError(`unknown source: ${source}`);
  }
  const rows = await store.listThreadSummaries({
    source: source as MessageSource,
  });
  return {
    count: rows.length,
    threads: rows.map(project),
  };
}

function project(s: ThreadSummary): ProjectedThreadSummary {
  return {
    source: s.source,
    threadId: s.threadId,
    ...(s.threadName !== undefined && { threadName: s.threadName }),
    messageCount: s.messageCount,
    newestSentAt: s.newestSentAt.toISOString(),
    oldestSentAt: s.oldestSentAt.toISOString(),
  };
}
