---
name: docs-update
description: Update the /docs folder at the end of a coding task. Use immediately after a `/tdd-cycle` completes (or any meaningful workspace change) to refresh the changelog, setup, getting-started, or user guide as needed. Invoke proactively — documentation staleness is a bug.
---

# /docs-update — waldo.WTF documentation enforcer

This skill runs at the END of every coding task, after `/tdd-cycle` has
finished. It ensures the `/docs` folder stays in sync with the code and the
[PROGRESS.md](../../../PROGRESS.md) log.

## Step 0 — Load the docs index

Re-read [docs/README.md](../../../docs/README.md) so you know which files
exist and what each one is for.

## Step 1 — Classify the change

Answer in chat, then let the answers drive which files you touch:

1. **What changed?** One sentence.
2. **Is it user-visible?** (new MCP tool, new config env var, new CLI
   flag, new workflow, changed error message, changed defaults, changed
   file layout) → yes/no
3. **Does it change setup steps?** (new dependency, new Entra
   permission, new env var, new volume mount) → yes/no
4. **Does it change the getting-started flow?** (anything in the
   five-minute happy path) → yes/no
5. **Is it a new surface users should know about?** (new prompt pattern,
   new source, new troubleshooting entry) → yes/no
6. **Does it touch project scope, status, or architecture?** (new
   source, new MCP tool, new non-goal, new deployment target, new
   runtime dep, weekend milestone complete, new top-level doc) → yes/no
   If yes → the root [README.md](../../../README.md) must be updated.

## Step 2 — Always update the changelog

Every task that touched code or docs gets a changelog entry. Never skip
this.

Open [docs/changelog.md](../../../docs/changelog.md):

- If there's already an entry for today's date at the top, append a
  bullet to it.
- If not, create a new `## YYYY-MM-DD` section at the top (reverse
  chronological — newest first).
- Bullets are **summier**: one line, past tense, plain English, link to
  the most relevant file or PROGRESS.md milestone. No prose paragraphs.

Good:
```
## 2026-04-13

- Added `get_thread` MCP tool with FTS5-backed resolution by thread_id.
- Migration 003 adds `thread_name` FTS column; rebuild required on upgrade.
```

Bad (too verbose, reads like commit message):
```
## 2026-04-13

- Today I worked on adding a new MCP tool called get_thread that takes
  a thread ID and returns all the messages in that conversation. This
  was needed because Claude was having trouble...
```

## Step 3 — Update setup.md if setup changed

If Step 1 Q3 = yes:

- New env var → add to the `.env` block in [docs/setup.md §3](../../../docs/setup.md).
- New dependency → add to §1 prerequisites and/or §4 install.
- New Entra permission → add to §2 step 6.
- New volume or file path → add to §6 data directory.
- New troubleshooting case → append to the Troubleshooting section.

## Step 4 — Update getting-started.md if the five-minute path changed

If Step 1 Q4 = yes:

Touch the minimum needed to keep the happy path accurate. Anything
optional or advanced belongs in setup.md or user-guide.md, NOT here.
Getting-started stays five minutes long, always.

## Step 5 — Update user-guide.md if users should know

If Step 1 Q5 = yes:

- New MCP tool → add to §2 "The MCP tool surface" with name, purpose,
  typical prompts.
- New workflow → add to §4 "Daily workflows" with a real example prompt.
- New error mode → add a row to §9 Troubleshooting table.
- New don't-do-this lesson → add to §10.

## Step 6a — Update the root README.md if scope, status, or architecture changed

If Step 1 Q6 = yes, update [README.md](../../../README.md):

- **Scope change** → update the "What it is NOT" list, or the
  architecture paragraph, or the one-sentence test.
- **Status change** → update the "Status" paragraph (current weekend,
  what's proven, what's next).
- **Architecture change** → update the architecture paragraph and the
  documentation map if new docs were added.
- **New top-level doc** → add it to "Start here" or "Documentation map".
- **New non-goal** → add it to "What it is NOT".

The README is the project's front door. A stale front door is worse
than no front door.

## Step 6b — Update the docs index if files moved or were added

If you added or removed a file under `/docs/`, update
[docs/README.md](../../../docs/README.md) so it points to every file
that exists and none that don't.

## Step 6c — Archive the plan

If this task had a plan file at `docs/plans/<name>.md` and the slice /
task is now complete (tests green, docs updated, ready to ship),
**move the plan to `docs/plans/done/<name>.md`**.

- Use `git mv docs/plans/<name>.md docs/plans/done/<name>.md` so the
  history is preserved.
- Update every reference to the old path in this repo (PROGRESS.md,
  changelog.md, other docs, skill files) to point at
  `docs/plans/done/<name>.md`. A forgotten link is a broken link.
- `docs/plans/` stays for in-flight plans only. `docs/plans/done/` is
  the archive. An agent scanning `docs/plans/` should see only work
  that is still open.
- If the task was abandoned rather than completed, do NOT move — leave
  it in `docs/plans/` with a one-line note at the top explaining why.
  Only finished slices move to `done/`.
- If a plan covers multiple slices and only some are done, leave it in
  `docs/plans/` until the last slice closes.

## Step 7 — Cross-reference check

Before marking done, run these checks:

- [ ] If scope / status / architecture changed, the root
      [README.md](../../../README.md) reflects it.
- [ ] Every new file under `/docs/` is linked from
      [docs/README.md](../../../docs/README.md).
- [ ] The changelog bullet links to the most relevant doc or to
      PROGRESS.md.
- [ ] No doc still references something you just removed (grep for the
      old name).
- [ ] No doc mentions a feature that was reverted.
- [ ] Dates are absolute (`2026-04-13`), never relative (`today`,
      `yesterday`, `last week`).

## Step 8 — Report

Post a short summary in chat:

```
Docs updated.
- Changelog: appended <N> bullets to YYYY-MM-DD
- Root README: <changed sections | unchanged>
- Setup: <changed sections | unchanged>
- Getting started: <changed | unchanged>
- User guide: <changed sections | unchanged>
- Docs index: <updated | unchanged>
- Plan archived: <docs/plans/done/<name>.md | n/a — plan still in-flight>
```

---

**Reminder**: documentation that doesn't get updated at the moment of the
change never gets updated. This skill is not optional. If a `/tdd-cycle`
completes without a `/docs-update`, the task is not done.
