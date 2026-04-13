import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

export interface McpHttpServerOptions {
  readonly bearerToken: string;
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
    writeJson(res, 404, { error: "not_found" });
  });
}
