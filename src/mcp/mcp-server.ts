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
] as const;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  [GET_RECENT_ACTIVITY_TOOL.name]: (store, clock, args) =>
    handleGetRecentActivity(store, clock, args as GetRecentActivityParams),
  [GET_SYNC_STATUS_TOOL.name]: (store, clock) =>
    handleGetSyncStatus(store, clock),
  [SEARCH_TOOL.name]: (store, clock, args) =>
    handleSearch(store, clock, args as SearchParams),
};

export function createMcpServer(deps: McpServerDeps): Server {
  const server = new Server(
    { name: "waldo-wtf", version: "0.0.0" },
    { capabilities: { tools: {} } },
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
