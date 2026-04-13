# Weekend 4 — Slice 5: `syncTeams` + scheduler wiring

## Goal

Orchestrate Teams delta sync behind the `TeamsClient` seam, and plug it
into `SyncScheduler` so a tick syncs both outlook + teams per account,
writing `sync_log` rows per (account, source).

## Scope

**IN:**
- `src/sync/sync-teams.ts` — parallels `sync-inbox.ts`:
  - Per-account loop walking `@odata.nextLink` / `@odata.deltaLink`.
  - Maps `TeamsMessage` → `Message` (`source: "teams"`,
    `id = "teams:<account>:<nativeId>"`, sender from `from.user`,
    `body`/`bodyHtml` from `body.contentType`, `threadId` from
    `chatId`, `chatType="channel"` when `channelIdentity` present,
    `replyToId` passthrough, `mentions` extracted from
    `mentioned.user.userPrincipalName ?? displayName ?? mentionText`).
  - Routes `@removed` to `deleteMessages`.
  - Writes `setSyncState({source: "teams"})` with the deltaLink.
  - Propagates `TokenExpiredError` / `DeltaTokenInvalidError` without
    updating sync state.
- `SyncScheduler` grows an optional `teams: TeamsClient` dep. When
  present, `runOnce` calls `syncTeams` per account alongside
  `syncInbox`, appending its own `sync_log` row with `source: "teams"`.
- `src/index.ts` wires a real `HttpTeamsClient` (live smoke still a
  manual follow-up).

**OUT:**
- MCP tool coverage for Teams — slice 6.
- Any fancier `chatType` resolution (oneOnOne/group require a separate
  `/chats/{id}` lookup — deferred).

## RED list

### `syncTeams`
1. First run hits `DEFAULT_TEAMS_DELTA_ENDPOINT`, upserts one Teams
   message with the right id prefix + source, stores deltaLink,
   returns `{added:1, removed:0}`.
2. Subsequent run starts from stored deltaToken.
3. Follows `@odata.nextLink` across pages.
4. `@removed` routes to `deleteMessages` with matching id.
5. Maps `from.user` (displayName/userPrincipalName), `body` text/html,
   `replyToId`, `chatId` → `threadId`, `channelIdentity` →
   `chatType="channel"`, mentions → `string[]`.
6. Propagates `TokenExpiredError` without updating syncState.
7. Propagates `DeltaTokenInvalidError` leaving stored deltaToken intact.

### `SyncScheduler`
8. When `teams` dep is present, `runOnce` with one account appends two
   sync_log rows (`source: "outlook"` + `source: "teams"`).
9. When `teams` dep is absent (backwards-compat), only `source:
   "outlook"` rows appear.
10. An error in teams sync does NOT block outlook sync (both still
    append a row; teams row is `status: "error"`).

## DoD

All tests green, ≥90% line+branch on touched files, security clean,
committed + pushed.

**Auto-approved.**
