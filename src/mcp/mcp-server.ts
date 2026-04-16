import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Clock } from "../clock.js";
import type { MessageStore } from "../store/message-store.js";
import {
  GET_RECENT_ACTIVITY_TOOL,
  InvalidParamsError,
  handleGetRecentActivity,
  type GetRecentActivityParams,
} from "./tools/get-recent-activity.js";
import {
  GET_SYNC_STATUS_TOOL,
  handleGetSyncStatus,
} from "./tools/get-sync-status.js";
import {
  GET_THREAD_TOOL,
  handleGetThread,
  type GetThreadParams,
} from "./tools/get-thread.js";
import {
  LIST_ACCOUNTS_TOOL,
  handleListAccounts,
} from "./tools/list-accounts.js";
import {
  SEARCH_TOOL,
  handleSearch,
  type SearchParams,
} from "./tools/search.js";

export interface McpServerDeps {
  readonly store: MessageStore;
  readonly clock: Clock;
}

type ToolHandler = (
  store: MessageStore,
  clock: Clock,
  args: unknown,
) => Promise<unknown>;

const TOOL_DESCRIPTORS = [
  GET_RECENT_ACTIVITY_TOOL,
  GET_SYNC_STATUS_TOOL,
  SEARCH_TOOL,
  GET_THREAD_TOOL,
  LIST_ACCOUNTS_TOOL,
] as const;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  [GET_RECENT_ACTIVITY_TOOL.name]: (store, clock, args) =>
    handleGetRecentActivity(store, clock, args as GetRecentActivityParams),
  [GET_SYNC_STATUS_TOOL.name]: (store, clock) =>
    handleGetSyncStatus(store, clock),
  [SEARCH_TOOL.name]: (store, clock, args) =>
    handleSearch(store, clock, args as SearchParams),
  [GET_THREAD_TOOL.name]: (store, clock, args) =>
    handleGetThread(store, clock, args as GetThreadParams),
  [LIST_ACCOUNTS_TOOL.name]: (store, clock) => handleListAccounts(store, clock),
};

export function createMcpServer(deps: McpServerDeps): Server {
  const server = new Server(
    { name: "waldo-wtf", version: "0.0.0" },
    {
      capabilities: { tools: {} },
      instructions: [
        "Search strategy for multilingual lakes:",
        "- If the user references a known person, go straight to get_thread on that person's thread where possible.",
        "- If using search, try queries in the language the referenced person would use, not the language the user is currently chatting in.",
        '- Treat empty results as "didn\'t match," not "doesn\'t exist." Retry with: other language, shorter root, related term, or switch to get_thread.',
        "- Never use get_sync_status to claim a source is absent — it reports health, not inventory.",
      ].join("\n"),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DESCRIPTORS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const handler = TOOL_HANDLERS[name];
    if (handler === undefined) {
      throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${name}`);
    }
    try {
      const result = await handler(deps.store, deps.clock, args ?? {});
      return {
        content: [
          { type: "text", text: JSON.stringify(result) },
        ],
      };
    } catch (err) {
      if (err instanceof InvalidParamsError) {
        throw new McpError(ErrorCode.InvalidParams, err.message);
      }
      throw new McpError(ErrorCode.InternalError, "internal error");
    }
  });

  return server;
}
