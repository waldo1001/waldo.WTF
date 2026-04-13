import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Clock } from "../clock.js";
import type { MessageStore } from "../store/message-store.js";
import { createMcpServer } from "./mcp-server.js";

export interface McpHttpServerOptions {
  readonly bearerToken: string;
  readonly store: MessageStore;
  readonly clock: Clock;
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

const isAuthorized = (
  header: string | undefined,
  expected: string,
): boolean => {
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
    void (async () => {
      const mcp = createMcpServer({ store: opts.store, clock: opts.clock });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      } as unknown as ConstructorParameters<
        typeof StreamableHTTPServerTransport
      >[0]);
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(
        transport as unknown as Parameters<typeof mcp.connect>[0],
      );
      await transport.handleRequest(req, res);
    })();
  });
}
