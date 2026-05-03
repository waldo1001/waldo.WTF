# Fix: classifyError 401/410 anchoring (no bare-substring matches)

## Task

Stop [`classifyError`](../../src/mcp/tools/classify-error.ts) from
mis-classifying benign error strings (`"took 401ms"`, `"port 4010 in
use"`, `"graph 4101: foo"`) as `auth` / `delta-invalid`. The loose
`(^|[^\d])401([^\d]|$)` and matching `410` regexes accepted any
non-digit-bounded `401` / `410` substring, which made
[`diagnose_sync_health`](../../src/mcp/tools/diagnose-sync-health.ts)
render a misleading "re-authenticate your account" remediation prompt
for completely unrelated failures.

## Context

A live session against the NAS (`waldonas3.tailb07704.ts.net:8765`) saw
symptoms like "Waldo-wtf is throwing errors — looks like it might need a
re-auth" appearing for every kind of failure, not just real auth ones.
Investigation traced the false positive to the bare-digit regex above.

Originally this cycle was paired with a SQLite `busy_timeout = 5000`
pragma fix on [`openDatabase`](../../src/store/open-database.ts).
Verification at the start of the cycle showed better-sqlite3 already
defaults `busy_timeout` to 5000 ms (`node -e "const d = new
require('better-sqlite3')(':memory:'); console.log(d.pragma('busy_timeout',
{simple:true}))"` → `5000`), so the pragma fix was a no-op and was
dropped without writing a vacuous test that asserted on a framework
default.

**Intermittence note for future-Claude.** The actual root cause of
intermittent MCP tool failures observed in the triggering session is
*not* this and is *not* SQLite. Suspects to investigate next: in-process
sync-scheduler concurrency, unhandled promise rejections on outbound
Graph fetches blowing up the listener, or HTTP-layer back-pressure /
keep-alive recycling. None of these were touched here.

## Scope boundary

**In:**
- [src/mcp/tools/classify-error.ts](../../src/mcp/tools/classify-error.ts) — replace loose regexes with HTTP-context-anchored matchers.
- [src/mcp/tools/classify-error.test.ts](../../src/mcp/tools/classify-error.test.ts) — RED tests for the false-positive strings + regression tests for the legitimate auth / delta-invalid strings.

**Out:**
- [src/store/open-database.ts](../../src/store/open-database.ts) — busy_timeout pragma was a no-op (better-sqlite3 default is already 5000 ms). Dropped from the cycle.
- [src/mcp/mcp-server.ts](../../src/mcp/mcp-server.ts) catch block — already does the right thing (redact + return ErrorClass + first line) since `ea1e052`. Not touched.
- The actual unidentified MCP intermittence — deferred to its own investigation cycle.
- WhatsApp ingest visibility, search ergonomics, operational ring buffer — also deferred per the user's "one TDD cycle per fix" cadence choice.

## Files touched

| File | Change |
| --- | --- |
| [src/mcp/tools/classify-error.ts](../../src/mcp/tools/classify-error.ts) | Replaced `(^|[^\d])401([^\d]|$)` with `\b401\s+(unauthorized\|forbidden)\b`, `\b(http\|graph\|yammer\|msal)\s+401\b`, `\bstatus[:= ]\s*401\b`, `^401\b`. Same shape for `410`. |
| [src/mcp/tools/classify-error.test.ts](../../src/mcp/tools/classify-error.test.ts) | +4 tests: AC3 (benign 401), AC4 (benign 410), AC5 (HTTP-anchored 401 regression), AC6 (HTTP-anchored 410 regression). Existing 6 tests still green. |

## Seams

None. `classifyError` is a pure string-in / category-out function. No
Graph, no SQLite, no clock, no fs.

## RED list (as shipped)

- AC3: benign 401 substrings → `unknown-error`
  - test: `does not classify benign 401 substrings as auth`
  - cases: `"took 401ms"`, `"req_id=401"`, `"port 4010 in use"`,
    `"ETIMEDOUT after 4010ms"`, `"checkpoint at offset 401"`
- AC4: benign 410 substrings → `unknown-error`
  - test: `does not classify benign 410 substrings as delta-invalid`
  - cases: `"took 410ms"`, `"graph 4101: foo"`, `"port 4101 in use"`,
    `"offset 410 of 999"`
- AC5: HTTP-anchored 401 → `auth` (regression)
  - test: `still classifies HTTP-anchored 401 patterns as auth`
  - cases: `"401 Unauthorized"`, `"HTTP 401"`, `"Graph 401: token
    expired"`, `"yammer 401"`, `"status: 401"`, `"status=401"`, `"MSAL
    401: refresh failed"`, `"401 Forbidden"`
- AC6: HTTP-anchored 410 → `delta-invalid` (regression)
  - test: `still classifies HTTP-anchored 410 patterns as delta-invalid`
  - cases: `"410 Gone"`, `"HTTP 410 Gone"`, `"Graph 410: cursor
    expired"`, `"status: 410"`, `"status=410"`
- AC7: `TokenExpiredError` → `auth` (already covered by existing test,
  stayed green throughout)

## Verification

- `npm test` → 1304/1304 across 75 files. Coverage on
  [classify-error.ts](../../src/mcp/tools/classify-error.ts):
  100 % statements / 96.66 % branches / 100 % functions / 100 % lines.
- `/security-scan` → PASS. No tracked secrets, no real-data hits, no
  log/error-message leakage in changed files. `npm audit` shows 10
  moderate, 0 high, 0 critical.
- Live verification on the NAS (post-deploy): pick an account whose
  recent `sync_log.last_error` contains a benign `4xx`-shaped digit
  (e.g. timing, port number) and confirm `diagnose_sync_health` no
  longer renders the auth remediation prompt for it.

## Risks

- **Tighter regex misses a legitimate auth string we haven't anticipated.**
  Mitigation: kept all existing positive cases (TokenExpiredError, "401
  Unauthorized", "HTTP 401", "Graph 401: token expired", "yammer 401")
  as regression tests. Added MSAL-prefixed and `status: 401` /
  `status=401` shapes to widen coverage of legitimate cases.
- **Two parallel regex blocks (401 / 410) tempt premature DRY-extraction.**
  Mitigation: per project rules ("three similar lines is better than a
  premature abstraction"), left the two blocks parallel. A third HTTP
  status code with the same shape would justify factoring; two doesn't.

## Out-of-scope follow-ups (open work)

- **Identify the real cause of intermittent MCP failures.** The
  triggering session's symptoms ("MCP unreachable", "tool calls erroring
  out", "intermittent — some queries work, some don't") are still
  unexplained. Next investigation should look at sync-scheduler
  concurrency, Graph-fetch timeout/abort surfacing, and HTTP-layer
  keep-alive behavior under load. Not SQLite contention (ruled out
  here).
- **WhatsApp ingest visibility.** New MCP tool or
  [diagnose-sync-health](../../src/mcp/tools/diagnose-sync-health.ts)
  extension to report last sweep, per-chat counts, recent
  `whatsapp_*_failed` log lines, and pending files in `~/Downloads/`.
  Solves "I have no clue if today's WhatsApp chat landed".
- **Search ergonomics.** Move
  [search](../../src/mcp/tools/search.ts) off strict-phrase FTS5 by
  default (token-AND with phrase as opt-in), and make zero-hit responses
  unambiguous (vs erroring out in the client).
- **Operational ring buffer.** In-memory ring buffer of recent tool
  failures (timestamp, class, redacted line) exposed via
  [diagnose-sync-health](../../src/mcp/tools/diagnose-sync-health.ts),
  so failures can be inspected without SSH-ing to the NAS for PM2 logs.
