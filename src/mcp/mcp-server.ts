import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Clock } from "../clock.js";
import type { MessageStore } from "../store/message-store.js";
import type { SteeringStore } from "../store/steering-store.js";
import type { VivaSubscriptionStore } from "../store/viva-subscription-store.js";
import {
  ADD_STEERING_RULE_TOOL,
  handleAddSteeringRule,
  type AddSteeringRuleParams,
} from "./tools/add-steering-rule.js";
import {
  DIAGNOSE_SYNC_HEALTH_TOOL,
  handleDiagnoseSyncHealth,
} from "./tools/diagnose-sync-health.js";
import {
  GET_RECENT_ACTIVITY_TOOL,
  InvalidParamsError,
  handleGetRecentActivity,
  type GetRecentActivityParams,
} from "./tools/get-recent-activity.js";
import {
  GET_STEERING_TOOL,
  handleGetSteering,
} from "./tools/get-steering.js";
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
  LIST_THREADS_TOOL,
  handleListThreads,
  type ListThreadsParams,
} from "./tools/list-threads.js";
import {
  REMOVE_STEERING_RULE_TOOL,
  handleRemoveSteeringRule,
  type RemoveSteeringRuleParams,
} from "./tools/remove-steering-rule.js";
import {
  SEARCH_TOOL,
  handleSearch,
  type SearchParams,
} from "./tools/search.js";
import {
  SET_STEERING_ENABLED_TOOL,
  handleSetSteeringEnabled,
  type SetSteeringEnabledParams,
} from "./tools/set-steering-enabled.js";

export interface McpServerDeps {
  readonly store: MessageStore;
  readonly steering: SteeringStore;
  readonly clock: Clock;
  readonly vivaSubs?: VivaSubscriptionStore;
}

interface HandlerContext {
  readonly store: MessageStore;
  readonly steering: SteeringStore;
  readonly clock: Clock;
  readonly vivaSubs: VivaSubscriptionStore | undefined;
}

type ToolHandler = (ctx: HandlerContext, args: unknown) => Promise<unknown>;

const TOOL_DESCRIPTORS = [
  GET_RECENT_ACTIVITY_TOOL,
  GET_SYNC_STATUS_TOOL,
  SEARCH_TOOL,
  GET_THREAD_TOOL,
  LIST_ACCOUNTS_TOOL,
  LIST_THREADS_TOOL,
  DIAGNOSE_SYNC_HEALTH_TOOL,
  GET_STEERING_TOOL,
  ADD_STEERING_RULE_TOOL,
  REMOVE_STEERING_RULE_TOOL,
  SET_STEERING_ENABLED_TOOL,
] as const;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  [GET_RECENT_ACTIVITY_TOOL.name]: (ctx, args) =>
    handleGetRecentActivity(ctx.store, ctx.clock, args as GetRecentActivityParams),
  [GET_SYNC_STATUS_TOOL.name]: (ctx) =>
    handleGetSyncStatus(ctx.store, ctx.clock),
  [SEARCH_TOOL.name]: (ctx, args) =>
    handleSearch(ctx.store, ctx.clock, args as SearchParams),
  [GET_THREAD_TOOL.name]: (ctx, args) =>
    handleGetThread(ctx.store, ctx.clock, args as GetThreadParams),
  [LIST_ACCOUNTS_TOOL.name]: (ctx) => handleListAccounts(ctx.store, ctx.clock),
  [LIST_THREADS_TOOL.name]: (ctx, args) =>
    handleListThreads(ctx.store, ctx.clock, args as ListThreadsParams),
  [DIAGNOSE_SYNC_HEALTH_TOOL.name]: (ctx) =>
    handleDiagnoseSyncHealth(ctx.store, ctx.vivaSubs, ctx.clock),
  [GET_STEERING_TOOL.name]: (ctx) => handleGetSteering(ctx.steering, ctx.clock),
  [ADD_STEERING_RULE_TOOL.name]: (ctx, args) =>
    handleAddSteeringRule(ctx.steering, ctx.clock, args as AddSteeringRuleParams),
  [REMOVE_STEERING_RULE_TOOL.name]: (ctx, args) =>
    handleRemoveSteeringRule(
      ctx.steering,
      ctx.clock,
      args as RemoveSteeringRuleParams,
    ),
  [SET_STEERING_ENABLED_TOOL.name]: (ctx, args) =>
    handleSetSteeringEnabled(
      ctx.steering,
      ctx.clock,
      args as SetSteeringEnabledParams,
    ),
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
        "",
        "Steering rules:",
        '- get_recent_activity and search hide "muted" messages by default and report muted_count + a steering_hint. Pass include_muted=true to see them, or call get_steering to review active rules.',
        "- get_thread, list_accounts, and list_threads are unaffected by steering.",
        '- Add a rule via add_steering_rule when the user asks to stop seeing a sender / domain / thread / keyword. Confirm the intended rule in chat before calling — rules are reversible via remove_steering_rule or set_steering_enabled(id, false).',
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
      const ctx: HandlerContext = {
        store: deps.store,
        steering: deps.steering,
        clock: deps.clock,
        vivaSubs: deps.vivaSubs,
      };
      const result = await handler(ctx, args ?? {});
      return {
        content: [
          { type: "text", text: JSON.stringify(result) },
        ],
      };
    } catch (err) {
      if (err instanceof InvalidParamsError) {
        throw new McpError(ErrorCode.InvalidParams, err.message);
      }
      const detail =
        err instanceof Error
          ? `${err.message}\n${err.stack ?? ""}`
          : String(err);
      console.error(`[mcp tool handler] ${name} failed: ${detail}`);
      throw new McpError(ErrorCode.InternalError, "internal error");
    }
  });

  return server;
}
