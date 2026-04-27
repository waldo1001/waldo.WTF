# Plan — Surface redacted error detail in MCP tool errors

## Task

Change the MCP server's catch-all in `createMcpServer` so a handler exception
produces an `McpError(InternalError, "<ErrClass>: <first-line redacted message>")`
instead of the opaque `"internal error"` it returns today, while keeping full
stacks stderr-only.

## Scope boundary

**IN**

- `src/mcp/mcp-server.ts` — replace the literal `"internal error"` string at
  the catch site with a redacted, single-line summary built from the caught
  exception. Re-use `redactSecretsFromError` from
  `src/mcp/tools/remediation-prompts.ts`.
- New unit tests in `src/mcp/mcp-server.test.ts` covering the new behavior.

**OUT**

- No change to `console.error` logging shape (stack still goes to stderr).
- No change to per-tool handlers.
- No change to `InvalidParamsError` mapping (already passes `err.message`
  through; that path is fine).
- No new error taxonomy / classification beyond what
  `redactSecretsFromError` already does.
- No change to `request_id`/`req_…` correlation — that's a Claude.ai
  connector concern, separate slice.

## Files to create / touch

- `src/mcp/mcp-server.ts` — modify catch block (≈5 lines).
- `src/mcp/mcp-server.test.ts` — add 3 tests (Error subclass name surfaces,
  multi-line message gets first line only, secrets in message get redacted).

## Seams involved

- **logger** (existing `console.error` call site) — touched only to keep
  current logging contract intact.
- No new seams. No store / clock / fs / msal / graph / http changes.

## RED test list

- AC1: When a handler throws an `Error` subclass (e.g. `TypeError`,
  `class FooError extends Error`), the McpError surfaced to the client
  contains the class name and the first line of the message.
  - test file: `src/mcp/mcp-server.test.ts`
  - test name: `"InternalError message includes the original error class and first message line"`
  - seams touched: none (uses existing `InMemoryMessageStore`)
  - edge cases: subclass not just `Error`; multi-line message — only first
    line surfaces.
- AC2: A handler error message containing a Bearer token / long base64-ish
  blob is redacted before being placed in the McpError message.
  - test file: `src/mcp/mcp-server.test.ts`
  - test name: `"InternalError message redacts bearer tokens and long secrets"`
  - seams touched: none
  - edge cases: `Bearer eyJhbGc…` → `[REDACTED]`.
- AC3: Non-`Error` throws (string, number) still surface a usable
  InternalError message — the stringified value, redacted, single line.
  - test file: `src/mcp/mcp-server.test.ts`
  - test name: `"InternalError message handles non-Error throws (string)"`
  - seams touched: none
  - edge cases: thrown string with embedded newline.

## Open questions / assumptions

- Assumption: the existing stderr log line stays unchanged (full stack
  stays stderr-only). Existing tests `"logs the original error and tool
  name when a handler throws"` and `"logs non-Error throws…"` already
  pin this and must remain green.
- Assumption: changing the McpError message from `"internal error"` to
  `"<Class>: <line>"` is not a breaking contract change for any client
  — it's a free-form human-readable string per the MCP spec, and no
  test currently asserts the exact `"internal error"` wording.
- Assumption: `redactSecretsFromError` (already used by diagnose
  findings) is the right redaction pass — Bearer tokens + long
  base64-like blobs. Adequate for an error message line.

## Risks

- Risk: leaking sensitive data in the new error message. Mitigation: run
  every error message through `redactSecretsFromError`, plus add an
  explicit RED test (AC2) that a Bearer token is `[REDACTED]`.
- Risk: a giant single-line error message bloating responses. Mitigation:
  take first line only (split on `\n`), and the existing redactor
  collapses long base64 to `[REDACTED]` so worst-case length is bounded.
- Risk: regression in existing logging tests. Mitigation: do not touch
  the `console.error` line; only change what's passed to `McpError`.

## Out-of-scope follow-ups

- Echo the inbound MCP `request_id` (when one exists) into the stderr
  log line so a `req_…` from Claude.ai can be grep'd in container logs.
  Separate plan; needs to verify the MCP SDK exposes the id on the
  request handler.
- Optional structured `data` payload on `McpError` (some MCP clients
  surface `error.data`) — defer until a client actually needs it.
