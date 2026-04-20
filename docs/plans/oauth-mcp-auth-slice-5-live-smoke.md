# OAuth MCP — Slice 5: Live smoke + docs

Parent: [oauth-mcp-auth.md](oauth-mcp-auth.md)

## Task

Write the operator guide (`docs/oauth.md`), update `PROGRESS.md`, update
the changelog, and update `.env.example`. The live smoke (claude.ai
connector registration + first mobile query) is a manual step documented
in `docs/oauth.md §4`.

## Scope boundary

**In scope:**
- `docs/oauth.md` — operator guide: setup, registration walkthrough,
  admin password rotation, client revocation via `--list-oauth-clients`,
  troubleshooting.
- `PROGRESS.md` — slices 2–5 checked off.
- `docs/changelog.md` — entries for slices 2–5.
- `.env.example` review / update (already updated in slice 1; verify completeness).

**Out of scope:**
- CLI `--list-oauth-clients` / `--revoke-oauth-client` (deferred per parent plan).
- Rate limiting on `/oauth/register`.
