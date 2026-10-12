import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Clock } from "../clock.js";
import type { Logger } from "../logger.js";
import type { MessageStore } from "../store/message-store.js";
import type { SteeringStore } from "../store/steering-store.js";
import type { VivaSubscriptionStore } from "../store/viva-subscription-store.js";
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
import { DEFAULT_REDIRECT_ALLOWLIST } from "../auth/oauth/redirect-allowlist.js";
import { createMcpServer } from "./mcp-server.js";
import { readBodyCapped } from "./read-body.js";
import { clientIp } from "./client-ip.js";
import { FixedWindowRateLimiter } from "../auth/oauth/rate-limiter.js";
import {
  DEFAULT_MAX_GRANT_DAYS,
  DEFAULT_MAX_OAUTH_CLIENTS,
} from "../auth/oauth/oauth-config.js";

export interface RateLimitSpec {
  readonly windowMs: number;
  readonly perKey: number;
  readonly global: number;
}

export interface OAuthRateLimits {
  readonly register: RateLimitSpec;
  readonly authorize: RateLimitSpec;
  readonly token: RateLimitSpec;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Single-user server: generous for the real clients (claude.ai registers once,
// refreshes daily), tight enough to make scrypt / DB-row abuse pointless.
export const DEFAULT_OAUTH_RATE_LIMITS: OAuthRateLimits = {
  register: { windowMs: HOUR_MS, perKey: 10, global: 50 },
  authorize: { windowMs: MINUTE_MS, perKey: 10, global: 30 },
  token: { windowMs: MINUTE_MS, perKey: 60, global: 300 },
};

/** Unauthenticated OAuth bodies are tiny forms / JSON. */
export const OAUTH_MAX_BODY_BYTES = 64 * 1024;
/** Authenticated MCP JSON-RPC requests (tool args) — far below the SDK's 4 MiB default. */
export const MCP_MAX_BODY_BYTES = 1024 * 1024;

export interface OAuthHttpOptions {
  readonly publicUrl: string;
  readonly authStore: AuthStore;
  readonly ids: RandomIdSource;
  readonly adminPasswordHash?: string;
  readonly hasher?: PasswordHasher;
  /** Defaults to DEFAULT_REDIRECT_ALLOWLIST (claude.ai / claude.com callbacks). */
  readonly redirectAllowlist?: readonly string[];
  /** Defaults to DEFAULT_MAX_OAUTH_CLIENTS. */
  readonly maxClients?: number;
  /** Absolute grant lifetime in days; defaults to DEFAULT_MAX_GRANT_DAYS. */
  readonly maxGrantDays?: number;
  /** Per-route overrides of DEFAULT_OAUTH_RATE_LIMITS. */
  readonly rateLimits?: Partial<OAuthRateLimits>;
}

export interface McpHttpServerOptions {
  readonly bearerToken: string;
  readonly store: MessageStore;
  readonly steering: SteeringStore;
  readonly clock: Clock;
  readonly vivaSubs?: VivaSubscriptionStore;
  readonly oauth?: OAuthHttpOptions;
  readonly logger?: Logger;
  readonly timeouts?: {
    readonly requestMs?: number;
    readonly headersMs?: number;
    readonly keepAliveMs?: number;
  };
}

const writeJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload).toString(),
    ...extraHeaders,
  });
  res.end(payload);
};

const MAX_LOGGED_REDIRECT_CHARS = 500;

// OAuth responses carry credentials (client ids, codes, tokens): never cache.
const NO_STORE: Record<string, string> = { "Cache-Control": "no-store" };

// The consent page takes the admin password: forbid framing (clickjacking),
// caching, and leaking the query string (state, challenge) via Referer.
const HTML_SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
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

const writeHtml = (
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void => {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body).toString(),
    ...HTML_SECURITY_HEADERS,
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

  // A listener with OAuth is the public (Funnel-exposed) one: OAuth tokens
  // only. The non-expiring static bearer is accepted solely on a listener
  // without OAuth — in production the loopback-only internal listener.
  if (oauth) {
    const pair = await oauth.authStore.getAccessToken(token, clock.now());
    return pair !== undefined;
  }

  return isAuthorized(authHeader, staticBearer);
}

// Every async route runs through this: a throw (SQLite error, duplicate id,
// bug) becomes a logged 500 instead of an unhandled rejection that can take
// the process down.
export const runSafely = (
  res: ServerResponse,
  logger: Logger | undefined,
  fn: () => Promise<void>,
): void => {
  fn().catch((err: unknown) => {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : "unknown";
    logger?.error(`http_handler_failed error=${JSON.stringify(detail.slice(0, 300))}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    writeJson(res, 500, { error: "server_error" }, NO_STORE);
  });
};

const writeTooLarge = (res: ServerResponse): void => {
  writeJson(
    res,
    413,
    { error: "invalid_request", error_description: "request body too large" },
    { ...NO_STORE, Connection: "close" },
  );
};

export function createMcpHttpServer(opts: McpHttpServerOptions): Server {
  const limits: OAuthRateLimits = {
    ...DEFAULT_OAUTH_RATE_LIMITS,
    ...(opts.oauth?.rateLimits ?? {}),
  };
  const limiter = (spec: RateLimitSpec): FixedWindowRateLimiter =>
    new FixedWindowRateLimiter({ clock: opts.clock, ...spec });
  const registerLimiter = limiter(limits.register);
  const authorizeLimiter = limiter(limits.authorize);
  const tokenLimiter = limiter(limits.token);

  /** Returns true when the request may proceed; otherwise has written 429. */
  const admit = (
    l: FixedWindowRateLimiter,
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean => {
    const decision = l.check(
      clientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"]),
    );
    if (decision.allowed) return true;
    writeJson(
      res,
      429,
      { error: "rate_limited", error_description: "too many requests" },
      { ...NO_STORE, "Retry-After": String(decision.retryAfterSeconds) },
    );
    return false;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (opts.oauth) {
      const redirectAllowlist =
        opts.oauth.redirectAllowlist ?? DEFAULT_REDIRECT_ALLOWLIST;
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
        if (!admit(registerLimiter, req, res)) return;
        runSafely(res, opts.logger, async () => {
          const body = await readBodyCapped(req, OAUTH_MAX_BODY_BYTES);
          if (!body.ok) return writeTooLarge(res);
          const raw = body.text;
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
            redirectAllowlist,
            maxClients: oauth.maxClients ?? DEFAULT_MAX_OAUTH_CLIENTS,
          });
          if (result.body?.error === "invalid_redirect_uri") {
            // Not a secret, and the only way to notice that a legitimate
            // client started using a new callback. JSON-encode + cap so
            // attacker-chosen text cannot forge or flood log lines.
            const uris = JSON.stringify(
              (parsed as { redirect_uris?: unknown }).redirect_uris,
            ).slice(0, MAX_LOGGED_REDIRECT_CHARS);
            opts.logger?.info(`oauth_dcr_redirect_rejected redirect_uris=${uris}`);
          }
          writeJson(res, result.status, result.body, NO_STORE);
        });
        return;
      }
      if (req.method === "POST" && req.url === "/oauth/token") {
        const oauth = opts.oauth;
        if (!admit(tokenLimiter, req, res)) return;
        runSafely(res, opts.logger, async () => {
          const capped = await readBodyCapped(req, OAUTH_MAX_BODY_BYTES);
          if (!capped.ok) return writeTooLarge(res);
          const form = new URLSearchParams(capped.text);
          const body: Record<string, unknown> = {};
          for (const [k, v] of form.entries()) {
            body[k] = v;
          }
          const result = await handleTokenRequest({
            store: oauth.authStore,
            ids: oauth.ids,
            clock: opts.clock,
            maxGrantMs: (oauth.maxGrantDays ?? DEFAULT_MAX_GRANT_DAYS) * DAY_MS,
            body,
          });
          writeJson(res, result.status, result.body, NO_STORE);
        });
        return;
      }
      const parsedUrl = new URL(req.url ?? "/", "http://localhost");
      if (
        req.method === "GET" &&
        parsedUrl.pathname === "/oauth/authorize"
      ) {
        const qs = parsedUrl.searchParams;
        const oauth = opts.oauth;
        runSafely(res, opts.logger, async () => {
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
            redirectAllowlist,
            params,
          });
          writeHtml(res, result.status, result.contentType, result.body);
        });
        return;
      }
      if (
        req.method === "POST" &&
        parsedUrl.pathname === "/oauth/authorize"
      ) {
        const oauth = opts.oauth;
        // Limited before the body is read: each admitted POST may run scrypt.
        if (!admit(authorizeLimiter, req, res)) return;
        runSafely(res, opts.logger, async () => {
          const capped = await readBodyCapped(req, OAUTH_MAX_BODY_BYTES);
          if (!capped.ok) return writeTooLarge(res);
          const form = new URLSearchParams(capped.text);
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
            redirectAllowlist,
            formBody,
          });
          const status = result.status;
          const headers = { ...result.headers };
          if (status === 302) {
            res.writeHead(302, { ...headers, ...NO_STORE });
            res.end();
          } else {
            /* c8 ignore next -- authorize handler always sets Content-Type */
          const ct =
              headers["Content-Type"] ?? "text/html; charset=utf-8";
            writeHtml(res, status, ct, result.body);
          }
        });
        return;
      }
    }
    runSafely(res, opts.logger, async () => {
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
      // Declared-size check here (not only in the SDK transport, which also
      // caps chunked bodies): answer with Connection: close so the socket is
      // dropped instead of left half-read.
      if (Number(req.headers["content-length"]) > MCP_MAX_BODY_BYTES) {
        writeTooLarge(res);
        return;
      }
      const mcp = createMcpServer({
        store: opts.store,
        steering: opts.steering,
        clock: opts.clock,
        ...(opts.vivaSubs !== undefined && { vivaSubs: opts.vivaSubs }),
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        maxRequestBodySize: MCP_MAX_BODY_BYTES,
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
    });
  });
  server.requestTimeout = opts.timeouts?.requestMs ?? 60_000;
  server.headersTimeout = opts.timeouts?.headersMs ?? 30_000;
  server.keepAliveTimeout = opts.timeouts?.keepAliveMs ?? 65_000;
  server.timeout = 0;
  return server;
}
