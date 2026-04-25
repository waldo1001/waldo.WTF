# Slice plan — Server-side request/header timeouts (A3.3)

Parent plan: [server-hang-autoheal.md](server-hang-autoheal.md) §3.3.

## Goal

Apply Node's built-in HTTP server timeouts to `createMcpHttpServer` so
slow-loris clients and stuck request bodies can't tie up sockets
indefinitely.

## Files to touch

- `src/mcp/http-server.ts` — extend `McpHttpServerOptions` with
  `readonly timeouts?: { requestMs?: number; headersMs?: number;
  keepAliveMs?: number }`. Capture the result of `createServer(...)`,
  set `server.requestTimeout`, `server.headersTimeout`,
  `server.keepAliveTimeout`, `server.timeout = 0`, then return.
  Defaults: 60_000 / 30_000 / 65_000.
- `src/mcp/http-server.test.ts` — append 1 small describe with 2
  property-assertion tests.

## Seams

- None new. The test inspects `server.requestTimeout` etc. directly
  on the returned `Server` instance.

## RED test list

1. `applies default request/headers/keepAlive timeouts when no options
   provided` — assert
   `server.requestTimeout === 60000`,
   `server.headersTimeout === 30000`,
   `server.keepAliveTimeout === 65000`,
   `server.timeout === 0`.
2. `applies caller-overridden timeouts` — pass
   `{ timeouts: { requestMs: 1000, headersMs: 500, keepAliveMs: 2000 } }`,
   assert all three values are set verbatim.

## Out of scope (this slice)

- Real-timer integration test that proves Node *actually* closes a
  slow-upload socket. The `http` module is the source of truth for
  that behavior; re-testing it here would violate the "trust framework
  guarantees" project rule.
- Lint rule banning bare `fetch` (Slice A3.4).

## Risks

- **Long tool responses get cut off**: `requestTimeout` only applies
  to receiving the *request*, not sending the response — so streaming
  or long-running tool outputs aren't affected.
- **`keepAliveTimeout` lower than client expectations**: 65s is
  generous; matches Node's commonly-recommended HTTP-keepalive value
  and exceeds typical client probe intervals.

## Definition of done

- 2 new tests green; existing http-server tests stay green.
- Coverage on `http-server.ts` doesn't drop.
- `/security-scan` passes.
- `/docs-update` run.
