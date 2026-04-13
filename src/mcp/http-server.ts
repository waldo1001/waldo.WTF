import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
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

export interface McpHttpServerOptions {
  readonly bearerToken: string;
  readonly store: MessageStore;
  readonly clock: Clock;
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

const writeJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
};

const isAuthorized = (header: string | undefined, expected: string): boolean => {
  if (!header) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = header.slice(prefix.length);
  if (presented.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const rpcError = (id: JsonRpcId, code: number, message: string): object => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

const rpcResult = (id: JsonRpcId, result: unknown): object => ({
  jsonrpc: "2.0",
  id,
  result,
});

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function dispatch(
  req: JsonRpcRequest,
  store: MessageStore,
  clock: Clock,
): Promise<object> {
  const id: JsonRpcId = req.id === undefined ? null : req.id;
  if (req.method === "tools/list") {
    return rpcResult(id, { tools: TOOL_DESCRIPTORS });
  }
  if (req.method === "tools/call") {
    const params = req.params as { name: string; arguments: unknown };
    const handler = TOOL_HANDLERS[params.name];
    if (handler === undefined) {
      return rpcError(id, -32601, `unknown tool: ${params.name}`);
    }
    try {
      const result = await handler(store, clock, params.arguments);
      return rpcResult(id, result);
    } catch (err) {
      if (err instanceof InvalidParamsError) {
        return rpcError(id, -32602, err.message);
      }
      return rpcError(id, -32603, "internal error");
    }
  }
  return rpcError(id, -32601, `method not found: ${req.method}`);
}

export function createMcpHttpServer(opts: McpHttpServerOptions): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (!isAuthorized(req.headers.authorization, opts.bearerToken)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method === "POST" && req.url === "/") {
      void (async () => {
        const raw = await readBody(req);
        let parsed: JsonRpcRequest;
        try {
          parsed = JSON.parse(raw) as JsonRpcRequest;
        } catch {
          writeJson(res, 200, rpcError(null, -32700, "parse error"));
          return;
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          typeof parsed.method !== "string"
        ) {
          writeJson(res, 200, rpcError(null, -32600, "invalid request"));
          return;
        }
        const body = await dispatch(parsed, opts.store, opts.clock);
        writeJson(res, 200, body);
      })();
      return;
    }
    writeJson(res, 404, { error: "not_found" });
  });
}
