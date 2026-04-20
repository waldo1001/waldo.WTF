# Fix message bodies — Slice B: expose full bodies through MCP

## Goal

Let Claude actually *read* the full text of a mail or chat, not just
preview it. Slice A fixed FTS indexing and snippet quality in place;
Slice B wires full-body access into the MCP tool surface.

## Scope boundary

**In scope:**
- New optional `include_body: boolean` parameter on `get_thread` and
  `search` (default `false`). When `true`, each projected message
  carries `body` (plain text) up to a per-message cap.
- Per-message body cap `MAX_BODY_CHARS = 50_000` to protect Claude's
  context. Truncation is marked with a trailing `"… [truncated]"` and
  the projection carries `bodyTruncated: true`.
- Per-call total cap `MAX_TOTAL_BODY_CHARS = 400_000` (≈100k tokens
  worst case). When exceeded, subsequent messages in the same response
  return no body (as if `include_body=false` for them) and the result
  carries a top-level `bodyBudgetExhausted: true` flag.
- Tool JSON schemas + tool descriptions updated so Claude knows the
  flag exists and when to use it.
- `get_recent_activity` is **not** touched. Its purpose is "what's
  happening lately" — a summary tool, not a reading tool. Surfacing
  full bodies there would balloon context on the default flow.
- `get_message(id)` is **not** added. `get_thread` with
  `include_body=true` + a single-ID query covers the "read this one"
  case, and a new tool would be redundant. (Revisit if live use shows
  friction.)

**Out of scope:**
- Any change to the store schema or disk format. The column is already
  there (`messages.body`, populated by Slice A).
- Any change to the backfill or the sync mapper.
- Any change to `get_sync_status` or `list_accounts`.
- Body truncation cleverness (summarization, head+tail, etc.). Plain
  head-truncation with a sentinel is enough for v1.
- Returning `bodyHtml`. Plain text only — Claude doesn't want HTML and
  Slice A populated `body` precisely so we wouldn't have to serve HTML.

## Files to touch

- `src/mcp/tools/get-thread.ts` — add `include_body` param to the
  schema and handler; project `body` (truncated) when requested.
- `src/mcp/tools/get-thread.test.ts` — add cases for the flag on and
  off, truncation, budget exhaustion.
- `src/mcp/tools/search.ts` — same treatment.
- `src/mcp/tools/search.test.ts` — same.
- `src/mcp/tools/body-projection.ts` — **new**, shared helper
  `projectBody(m, budget)` returning `{ body?, bodyTruncated?, consumed }`
  so both tools share one truncation policy.
- `src/mcp/tools/body-projection.test.ts` — **new**, unit tests for
  the truncation/budget helper (pure function, easiest RED).
- `src/mcp/e2e-http.test.ts` — add an end-to-end assertion that
  `get_thread` with `include_body: true` returns readable text through
  the full HTTP + SDK stack.
- `docs/user-guide.md`, `docs/claude-desktop-wiring.md` — advertise the
  new flag so operators know the capability exists.
- `docs/changelog.md`, `PROGRESS.md` — dated entry.

## Seams involved

none — all changes are in the MCP tool handler layer, which is already
injected with `MessageStore` and `Clock`. No new store methods, no new
Graph calls, no new fs/network.

## RED test list

### `body-projection.test.ts` (pure helper)
1. `projectBody(m, budget)` with no body → returns `{ consumed: 0 }`, no
   `body` field.
2. With a short body (< MAX_BODY_CHARS, < budget) → returns full body,
   `consumed = body.length`, no `bodyTruncated`.
3. With a body longer than MAX_BODY_CHARS → returns head-truncated body
   ending in `"… [truncated]"`, `bodyTruncated: true`, `consumed =
   MAX_BODY_CHARS`.
4. With a budget already exhausted (`budget <= 0`) → returns no body,
   `consumed = 0`.
5. With a budget that can fit part of a short body but not all of it →
   returns no body at all (don't ship half a message), `consumed = 0`.
   (Rule: a message is either full or absent, never partial at the
   budget layer. Per-message truncation is only driven by
   `MAX_BODY_CHARS`.)

### `get-thread.test.ts` (additions)
6. `handleGetThread({ threadId, include_body: false })` → projection has
   no `body` field (existing behavior preserved).
7. `handleGetThread({ threadId, include_body: true })` on a 3-message
   thread with short bodies → every projected message has `body`
   populated, no `bodyBudgetExhausted` flag.
8. `handleGetThread({ threadId, include_body: true })` on a thread where
   one message has a > 50 000-char body → that message has
   `bodyTruncated: true` and `body` ends with the sentinel; others are
   unchanged.
9. `handleGetThread({ threadId, include_body: true })` on a thread whose
   combined bodies exceed the per-call budget → earlier messages carry
   `body`, later ones don't, result has `bodyBudgetExhausted: true`.
10. Default (`include_body` omitted) behaves as `false` — regression
    guard against accidental breakage of existing callers.
11. Invalid `include_body` (non-boolean) → `InvalidParamsError`.

### `search.test.ts` (additions)
12. `handleSearch({ query, include_body: false })` → no body field
    (existing).
13. `handleSearch({ query, include_body: true })` → each hit carries
    `body`.
14. Budget exhaustion with many long hits → later hits omit `body`,
    top-level `bodyBudgetExhausted: true`.

### `e2e-http.test.ts` (addition)
15. End-to-end through `StreamableHTTPServerTransport`: call
    `get_thread` with `include_body: true` on a seeded thread, assert
    the JSON response carries readable plain text in `messages[i].body`.

## Risks

- **R1: Claude's context blows up on a thread with 40 long mails.**
  Mitigation: the 400 000-char per-call budget + per-message 50 000-char
  cap. Worst case one response ≈ 100k tokens, below Claude's window.
- **R2: `include_body=true` becomes the default Claude usage.** That's
  fine — the budget cap is the backstop. If operator reports friction,
  raise the cap or add head+tail truncation in a follow-up.
- **R3: The sentinel `… [truncated]` gets treated as literal content by
  downstream callers.** Mitigation: the `bodyTruncated: true` flag is
  the machine-readable signal; the sentinel is only for human/LLM
  readability. Document both in the tool description.
- **R4: `get_recent_activity` users want `include_body` too.** Defer to
  Slice C if live use shows it. Slice B's principle is "reading tools
  get bodies; summary tools don't".

## Definition of done

- All RED tests green; coverage ≥90% line + branch on touched files.
- `/security-scan` clean (no real-data in new fixtures).
- `/docs-update` — changelog + user-guide + claude-desktop-wiring
  entries.
- Manual smoke via Claude Desktop against the NAS (after the Slice A
  backfill has run):
  - *"Show me the full Sponsoravond thread"* → Claude calls `get_thread`
    with `include_body: true` and summarizes actual content, not just
    subject lines.
  - *"Search my mail for <rare word> and tell me what it says"* →
    Claude calls `search` with `include_body: true` on the top hit
    and quotes the actual text.

## Constants (proposed; open to change)

- `MAX_BODY_CHARS = 50_000` per message.
- `MAX_TOTAL_BODY_CHARS = 400_000` per call.
- Sentinel: `"\n\n… [truncated]"` appended after truncation.
- Param name: `include_body` (snake_case to match existing tool params
  like `thread_id`).
