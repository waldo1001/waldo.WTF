# Weekend 3 — Slice 5: Claude Desktop wiring doc

## Goal

Give operators a verifiable recipe to point Claude Desktop at the local
`waldo.WTF` MCP HTTP server, so the "wtf is going on" prompt actually
lands in Claude. Ticks the last open Weekend 3 checkbox
("Wired into Claude Desktop").

## What already exists

- [docs/getting-started.md §6](../getting-started.md) has the basic
  `claude_desktop_config.json` snippet (from Weekend 2).
- [docs/user-guide.md §2+§3](../user-guide.md) documents the tool
  surface and the recommended system prompt.

## What's missing

- A single page dedicated to wiring + verification: how to confirm the
  server is up, how to curl `/health`, how to JSON-RPC `tools/list` with
  bearer, and what to do when Claude Desktop says "no tools". This is
  operator doc, not code.
- A clear statement that only three tools exist in this release
  (`get_recent_activity`, `get_sync_status`, `search`) — the rest of
  user-guide.md §2 is forward-looking.

## Scope

**In**
- New `docs/claude-desktop-wiring.md` with: prereqs, config snippet,
  curl verification for `/health` and `tools/list`, troubleshooting
  table, pointer to the system prompt in user-guide.md.
- Link from `docs/getting-started.md §6` and `docs/user-guide.md §2`.
- Changelog entry.
- Tick "Wired into Claude Desktop" + "End-to-end test" on PROGRESS.md
  (the e2e test landed in slice 4).

**Out**
- No code changes. No new tests.
- Not duplicating the system prompt — the one in user-guide.md is the
  canonical copy.
