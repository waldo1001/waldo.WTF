# waldo.WTF

> **W**hat **T**o **F**ocus — *a personal context server that lets Claude
> answer "what the f\*\*\* is going on in my life?"*

A single, private, always-on service that pulls messages from all the
places [waldo](https://waldo.be) actually gets pinged — Microsoft Teams
and Outlook across multiple tenants, plus WhatsApp exports, plus
whatever else later — into one unified local SQLite "lake", and exposes
it to Claude via an HTTP MCP server. Ask *"wtf is going on in my life?"*
and get a genuinely useful triage across everything at once.

---

## Why this exists

waldo lives in ~4 different Microsoft accounts (iFacto, Dynex, customer
tenants, personal) plus a phone full of WhatsApp chats that matter.
"Did I miss something important?" currently means logging in and out of
multiple places all day. Off-the-shelf tools don't fit because they're
single-account, stateless, can't unify across sources, and live
WhatsApp integration is ToS-risky.

**The one-sentence test** for any feature: *does this make "wtf is
going on in my life?" return a better answer?* If no, it doesn't get
built.

## What it is NOT

- Not a Teams/Outlook client replacement (no writing, no replying, no
  UI — read-only forever).
- Not a notification system (that's the
  [TeamsChatNotifier](https://github.com/waldo1001/waldo.TeamsChatNotifier),
  this is its smarter successor).
- Not a generic M365 MCP server (softeria/ms-365-mcp-server already
  exists and is great for simple cases).
- Not a shared or multi-user tool.
- Not a live WhatsApp automation — manual export only, zero ban risk.

## Architecture in one paragraph

One Node + TypeScript process, one SQLite file (WAL mode, via
`better-sqlite3`), two logical components sharing the db: a sync worker
(MSAL-authed Microsoft Graph delta queries, 5-minute polling, multi-account)
and an HTTP MCP server (bearer-token auth, five read-only tools:
`get_recent_activity`, `search`, `get_thread`, `list_accounts`,
`get_sync_status`). Runs locally during development, eventually on a
Synology NAS behind Tailscale. Claude does all the summarizing — tools
return raw rows, Claude reasons over them.

Full architecture and decision rationale: [project brief §3–4](waldo.WTF-project-brief.md).

## Status

Weekend 2 closing. TypeScript project scaffolded, all core seams
(clock, fs, Graph, auth, store, sync, HTTP) landed behind unit tests,
and `main()` wires real MSAL + SQLite + a skeleton `node:http` MCP
transport shell. The one deferred piece is the real Graph HTTP
adapter — until it lands, `main()` wires a `NotImplementedGraph`
stub. Next: real Graph client, then Weekend 3 MCP tools
(`get_recent_activity`, `search`, `get_sync_status`).

Live progress: [PROGRESS.md](PROGRESS.md). Recent changes:
[docs/changelog.md](docs/changelog.md).

---

## Start here

- **New to the project?** Read the [project brief](waldo.WTF-project-brief.md) (~15 min).
- **Want to run it?** [docs/getting-started.md](docs/getting-started.md) is the five-minute happy path; [docs/setup.md](docs/setup.md) is the full version.
- **Want to use it day-to-day?** [docs/user-guide.md](docs/user-guide.md).
- **Want to contribute code (human or Claude)?** Read [CLAUDE.md](CLAUDE.md), then [docs/tdd/methodology.md](docs/tdd/methodology.md).

## Documentation map

Single index: [docs/README.md](docs/README.md). Everything — user
guides, TDD methodology, testability patterns, AI-maintainability
rules, coverage policy, changelog — is linked from there.

## Working in this repo

Every code change follows the TDD cycle defined in
[CLAUDE.md](CLAUDE.md). Non-negotiable:

```
FRAME → RED → PROVE RED → SCAFFOLD → GREEN → REFACTOR → COVER → SECURITY SCAN → UPDATE DOCS → REVIEW
```

Three repo-local skills enforce it:

- [`/tdd-cycle`](.claude/skills/tdd-cycle/SKILL.md) — start of any coding task.
- [`/security-scan`](.claude/skills/security-scan/SKILL.md) — gates the cycle before docs; blocks on any leak.
- [`/docs-update`](.claude/skills/docs-update/SKILL.md) — end of any coding task.

GitHub Copilot (Chat, inline, Coding Agent, Copilot for PRs) follows the
**same** toolchain via [.github/copilot-instructions.md](.github/copilot-instructions.md)
— which points at the files above rather than duplicating them.

Drop-in Vitest toolchain (config, deps, example fakes) lives in
[testing/](testing/) and will be copied into the TypeScript project at
Weekend 2.

## Security

waldo.WTF holds refresh tokens for multiple Microsoft tenants and
message bodies from customer-tenant guest accounts. Treat the data like
credentials:

- Read-only forever. No write tools in the MCP surface.
- Tailscale-only. Never exposed on the public internet.
- Bearer token on every MCP request, on top of the Tailscale lock.
- `.env`, `token-cache.json`, `accounts.json`, `lake.db` all gitignored
  from day one.
- Full-disk encryption on every machine that holds `lake.db`.

Full security notes: [project brief §9](waldo.WTF-project-brief.md).

---

## Maintaining this README

This file is the project's front door. Keep it accurate. It must be
updated whenever:

- the **scope** changes (new source, new tool, new deployment target,
  new non-goal)
- the **status** materially changes (weekend complete, new milestone,
  deployment moved from Mac → NAS)
- the **architecture** changes (new seam, removed component, new
  runtime dependency)
- a **new top-level document** is added under `/docs` or the repo root
- the **one-sentence test** or a **non-goal** changes

The [`/docs-update`](.claude/skills/docs-update/SKILL.md) skill
explicitly checks this file as part of its Step-1 classification.

## Author

Eric "waldo" Wauters — [waldo.be](https://waldo.be),
[github.com/waldo1001](https://github.com/waldo1001). Founding partner
& Development Manager at iFacto Business Solutions, Microsoft MVP for
Business Central.
