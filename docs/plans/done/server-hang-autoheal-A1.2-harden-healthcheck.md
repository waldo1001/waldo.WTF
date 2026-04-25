# A1.2 — Harden the healthcheck

Per-slice TDD plan derived from
[server-hang-autoheal.md §Phase 1.2](server-hang-autoheal.md).

## Goal

Replace the `node -e "fetch(...)"` healthcheck with a `node:http`-based
check that has its own explicit `timeout` and `process.exit(1)` on every
error path. Goal: a wedged event loop must never make the *healthcheck*
itself hang and waste the autoheal sidecar's verdict cycles.

## Scope boundary

**IN:**
- `docker-compose.yml` healthcheck block of the `waldo` service.

**OUT:**
- `src/`, runbook (A1.3), or autoheal sidecar (already in A1.1).

## Files to touch

- `docker-compose.yml` — swap `test:` to a `CMD-SHELL` invocation that
  uses `node`'s built-in `http.request({timeout: 3000})` and exits
  non-zero on timeout/error/non-200.

## Seams / RED tests

Same infra-config exception as A1.1: there are no `*.test.ts` for a
healthcheck shell command. The plan §1.2 explicitly carves out
"Manual: `docker exec waldo-wtf <the test cmd>` returns 0 on healthy
server, 1 on stopped server" as the verification.

For this slice we'll verify:
1. `docker compose config` still parses cleanly.
2. The exact `node --eval` script executes successfully against the
   running production server (verified during the A1 cross-slice
   deploy gate, slice 4 in the parent todo).
3. The script exits 1 within ~3s when the target is unreachable
   (sanity-checked locally against `127.0.0.1:1` or any closed port).

## Risks

- A typo in a long single-line `node --eval` is hard to read in YAML
  and easy to miss. Mitigation: keep the script short; verify by
  pasting into a local `node --eval` invocation against `127.0.0.1:1`
  to confirm "errors fast and exits 1" behavior before committing.
- `node:http` doesn't follow redirects. `/health` on this app already
  returns 200 directly, so this is fine, but document the constraint
  in the YAML comment so a future redirect addition forces a
  conscious revisit.

## Definition of done

- `docker compose config` succeeds.
- Local sanity check: the same script run against a port nothing is
  listening on exits with status 1 in <3s.
- `/security-scan` clean.
- `/docs-update` run.
