# Weekend 4 — Slice 6: MCP tool coverage for Teams source

## Goal

Make the existing MCP tools (`get_recent_activity`, `search`,
`get_sync_status`) first-class for Teams messages so a Claude Desktop
caller can query them just like outlook. Close Weekend 4.

## Scope

**IN:**
- Extend `ProjectedMessage` in `get-recent-activity.ts` to carry the
  Teams-specific optional fields: `chatType`, `replyToId`, `mentions`.
  Snippet falls back to `bodyHtml` (stripped or truncated) when `body`
  is undefined, so Teams HTML messages don't render as empty blobs.
- `search` handler projection: same extension + same bodyHtml fallback
  so FTS hits surface Teams content.
- `get_sync_status` already unions `(account, source)` pairs — verify
  it emits Teams rows and add tests for a mixed outlook+teams dataset.

**OUT:**
- No new MCP tools.
- No schema changes.
- No FTS5 reshape.

## RED list

### `get_recent_activity`
1. Returns a Teams message with `source: "teams"`, `chatType`,
   `replyToId`, `mentions` preserved in the projection.
2. `sources: ["teams"]` filter returns only teams rows.
3. When `body` is undefined but `bodyHtml` is present, snippet is
   derived from `bodyHtml` (≤ SNIPPET_MAX chars).

### `search`
4. A Teams hit projects `source: "teams"` and preserves Teams fields
   (`chatType`, `replyToId`, `mentions`).
5. Snippet falls back to `bodyHtml`-derived value when `body` absent
   (search uses FTS snippet so keep the hit's snippet as-is when
   present; fallback only for the message-level snippet field).

### `get_sync_status`
6. With mixed outlook + teams `sync_log` rows for one account, returns
   two entries `(outlook, teams)` with correct `lastStatus` /
   `messagesAddedLast24h`.

## DoD

All tests green, ≥90% line+branch on touched files, security clean,
committed + pushed. Closes Weekend 4.

**Auto-approved.**
