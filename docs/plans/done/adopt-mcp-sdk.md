# Plan — Adopt `@modelcontextprotocol/sdk` in place of the hand-rolled JSON-RPC server

> **Status:** PLAN, awaiting user approval per CLAUDE.md TDD loop.

## Goal

Replace the hand-rolled JSON-RPC dispatcher in
[src/mcp/http-server.ts](../../src/mcp/http-server.ts) with a real MCP
server built on `@modelcontextprotocol/sdk`, so Claude Desktop (via
`mcp-remote`) can complete the MCP `initialize` handshake, list tools,
and call them with the spec-compliant `content: [{type:"text",...}]`
result shape.

## Why now

Weekend 3 explicitly deferred the SDK "until 2–3 tools exist" — we now
have three (`get_recent_activity`, `get_sync_status`, `search`) and the
first real client (Claude Desktop through `mcp-remote`) tried to connect
and got `-32601 method not found: initialize`. Even if I added
`initialize`, `tools/call` would still return raw handler output instead
of the MCP content-block shape, so `mcp-remote` would hang up on the
first real tool invocation. The deferral's over; patching further is
cheaper to stop than to continue.

## Scope boundary

**IN**
- Add `@modelcontextprotocol/sdk` to `package.json`.
- Build an MCP `Server` instance that registers the three existing
  tools using their existing handler functions (those live in
  [src/mcp/tools/](../../src/mcp/tools/) and already return plain JS
  objects — the SDK adapter is where we wrap them into content blocks).
- Use the SDK's **Streamable HTTP transport** on the same port
  (`WALDO_PORT`, default 8765), so the bearer-token middleware and
  `/health` endpoint stay where they are. The SDK transport handles
  POST `/` dispatch — our `createMcpHttpServer` becomes a thin shell
  that mounts `/health` + bearer check + SDK transport.
- Preserve bearer-token auth exactly as today: `timingSafeEqual`-based,
  `/health` unauthenticated, all other routes require `Bearer <token>`.
- Preserve JSON error shapes the existing handlers use
  (`InvalidParamsError` → MCP invalid-params, unknown → internal
  error). The SDK already maps these if I throw `McpError` with the
  right code.
- Update [src/mcp/e2e-http.test.ts](../../src/mcp/e2e-http.test.ts) to
  drive the SDK transport (either via the SDK client, or by speaking
  the real JSON-RPC handshake in raw form). Five existing e2e tests
  must still cover: tools/list, get_recent_activity, search,
  get_sync_status, unauth rejection.
- Update [docs/claude-desktop-wiring.md](../claude-desktop-wiring.md)
  to show the correct `mcp-remote` wrapper config (I already know the
  shape that works — `npx -y mcp-remote http://localhost:8765 --header
  "Authorization: Bearer <tok>"`). Fix the stale `"transport": "http"`
  block that confused us today.
- Update [docs/changelog.md](../changelog.md) and
  [PROGRESS.md](../../PROGRESS.md) checkbox (`@modelcontextprotocol/sdk
  installed` currently unchecked under Weekend 3).

**OUT**
- Adding new tools. `get_thread`, `list_accounts` etc. stay deferred.
- Changing the three handler signatures. They keep returning plain JS
  objects; the SDK adapter wraps them.
- Multi-session / authenticated-per-session MCP. We keep one shared
  bearer for the whole server.
- Streaming tool results. All three tools return synchronously; no
  need for progress notifications yet.
- Changing `/health` semantics.

## Files to touch

- [src/mcp/http-server.ts](../../src/mcp/http-server.ts) — strip the
  hand-rolled dispatch, mount SDK transport + bearer + /health.
- New `src/mcp/mcp-server.ts` — builds the SDK `Server`, registers the
  three tools, wraps handler results into content blocks, maps
  `InvalidParamsError` → `McpError`.
- [src/mcp/tools/get-recent-activity.ts](../../src/mcp/tools/get-recent-activity.ts),
  [get-sync-status.ts](../../src/mcp/tools/get-sync-status.ts),
  [search.ts](../../src/mcp/tools/search.ts) — **no logic changes**;
  only check that the exported tool descriptor shape matches what the
  SDK expects (they likely do, since we mirrored the MCP schema when
  writing them).
- [src/mcp/e2e-http.test.ts](../../src/mcp/e2e-http.test.ts) — rewrite
  against the SDK client.
- [src/mcp/http-server.test.ts](../../src/mcp/http-server.test.ts) —
  trim tests that asserted hand-rolled JSON-RPC internals; keep
  bearer/health tests.
- `package.json` — add dependency.
- [docs/claude-desktop-wiring.md](../claude-desktop-wiring.md) — fix
  config snippet + troubleshooting row for the stale shape.
- [docs/changelog.md](../changelog.md), [PROGRESS.md](../../PROGRESS.md).

## Seams

The key insight: the SDK `Server` is itself a seam — we construct it
and hand it a transport. For tests we can drive it via the in-process
SDK client + an in-memory transport pair (SDK ships
`InMemoryTransport`), which gives us fast, hermetic MCP-protocol
coverage without spinning up HTTP. The existing `MessageStore`,
`Clock`, `GraphClient` seams are untouched — the MCP layer swap
doesn't ripple below.

## RED test list

1. **`mcp-server.test.ts` — `initialize` handshake completes.** SDK
   client ↔ SDK server over `InMemoryTransport`. Asserts the server
   advertises capability `tools` and the three tool names.
2. **`tools/list` returns the three tool descriptors** with the
   existing JSON schemas intact (inputSchema, description, name).
3. **`tools/call get_recent_activity`** against an in-memory store
   returns the expected items *wrapped in an MCP content block*
   (`content[0].type === "text"`, `content[0].text` parses back to the
   existing handler's object).
4. **`tools/call search`** with a non-empty query returns content
   block; with empty query returns an MCP invalid-params error (−32602).
5. **`tools/call get_sync_status`** returns current + stale summary in
   content block.
6. **HTTP shell — `/health` bypasses auth and returns `{ok:true}`**.
7. **HTTP shell — missing/invalid bearer → 401** on the SDK mount
   point (not just POST /). This is the test that forced us to keep
   bearer middleware above the SDK transport.
8. **HTTP shell — valid bearer → SDK transport handles
   `initialize`** end-to-end (drive with `StreamableHTTPClientTransport`
   from the SDK).
9. **E2E rewrite — existing five e2e scenarios** pass against the new
   stack (`:memory:` SqliteMessageStore + real fetch + SDK client).

## Risks

- **SDK API churn.** `@modelcontextprotocol/sdk` has moved fast. Pin
  to a specific minor version in `package.json`; run `npm audit` via
  `/security-scan` after install.
- **Transport mismatch with `mcp-remote`.** `mcp-remote` speaks
  Streamable HTTP. If the SDK version we pin doesn't ship that
  transport, we'd have to use SSE instead. Mitigation: verify the
  transport choice at FRAME time, before writing any production code.
- **Bearer middleware + SDK routing conflict.** The SDK transport may
  want to own the POST route. If so, we wrap the SDK request handler
  with our own — still clean, but needs confirming.
- **Coverage regression.** Removing the hand-rolled dispatcher removes
  code that had its own tests; the replacement should be covered by
  `mcp-server.test.ts` + shell tests. Target ≥90% on touched files.
- **Tool descriptor shape drift.** If our existing `TOOL` constants
  don't match the SDK's expected shape, we'll discover it in RED #2
  and adjust. Not expected to be large.

## Out-of-scope follow-ups

- Session-scoped MCP auth (per-client bearer / OAuth).
- Progress notifications on long-running tool calls.
- Adding `get_thread` / `list_accounts` tools.
- SSE fallback transport.

---

**Awaiting approval before FRAME / RED / code.**
