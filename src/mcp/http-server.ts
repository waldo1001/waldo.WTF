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
import type { SteeringStore } from "../store/steering-store.js";
import type { AuthStore } from "../auth/oauth/auth-store.js";
import type { RandomIdSource } from "../auth/oauth/ids.js";
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from "../auth/oauth/metadata.js";
import { handleDynamicClientRegistration } from "../auth/oauth/dcr.js";
import {
  handleAuthorizeGet,
  handleAuthorizePost,
  type AuthorizeGetParams,
  type AuthorizePostFormBody,
} from "../auth/oauth/authorize.js";
import type { PasswordHasher } from "../auth/oauth/password.js";
import { handleTokenRequest } from "../auth/oauth/token.js";
import { createMcpServer } from "./mcp-server.js";

export interface OAuthHttpOptions {
  readonly publicUrl: string;
  readonly authStore: AuthStore;
  readonly ids: RandomIdSource;
  readonly adminPasswordHash?: string;
  readonly hasher?: PasswordHasher;
  readonly disableStaticBearer?: boolean;
}

export interface McpHttpServerOptions {
  readonly bearerToken: string;
  readonly store: MessageStore;
  readonly steering: SteeringStore;
  readonly clock: Clock;
  readonly oauth?: OAuthHttpOptions;
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

const readJsonBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const readRawBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const writeHtml = (
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void => {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body).toString(),
  });
  res.end(body);
};

const extractBearerToken = (header: string | undefined): string | undefined => {
  if (!header) return undefined;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return undefined;
  const token = header.slice(prefix.length);
  return token.length > 0 ? token : undefined;
};

async function checkAuthorization(
  authHeader: string | undefined,
  staticBearer: string,
  oauth: OAuthHttpOptions | undefined,
  clock: Clock,
): Promise<boolean> {
  const token = extractBearerToken(authHeader);
  if (!token) return false;

  if (oauth) {
    const pair = await oauth.authStore.getAccessToken(token, clock.now());
    if (pair) return true;
    if (oauth.disableStaticBearer) return false;
  }

  return isAuthorized(authHeader, staticBearer);
}

export function createMcpHttpServer(opts: McpHttpServerOptions): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (opts.oauth) {
      if (
        req.method === "GET" &&
        req.url === "/.well-known/oauth-authorization-server"
      ) {
        writeJson(
          res,
          200,
          buildAuthorizationServerMetadata(opts.oauth.publicUrl),
        );
        return;
      }
      if (
        req.method === "GET" &&
        req.url === "/.well-known/oauth-protected-resource"
      ) {
        writeJson(
          res,
          200,
          buildProtectedResourceMetadata(opts.oauth.publicUrl),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/oauth/register") {
        const oauth = opts.oauth;
        void (async () => {
          const raw = await readJsonBody(req);
          let parsed: unknown;
          try {
            parsed = raw.length === 0 ? {} : JSON.parse(raw);
          } catch {
            writeJson(res, 400, {
              error: "invalid_client_metadata",
              error_description: "request body must be valid JSON",
            });
            return;
          }
          const result = await handleDynamicClientRegistration({
            body: parsed,
            store: oauth.authStore,
            ids: oauth.ids,
            clock: opts.clock,
          });
          writeJson(res, result.status, result.body);
        })();
        return;
      }
      if (req.method === "POST" && req.url === "/oauth/token") {
        const oauth = opts.oauth;
        void (async () => {
          const raw = await readRawBody(req);
          const form = new URLSearchParams(raw);
          const body: Record<string, unknown> = {};
          for (const [k, v] of form.entries()) {
            body[k] = v;
          }
          const result = await handleTokenRequest({
            store: oauth.authStore,
            ids: oauth.ids,
            clock: opts.clock,
            body,
          });
          writeJson(res, result.status, result.body);
        })();
        return;
      }
      const parsedUrl = new URL(req.url ?? "/", "http://localhost");
      if (
        req.method === "GET" &&
        parsedUrl.pathname === "/oauth/authorize"
      ) {
        const qs = parsedUrl.searchParams;
        const oauth = opts.oauth;
        void (async () => {
          /* c8 ignore next 8 -- null branches from qs.get handled by authorize handler validation */
          const params: AuthorizeGetParams = {
            client_id: qs.get("client_id") ?? "",
            redirect_uri: qs.get("redirect_uri") ?? "",
            response_type: qs.get("response_type") ?? "",
            code_challenge: qs.get("code_challenge") ?? "",
            code_challenge_method: qs.get("code_challenge_method") ?? "",
            scope: qs.get("scope") ?? undefined,
            state: qs.get("state") ?? undefined,
          };
          const result = await handleAuthorizeGet({
            store: oauth.authStore,
            params,
          });
          writeHtml(res, result.status, result.contentType, result.body);
        })();
        return;
      }
      if (
        req.method === "POST" &&
        parsedUrl.pathname === "/oauth/authorize"
      ) {
        const oauth = opts.oauth;
        void (async () => {
          const raw = await readRawBody(req);
          const form = new URLSearchParams(raw);
          /* c8 ignore next 8 -- null branches from form.get handled by authorize handler validation */
          const formBody: AuthorizePostFormBody = {
            client_id: form.get("client_id") ?? "",
            redirect_uri: form.get("redirect_uri") ?? "",
            code_challenge: form.get("code_challenge") ?? "",
            code_challenge_method: form.get("code_challenge_method") ?? "",
            scope: form.get("scope") ?? undefined,
            state: form.get("state") ?? undefined,
            password: form.get("password") ?? "",
          };
          const result = await handleAuthorizePost({
            store: oauth.authStore,
            hasher: oauth.hasher,
            adminPasswordHash: oauth.adminPasswordHash,
            ids: oauth.ids,
            clock: opts.clock,
            formBody,
          });
          const status = result.status;
          const headers = { ...result.headers };
          if (status === 302) {
            res.writeHead(302, headers);
            res.end();
          } else {
            /* c8 ignore next -- authorize handler always sets Content-Type */
          const ct =
              headers["Content-Type"] ?? "text/html; charset=utf-8";
            writeHtml(res, status, ct, result.body);
          }
        })();
        return;
      }
    }
    void (async () => {
      const authorized = await checkAuthorization(
        req.headers.authorization,
        opts.bearerToken,
        opts.oauth,
        opts.clock,
      );
      if (!authorized) {
        const wwwAuth = opts.oauth
          ? `Bearer resource_metadata=${opts.oauth.publicUrl}/.well-known/oauth-protected-resource`
          : "Bearer";
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": wwwAuth,
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const mcp = createMcpServer({
        store: opts.store,
        steering: opts.steering,
        clock: opts.clock,
      });
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
