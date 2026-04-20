# Plan: Post-OAuth debuggability + client-cache runbook

## Task
Address three gaps surfaced by a support session where `list_accounts` appeared
broken on both Claude Desktop and claude.ai while the server was in fact
healthy. Root cause: stale client-side OAuth / tool-discovery state after the
OAuth deploy (commits 18501a0 → df68be1). Fix was to remove and re-add the
connector on each client. Debugging was disproportionately painful because the
server silently swallows every tool-handler error.

Three deliverables, independent and orderable:

1. **Un-swallow tool errors in the MCP server** (code change, `/tdd-cycle`).
2. **Document the "stale connector" failure mode** in the OAuth user docs.
3. **Document a diagnostic recipe** for running a tool handler directly
   inside the running container when the symptom is ambiguous.

## Scope boundary
**IN:**
- Log the real error (message + stack + tool name) from the catch in
  `src/mcp/mcp-server.ts` before re-throwing the generic `McpError`.
- Regression test proving the logged output contains the original error.
- A "Troubleshooting" section in `docs/oauth.md` describing the stale-connector
  symptom and the remove/re-add fix.
- A "Diagnostics inside the container" section in `docs/deploy-synology.md`
  with the `docker compose exec … tsx -e "…"` recipe.

**OUT:**
- Changing the wire-level error response to leak error detail to the client
  (still generic `internal error` — only the server log gets the detail).
- Adding request-id correlation, structured logs, log levels, or a logging
  framework. The one-line `console.error` is enough to unblock debugging.
- Auto-recovery or client-side retry on stale DCR state.
- Client-specific (Claude Desktop vs claude.ai) behavioral differences beyond
  noting both symptoms in the runbook.

## Files to create / touch

### Deliverable 1 — un-swallow tool errors
- `src/mcp/mcp-server.ts` — add `console.error` for the tool name + original
  error before throwing the generic `McpError`.
- `src/mcp/mcp-server.test.ts` — RED test: when a handler throws, stderr
  receives a log line containing the tool name and the original error message.

### Deliverable 2 — OAuth stale-connector runbook
- `docs/oauth.md` — new "Troubleshooting: tools error or time out after an
  OAuth deploy" section.

### Deliverable 3 — container-exec diagnostic recipe
- `docs/deploy-synology.md` — new "Diagnostics: running a handler inside the
  container" section.

### Changelog
- `docs/changelog.md` — one line per deliverable shipped.

## Seams involved
- Deliverable 1 only: the MCP dispatch layer in `mcp-server.ts`. No store,
  auth, graph, clock, or HTTP-transport changes. The test captures stderr
  (vitest `vi.spyOn(console, "error")`).

## RED test list (Deliverable 1 only)
- AC1: a handler that throws surfaces its error to stderr before the
  generic `McpError` is returned to the caller.
  - test file: `src/mcp/mcp-server.test.ts`
  - test name: "logs the original error and tool name when a handler throws"
  - seams: a stub tool handler that throws a known error; `console.error`
    spy
  - edge cases: non-`Error` throw (string, number), `InvalidParamsError`
    which is re-thrown as `InvalidParams` and should NOT be logged as an
    internal failure (it is caller-error, not server-error)

## Acceptance details for Deliverables 2 and 3 (no tests — docs only)

### Deliverable 2 — `docs/oauth.md` troubleshooting section must include:
- Symptom on Claude Desktop: tool call times out.
- Symptom on claude.ai: generic "tool execution error", often repeated across
  retries; other tools on the same server still work.
- Root cause: the client has cached DCR `client_id` / tool discovery state
  from before an OAuth config change.
- Fix, per client:
  - Claude Desktop: Settings → Connectors → Disconnect → **quit the app
    fully (cmd+Q)** → relaunch → re-add connector using the `https://`
    Tailscale URL.
  - claude.ai web: Settings → Connectors → remove → hard reload tab
    (cmd+shift+R) → re-add connector.
- When to escalate: if the remove/re-add does not resolve it, check server
  logs (now meaningful thanks to Deliverable 1) and run the Deliverable 3
  recipe to isolate server vs transport.

### Deliverable 3 — `docs/deploy-synology.md` diagnostics section must include:
- When to use it: a specific MCP tool is failing while others succeed, and
  server logs do not show the cause.
- DB path inside the container: `/data/db/lake.db` (bind-mounted from
  `./data/db` on the host).
- Exact tsx invocation pattern, using an async IIFE (tsx `-e` defaults to
  CJS, which rejects top-level await):

  ```sh
  sudo docker compose exec waldo ./node_modules/.bin/tsx -e "
  import Database from 'better-sqlite3';
  import { SqliteMessageStore } from './src/store/sqlite-message-store.ts';
  import { handleListAccounts } from './src/mcp/tools/list-accounts.ts';
  (async () => {
    const db = new Database('/data/db/lake.db', { readonly: true });
    const store = new SqliteMessageStore(db);
    const clock = { now: () => new Date() };
    try {
      const out = await handleListAccounts(store, clock);
      console.log('OK:', JSON.stringify(out, null, 2));
    } catch (e) {
      console.error('ERR:', e && e.stack ? e.stack : e);
    }
  })();
  "
  ```
- Why `--experimental-strip-types` doesn't work: it rejects TS parameter
  properties (used in `SqliteMessageStore`'s constructor), so use `tsx`.
- Always open the DB `readonly: true` when diagnosing to avoid WAL contention
  with the live server.

## Open questions / assumptions
- Assumption: `console.error` is acceptable as a log sink. The container
  already writes to Docker's log driver via stderr, so no new wiring.
- Assumption: we do NOT want to change the error surface to the client.
  Leaking internal error messages to OAuth-authenticated MCP clients would
  be a small info-disclosure regression. Only the server log gets detail.
- Assumption: `InvalidParamsError` continues to be re-thrown as
  `InvalidParams` without an error log, since it is a caller-side validation
  failure, not a server fault. Worth a dedicated test.

## Risks
- A handler throwing something huge (e.g. a giant SQL error with full query)
  could bloat logs. Mitigation: log the `.message` and `.stack` but nothing
  more; do not `JSON.stringify` the whole error object.
- Docs drift: if OAuth flow or NAS paths change later, the troubleshooting
  and diagnostic recipes need to be updated alongside. Lower risk — they
  live next to the primary docs for those topics.

## Out-of-scope follow-ups
- Structured logging (pino/winston) with request IDs and per-tool latency.
- Surfacing a per-request correlation ID to the client so users can reference
  it when reporting issues.
- A `/healthz` endpoint that runs a smoke call against each tool and reports
  per-tool status.
- Client-side DCR refresh hints — e.g. rotating a `client_id_version` in
  OAuth metadata so well-behaved clients invalidate their cache automatically
  after config changes.
