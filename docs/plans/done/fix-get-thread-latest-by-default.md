# Fix: `get_thread` returns the latest N messages by default

## Task

Change `get_thread`'s default behavior so a call with no extra
parameters returns the **most recent N messages** (in chronological
order within the slice), instead of the oldest N. Add an explicit
`from_start: boolean` parameter so the old behavior is still reachable
for callers who really want the start of a long conversation.

## Context

A live session today hit this exact bug. The user asked Claude
Desktop to "summarize today's conversations on BC Dev Talk on
WhatsApp". The model called `get_thread(thread_id, limit=500)` against
a 1697-message thread, got messages 1–500 (oldest first), saw the
most recent `sentAt` was 2 April, and concluded — incorrectly — that
the WhatsApp ingest had been broken for a month.

The WhatsApp ingest was fine. `WhatsApp Chat - BC Dev Talk.zip` was
imported at 17:49 UTC today and archived under
`/data/whatsapp-archive/2026-05/`. Today's messages are in the DB at
positions ~1500–1697 of the thread. The current `get_thread` cannot
reach them: no pagination, no offset, no descending order, hard cap
at `MAX_GET_THREAD_LIMIT=500`. There is literally no parameter
combination that returns "today's BC Dev Talk messages" through this
tool right now.

The current behavior is broken for almost every plausible use case:
- "what's been said in this thread" → wrong (gets the start)
- "summarize the conversation" → wrong (only the early part)
- "what happened today" → impossible if thread > limit
- "find a quote about X" → only finds early-thread quotes

The only use case the current default is right for is "how did this
thread start". That's a real use case but it's the exception, not the
rule. So we make the common case the default.

## Goal

After this cycle, `get_thread(thread_id)` with no extra params
returns the most-recent 200 messages of the thread, sorted
chronologically (oldest → newest *within the slice*) so the model
reads them in natural order. The old "oldest from the start" behavior
is opt-in via `from_start: true`.

## Scope boundary

**In:**
- [src/store/message-store.ts](../../src/store/message-store.ts) — add `fromStart?: boolean` to `GetThreadOptions`.
- [src/store/sqlite-message-store.ts](../../src/store/sqlite-message-store.ts) — branch SQL on `fromStart`. Default (false): inner-select latest N by `sent_at DESC, id DESC` then outer-select chronologically. `fromStart=true`: existing `ASC` query.
- [src/store/message-store-contract.ts](../../src/store/message-store-contract.ts) — RED tests for the new default behavior, regression tests for `fromStart: true`. Existing "oldest rows first" assertion updated to use the explicit `fromStart: true`.
- [src/mcp/tools/get-thread.ts](../../src/mcp/tools/get-thread.ts) — add `from_start?: boolean` to `GetThreadParams` + schema; validate; plumb to store; rewrite tool description to make the new default loud.
- [src/mcp/tools/get-thread.test.ts](../../src/mcp/tools/get-thread.test.ts) — RED tests for the new param's validation, plumbing, and tool description claim.

**Out:**
- True pagination (`offset` / `cursor`) — useful but bigger; deferred. The 200/500 limits remain unchanged for now.
- Changing limits — same defaults (200/500), same semantics, just sliced from the *end* instead of the *start*.
- Search / get_recent_activity / list_threads — unrelated.
- The deferred root-cause-of-wedge investigation — still pending the next watchdog event.

## Files to touch

| File | Change |
| --- | --- |
| [src/store/message-store.ts](../../src/store/message-store.ts) | Add `fromStart?: boolean` to `GetThreadOptions`. |
| [src/store/sqlite-message-store.ts](../../src/store/sqlite-message-store.ts) | Branch the SQL: `fromStart=true` → existing `ORDER BY sent_at ASC, id ASC LIMIT ?`. Default → `SELECT * FROM (SELECT … ORDER BY sent_at DESC, id DESC LIMIT ?) ORDER BY sent_at ASC, id ASC` so caller still reads chronologically. |
| [src/store/message-store-contract.ts](../../src/store/message-store-contract.ts) | Add 3 tests: "default returns the LATEST N", "default still returns chronologically within the slice", "fromStart:true returns the FIRST N (regression of old behavior)". Update the existing "oldest rows first" test to pass `fromStart: true` explicitly. |
| [src/mcp/tools/get-thread.ts](../../src/mcp/tools/get-thread.ts) | Add `from_start?: boolean` param + schema + validation. Plumb to store. Rewrite description: lead with "by default returns the most recent N messages in chronological order"; document `from_start: true` for the old behavior. |
| [src/mcp/tools/get-thread.test.ts](../../src/mcp/tools/get-thread.test.ts) | Add tests for: from_start validation (boolean only), default plumbs `fromStart` undefined, `from_start: true` plumbs `fromStart: true`. |

## Seams

Already in place — `MessageStore` interface, contract test suite, fake `MessageStore` for unit tests of the tool handler. Nothing new needed.

## RED list

**A. message-store-contract.ts**

1. `it("getThread by default returns the LATEST N messages of a long thread, ordered chronologically within the slice")` — insert 10 messages with `sent_at` 2026-01-01 → 2026-01-10. Call `getThread({ threadId, limit: 3 })` with no `fromStart`. Assert returned messages are days 8, 9, 10 in that order (asc within the slice).
2. `it("getThread with fromStart: true returns the FIRST N messages of a long thread")` — same fixture. Call with `fromStart: true, limit: 3`. Assert returned messages are days 1, 2, 3 (current behavior). Pin the regression.
3. `it("getThread default returns the full thread asc when limit >= total messages")` — fixture with 5 messages, default behavior, limit omitted (so 200 default). All 5 returned, asc — the slice happens to be the full thread.

**B. get-thread.test.ts**

4. `it("validates from_start as a boolean only")` — non-boolean values throw `InvalidParamsError`.
5. `it("plumbs fromStart=undefined to the store when from_start is omitted (new default)")`.
6. `it("plumbs fromStart=true to the store when from_start: true is passed")`.

## Risks

- **Behavior change for any prompt or downstream code that relied on the old default returning the start of the thread.** Mitigation: the `from_start: true` opt-in is a one-line change for any caller that genuinely needed the old behavior, and the tool description loudly explains the new default + the opt-in. Internal callers searched: only the test suite calls `getThread` directly; production callers go through the MCP tool surface.
- **Tool description must be loud enough that the model passes `from_start: true` when the user really asks for "how did this thread start".** Mitigation: explicit example in the description, and the parameter's own description names the use case ("for the rare case the user asks how a long conversation began").
- **The inner-select-then-reorder SQL is one extra ORDER BY pass.** Mitigation: we sort at most `limit` rows (≤500), not the whole thread. Performance impact is negligible vs the FTS5 / message lookup cost.

## Verification

1. `npm test` — full suite green; coverage ≥ 90 % on touched files.
2. `/security-scan` — must PASS (no fixtures with real data).
3. `/docs-update` — changelog entry; user guide update if `get_thread` is documented there.
4. `/local-smoke` — boot path still works, `tools/list` still returns `get_thread`, schema still parses.
5. Commit + `/deploy-nas`.
6. **Live verification**: re-run "summarize today's conversations on BC Dev Talk" in Claude Desktop. The model should now call `get_thread` with no `from_start` flag, get today's messages, and produce a real summary instead of "the sync is broken".
