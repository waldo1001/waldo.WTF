# A1.1 — Autoheal sidecar in docker-compose.yml

Per-slice TDD plan derived from
[server-hang-autoheal.md §Phase 1.1](server-hang-autoheal.md).

## Goal

Add a `willfarrell/autoheal` sidecar to `docker-compose.yml` and tag the
existing `waldo` service with `autoheal=true` so the sidecar restarts
the container when its healthcheck reports unhealthy 3× in a row.

## Scope boundary

**IN:**
- `docker-compose.yml` only.
- New `autoheal` service block.
- New `labels: [autoheal=true]` on the `waldo` service.

**OUT:**
- Healthcheck shell rework (that's slice A1.2).
- Smoke runbook (that's slice A1.3).
- Anything in `src/`.

## Files to touch

- `docker-compose.yml` — add second service + label.

## Seams / RED tests

This is pure infra config — no application code. The methodology
explicitly carves out an exception (see plan §Slice 1.1 *RED tests*:
"N/A — this is infra config, not application code"). Verification is:
- the compose file parses (`docker compose config`),
- both services appear in the rendered config,
- the `waldo` service carries `autoheal=true` in its labels.

We can run `docker compose config` locally on macOS without spinning
up containers. That's the closest thing to a programmatic check and
it's what we'll use to "prove red → green" — by editing in stages
and confirming the rendered config has the right shape.

## Risks

- Privileged docker-socket mount on the autoheal sidecar. Documented
  trust decision; image is the well-known willfarrell/autoheal
  (~5M+ pulls). Single-tenant home NAS, blast radius acceptable.
- Compose syntax error breaks `docker compose up` on next deploy.
  Mitigation: `docker compose config` before commit.

## Out of scope

- Hardening the healthcheck (slice A1.2).
- Documenting the trust decision in `docs/setup.md` — that lands
  with the smoke runbook in slice A1.3 so the docs update is one
  coherent edit.

## Definition of done

- `docker-compose.yml` includes the `autoheal` service.
- `waldo` service has `labels: [autoheal=true]`.
- `docker compose config` succeeds and the rendered config shows
  both services and the label.
- `/security-scan` clean (no secrets in compose).
- `/docs-update` run.
