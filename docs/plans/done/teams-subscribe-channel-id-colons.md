# Plan — `--teams-subscribe` accept real channel IDs (with colons)

## Task

Fix `parseTeamChannelKey` in `src/cli.ts` so that `--teams-subscribe` and
`--teams-unsubscribe` accept real Microsoft Graph channel IDs (which always
start with `19:` and therefore contain at least one colon themselves).

## Scope boundary

**IN**

- Update `parseTeamChannelKey` to recognize the canonical Graph channel-id
  prefix `19:` and treat the remainder as a single `channelId`, regardless of
  embedded colons.
- New RED tests covering both 2-part and 3-part forms with realistic
  `19:<x>@thread.tacv2` IDs.
- Regression test that the synthetic forms used elsewhere in the suite
  (e.g. `team-1:chan-1`) still parse.

**OUT**

- Replacing the colon separator with anything else (would be a breaking
  change for everyone already scripting against the CLI).
- Generalising to non-`19:` channel-id prefixes — Graph today only emits
  `19:`. If that ever changes, follow up.
- Touching `--viva-subscribe` (different parser, no colon-in-id today).

## Files to create / touch

- `src/cli.ts` — `parseTeamChannelKey` body.
- `src/cli.test.ts` — add RED tests next to the existing
  `rejects --teams-subscribe value without ':' separator` block (around line
  1290) and the realTeams subscribe describe (around line 2817).
- `docs/changelog.md` — bullet under today.
- `docs/user-guide.md` — if it documents the `<teamId>:<channelId>` shape,
  add a note that real Graph IDs (with `19:` prefix) are supported.

## Seams involved

None. Pure pure-function parser change.

## RED test list

- AC1 — `--teams-subscribe ff45...:a670...:19:abc@thread.tacv2 --account x`
  parses to `{ tenantId: "ff45…", teamId: "a670…", channelId: "19:abc@thread.tacv2" }`.
  Test file: `src/cli.test.ts`. Test name: `"--teams-subscribe accepts real
  channel id with embedded colon (3-part form)"`. Edge cases: channelId
  contains both `:` and `@`.
- AC2 — `--teams-subscribe a670...:19:abc@thread.tacv2 --account x` parses
  to `{ teamId: "a670…", channelId: "19:abc@thread.tacv2" }` (no
  `tenantId`). Test name: `"--teams-subscribe accepts real channel id with
  embedded colon (2-part form)"`.
- AC3 — `--teams-unsubscribe` accepts the same two shapes (the same parser
  is used). Test name: `"--teams-unsubscribe accepts real channel id with
  embedded colon"`.
- AC4 (regression) — `team-1:chan-1` still parses (existing tests must keep
  passing).

## Open questions / assumptions

- Assumption: channel IDs always start with `19:`. Confirmed against
  production discover output for dynex.be, ifacto.be, and
  turnhoutbasketbal tenants.
- Assumption: tenantId and teamId are GUIDs (no colons). Confirmed by
  production discover output.

## Risks

- If Microsoft introduces a new channel-id prefix (`20:`, etc.), the
  heuristic would mis-parse. Low likelihood; would manifest as a
  `unknown channel` error from the impl rather than silent mis-store.
- Changing parser shape could regress synthetic-id tests. Mitigation:
  AC4 explicit regression test, plus full suite must stay green.

## Out-of-scope follow-ups

- Reconsider CLI separator scheme entirely (e.g. `--teams-subscribe-team
  <id> --teams-subscribe-channel <id>`). Not now — not worth the breaking
  change.
- Apply the same heuristic to any future source whose IDs contain `:`.
