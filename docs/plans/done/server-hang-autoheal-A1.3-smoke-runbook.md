# A1.3 — Autoheal smoke runbook

Per-slice TDD plan derived from
[server-hang-autoheal.md §Phase 1.3](server-hang-autoheal.md).

## Goal

Add `docs/runbooks/autoheal-smoke.md` — the manual procedure that proves
autoheal restarts a wedged container — and add the runbooks index to
[docs/README.md](../../../docs/README.md) so future operators (or future
Claude) can find it.

## Scope boundary

**IN:**
- `docs/runbooks/autoheal-smoke.md` (new).
- `docs/runbooks/README.md` (new index for the new directory).
- `docs/README.md` — link to the runbooks index.
- `docs/setup.md` — short pointer + the trust decision for the
  privileged docker.sock mount on the autoheal sidecar.

**OUT:**
- Any code change.
- Any change to `docker-compose.yml` (already done in A1.1 / A1.2).

## Files to touch / create

- `docs/runbooks/autoheal-smoke.md` (new).
- `docs/runbooks/README.md` (new).
- `docs/README.md` — add a "Runbooks" subsection under "For
  contributors".
- `docs/setup.md` — append to §6 Data directory (or new §7 Operations)
  about the autoheal sidecar + trust decision; cross-link to the
  runbook.

## Seams / RED tests

Documentation slice — no `*.test.ts`. Verification:
1. Markdown renders (visual inspection / GitHub preview).
2. Every cross-link resolves: `docs/README.md` → runbooks index;
   runbooks index → autoheal smoke; setup.md → autoheal smoke.

## Risks

- Stale runbook. Mitigation: the runbook itself is the verification
  step for A1 in the parent plan; we run it on the next deploy and
  fix any drift then. Add a "Last verified" date at the top so
  future-me can tell at a glance whether to trust it.

## Definition of done

- `docs/runbooks/autoheal-smoke.md` exists with the exact commands
  to: bring up the stack, confirm both containers, simulate hang
  with `kill -STOP 1`, wait 90s, confirm restart, inspect autoheal
  logs.
- `docs/README.md` and `docs/setup.md` cross-link to it.
- `/security-scan` clean.
- `/docs-update` run.
