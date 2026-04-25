# Autoheal smoke test

Verify that `willfarrell/autoheal` restarts the `waldo-wtf` container
when its event loop is wedged but its TCP listener is still bound — the
exact failure mode that bypasses Docker's `restart: unless-stopped` and
that took the production server down twice in April 2026 before A1
shipped.

> **Last verified**: not yet (initial deploy of slice A1 — TBD on first
> NAS deploy after this commit lands).

## When to run

- After any change to `docker-compose.yml` that touches the `waldo`
  service, the `autoheal` service, healthcheck, or labels.
- Once per quarter as a "is the safety net still on" sanity check.
- Whenever the deployed image changes Node major version (the
  healthcheck uses `node:http`'s `request({timeout})` API, which is
  stable since Node 14 but worth re-checking on a major bump).

## Trust decision (read once, link forever)

The `autoheal` sidecar bind-mounts the host's Docker socket
(`/var/run/docker.sock`). That gives it the ability to issue
`docker restart`, `docker stop`, `docker kill` against any container on
this host. The blast radius is "any container on the NAS" — acceptable
on a single-tenant home device because:

- the image is `willfarrell/autoheal`, ~5M+ pulls, single-purpose,
  source on GitHub at <https://github.com/willfarrell/docker-autoheal>;
- there are no other tenants on this NAS who could be affected;
- the alternative (manual SSH-and-restart at 02:00 when the wedge
  fires) was already proven to fail twice — the cost of *not* having
  autoheal is higher than the cost of trusting the sidecar.

If this NAS ever gains a multi-tenant role, revisit this decision
before re-deploying.

## Procedure

All commands run on the NAS shell unless noted. Substitute paths /
hosts as appropriate for your deployment (waldo's NAS uses
`waldonas3.tailb07704.ts.net` and `/volume1/docker/waldo-wtf/`).

### 1. Bring the stack up

```sh
cd /volume1/docker/waldo-wtf
sudo docker compose up -d
```

Confirm both containers are running:

```sh
sudo docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' \
  | grep -E 'waldo-(wtf|autoheal)'
```

Expected — two rows, both `Up`. The `waldo-wtf` row also shows
`(healthy)` once `start_period: 20s` elapses and the first three
healthchecks pass.

### 2. Confirm the healthcheck is wired correctly

```sh
sudo docker inspect --format '{{json .Config.Labels}}' waldo-wtf
```

Expected — JSON containing `"autoheal":"true"`.

```sh
sudo docker inspect --format '{{json .State.Health}}' waldo-wtf | jq .
```

Expected — `Status: healthy`, last few entries with
`ExitCode: 0` and a short stdout.

### 3. Simulate a wedge

`SIGSTOP` to PID 1 inside the container suspends the process without
exiting it — the kernel's job-control state behaves exactly like a
wedged event loop from Docker's point of view. `kill -CONT 1` later
(if needed) resumes the process, but for this test we expect autoheal
to restart the container before we'd have a chance to.

```sh
sudo docker exec waldo-wtf kill -STOP 1
```

Note the wall-clock time. The next 30s of healthchecks will fail (the
suspended process can't respond), and after 3 consecutive failures
(~90s, including some tolerance for the 30s autoheal poll interval)
autoheal should restart the container.

### 4. Wait and verify restart

Watch for ~2 minutes:

```sh
sudo docker ps --format 'table {{.Names}}\t{{.Status}}' \
  | grep waldo-wtf
```

Expected — `Up <1m> (healthy)` showing a fresh restart. If you still
see `Up Nm (unhealthy)` after 3 minutes, autoheal did not fire — see
"If the test fails" below.

### 5. Inspect autoheal's view of the event

```sh
sudo docker logs --tail 50 waldo-autoheal
```

Expected — at least one line containing `Container /waldo-wtf is
unhealthy with 3 tries` followed by `Restart of container /waldo-wtf
exited with code 0`.

### 6. Confirm the app is healthy again

```sh
curl -s http://127.0.0.1:8765/health
```

Expected — `{"ok":true}` (or whatever the current `/health` payload
is — read [src/mcp/http-server.ts](../../src/mcp/http-server.ts) if
unsure).

### 7. Update the "Last verified" date

If everything passed, edit the date at the top of this file to today
(absolute date, e.g. `2026-04-25`) and commit.

## If the test fails

Check, in order:

1. **Both containers up**: `sudo docker ps -a` — autoheal must be
   `Up`, not `Exited`. If it's exited, `sudo docker logs
   waldo-autoheal` will show why (most common: docker.sock not
   mounted readable, or AUTOHEAL_CONTAINER_LABEL mismatched).
2. **Label present**: step 2 above. A typo on `autoheal=true` is
   the silent killer — autoheal scans by label and won't touch
   containers it doesn't recognise.
3. **Healthcheck reaching unhealthy**: `sudo docker inspect
   --format '{{json .State.Health}}' waldo-wtf | jq` should show
   `Status: unhealthy` after ~90s. If still `healthy`, the
   healthcheck command itself isn't failing — usually means
   `kill -STOP 1` didn't actually suspend the right process (e.g.
   running in a non-default init wrapper that intercepts signals).
4. **autoheal poll interval**: with `AUTOHEAL_INTERVAL=30`,
   verdicts are seen within 30s of becoming `unhealthy` — give
   it up to 30s extra before declaring a failure.

## Cleanup

If for any reason the SIGSTOP didn't trigger a restart and you have a
zombie suspended process:

```sh
sudo docker exec waldo-wtf kill -CONT 1   # may not work if pid 1 is suspended
sudo docker restart waldo-wtf             # fall-through, always works
```
