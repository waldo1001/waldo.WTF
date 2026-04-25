# Server Hang Auto-Heal & Prevention

## Problem

The waldo.WTF MCP server has hung at least twice in the last weeks with the
same signature:

- TCP listener on `:8765` is still bound (`netstat` shows LISTEN)
- HTTP requests time out — even from `127.0.0.1` on the NAS itself
- Docker `restart: unless-stopped` does **not** trigger because the process
  hasn't exited; the event loop is just wedged
- Claude Desktop sees a generic `Error occurred during tool execution` with
  no body, because the MCP HTTP transport hits its own timeout before any
  response arrives

Most plausible root cause: an outbound `fetch` (Graph / Yammer / Teams)
without an `AbortController` timeout, awaited from a sync worker that runs
on the main event loop. One stuck connection wedges everything.

## Goals

1. **Contain** — when it hangs, the container restarts within ~60s without
   user intervention.
2. **Detect from the inside** — the process can self-diagnose a wedged
   event loop and exit, even if Docker's healthcheck mechanism is fooled.
3. **Fix the root cause** — outbound HTTP can never block the main loop
   indefinitely; the HTTP server itself has hard request/header timeouts.

Each phase stands alone — Phase 1 ships value the same day, Phase 3 is the
real fix. Phases 1+2 are safety nets we keep forever.

## Non-goals

- Moving sync workers to a separate process / worker thread. That's a
  larger refactor; out of scope here.
- Replacing the MCP SDK transport.
- Building a metrics/monitoring stack (Prometheus, Grafana). Auto-restart
  + structured log lines on every restart is the entire observability
  story for this plan.

## Phase 1 — Containment: Docker autoheal

**Goal**: when the existing `/health` healthcheck reports unhealthy 3×
in a row, restart the container automatically.

The compose file already has a working healthcheck
([docker-compose.yml:55-65](../../docker-compose.yml)). What it's missing
is anything that *acts* on the unhealthy verdict — `restart: unless-stopped`
only fires on process exit.

### Slice 1.1 — Add `autoheal` sidecar to compose

**Files:**
- `docker-compose.yml` — add a second service:
  ```yaml
  autoheal:
    image: willfarrell/autoheal:latest
    container_name: waldo-autoheal
    restart: unless-stopped
    environment:
      AUTOHEAL_CONTAINER_LABEL: "autoheal"
      AUTOHEAL_INTERVAL: "30"      # seconds between checks
      AUTOHEAL_START_PERIOD: "60"  # grace period after start
      AUTOHEAL_DEFAULT_STOP_TIMEOUT: "10"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
  ```
- `docker-compose.yml` — add label to the `waldo` service so autoheal
  watches it:
  ```yaml
  labels:
    - autoheal=true
  ```

**RED tests:**
- N/A — this is infra config, not application code. Verification is
  manual via the smoke procedure in slice 1.3.

**Risks:**
- Autoheal needs the Docker socket. That's a privileged mount, but the
  container is a single-purpose, well-known image (willfarrell/autoheal,
  ~5M pulls). The blast radius is "can restart containers on this host" —
  acceptable for a single-tenant home NAS. Document the trust decision in
  [docs/setup.md](../setup.md) so it's visible.
- Healthcheck currently uses `node -e "fetch(...)"` — if the very wedge we
  are trying to detect also wedges *that* node invocation, the
  healthcheck might hang inside its 5s timeout instead of failing fast.
  Slice 1.2 hardens the check.

### Slice 1.2 — Harden the healthcheck

**Files:**
- `docker-compose.yml` healthcheck block — switch to a check that cannot
  itself hang:
  ```yaml
  test:
    - "CMD-SHELL"
    - "node --eval \"const c=require('http').request({host:'127.0.0.1',port:8765,path:'/health',timeout:3000},r=>process.exit(r.statusCode===200?0:1));c.on('timeout',()=>process.exit(1));c.on('error',()=>process.exit(1));c.end();\""
  interval: 20s
  timeout: 5s
  retries: 3
  start_period: 30s
  ```
  Key points: `node:http` (not `fetch`) so we get an explicit `timeout`
  option, and every error path calls `process.exit(1)` so the check fails
  in <3s rather than waiting for the outer 5s timeout.

**RED tests:**
- Manual: `docker exec waldo-wtf <the test cmd>` returns 0 on healthy
  server, 1 on stopped server.

### Slice 1.3 — Smoke test the auto-restart loop

**Files:**
- `docs/runbooks/autoheal-smoke.md` (new) — short runbook with the exact
  commands to:
  1. Start compose, confirm both containers up, `waldo-wtf` healthy.
  2. Simulate hang: `docker exec waldo-wtf kill -STOP 1` (suspends PID 1
     inside the container — it stops responding without exiting).
  3. Wait 90s, confirm `docker ps` shows `waldo-wtf` restarted (Up <1m)
     and healthy.
  4. Confirm `docker logs waldo-autoheal` shows the restart line.

**RED tests:**
- The runbook *is* the test. Run it manually after Phase 1 ships and
  again any time the compose file changes.

**Definition of done for Phase 1:**
- Compose stack starts both services cleanly.
- Killing the app with SIGSTOP results in an automatic restart within
  ~90s (3 × 20s healthcheck + grace).
- Runbook in `docs/runbooks/` documents the test.
- `/docs-update` run.

---

## Phase 2 — In-process watchdog (defense in depth)

**Goal**: even if Docker's healthcheck is somehow fooled — e.g. the
healthcheck command itself hangs because the host's docker daemon is
under load — the process can detect its own wedge and `process.exit(1)`,
letting `restart: unless-stopped` take over.

The hypothesis: a wedged Node event loop will not run `setTimeout`
callbacks on schedule. We can measure that drift directly, and we can
also verify the HTTP server is answering its own loopback.

### Slice 2.1 — Event-loop liveness check

**Files (new):**
- `src/health/event-loop-watchdog.ts` — exports
  `startEventLoopWatchdog(opts: { clock: Clock; logger: Logger; intervalMs: number; maxLagMs: number; onWedge: () => void })`.
  Implementation: schedules a `setTimeout(intervalMs)` that compares
  `clock.now()` on entry vs. on fire. If the actual delay exceeds
  `intervalMs + maxLagMs`, increment a counter. After 3 consecutive
  over-budget intervals, call `onWedge()`. The `clock` seam keeps it
  testable.
- `src/health/event-loop-watchdog.test.ts`

**RED tests:**
1. `wedge fires after 3 consecutive over-budget intervals` — fake clock
   that advances by `intervalMs + 2*maxLagMs` each tick; `onWedge`
   called exactly once after the 3rd tick.
2. `single slow interval does not trigger wedge` — one over-budget
   tick, then two on-time ticks; counter resets, `onWedge` not called.
3. `does not fire when shutdown signaled` — calling the returned `stop()`
   cancels the next timer; no `onWedge` even if subsequent ticks would
   have fired.
4. `lag accounting uses injected clock, not Date.now` — assert that
   replacing the clock with one whose `now()` is monotonic-but-fast
   never trips the watchdog.

**Risks:**
- False positives during legitimate heavy work (e.g. a big SQLite WAL
  checkpoint). Mitigation: `maxLagMs` is generous (1000ms by default);
  `interval` is 5s; the threshold is 3 consecutive — i.e. ~15s of
  sustained unresponsiveness. A real sync batch should never be that
  long on the main loop; if it is, that's itself a bug we want to find.
- Coverage of the timer paths under fake-timer harness — Vitest's
  `vi.useFakeTimers()` works, but document the test pattern in
  [docs/tdd/testability-patterns.md](../tdd/testability-patterns.md).

### Slice 2.2 — Self-loopback healthcheck

**Files (new):**
- `src/health/self-probe.ts` — exports
  `startSelfProbe(opts: { clock; logger; intervalMs; timeoutMs; port; failuresBeforeWedge; fetchImpl?: FetchLike; onWedge: () => void })`.
  Every `intervalMs` it does an HTTP GET to
  `http://127.0.0.1:${port}/health` with `AbortController` timeout
  `timeoutMs`. After `failuresBeforeWedge` consecutive failures
  (timeout, non-200, network error), call `onWedge()`.
- `src/health/self-probe.test.ts`

**RED tests:**
1. `success path resets failure counter` — 2 fails then 1 success; next
   2 fails do not trip wedge.
2. `consecutive failures trip wedge exactly once` — failuresBeforeWedge=3,
   inject 4 failing responses; `onWedge` called once on the 3rd, not
   again on the 4th.
3. `slow response counted as failure` — fake fetch hangs; AbortController
   fires at `timeoutMs`; counted as a failure.
4. `non-200 counted as failure` — fake fetch returns 503.
5. `stop() cancels the next probe` — pending timer cleared, no fetch
   issued.

**Risks:**
- If the HTTP listener is shut down gracefully during normal exit, the
  self-probe must not trigger a panic-restart. Mitigation: the
  shutdown sequence (Phase 2.3) calls `stop()` on watchdogs *before*
  closing the server.

### Slice 2.3 — Wire watchdogs into the bootstrap

**Files (touch):**
- [src/index.ts](../../src/index.ts) — after `server.listen` resolves,
  start both watchdogs with `onWedge = () => { logger.error('watchdog: server wedged, exiting'); process.exit(1); }`.
  Defaults: event-loop watchdog `intervalMs=5000, maxLagMs=1000`;
  self-probe `intervalMs=30_000, timeoutMs=5000, failuresBeforeWedge=3`
  → ~90s to detect a hung HTTP layer, matching the Phase 1 budget.
- Add a SIGTERM/SIGINT handler that calls `stop()` on both watchdogs
  before `server.close()` so graceful shutdown doesn't trip the probe.
- New env var `WALDO_WATCHDOG_DISABLED=1` to opt out (useful for
  `--add-account` interactive runs and for tests). Read in
  [src/config.ts](../../src/config.ts).

**Files (touch tests):**
- [src/index.test.ts](../../src/index.test.ts) — new test:
  bootstrap with `WALDO_WATCHDOG_DISABLED` unset, fake clock and fake
  fetch that returns 503; assert the wedge handler is invoked. Use a
  spy `process.exit` (already a pattern in this repo).
- [src/config.test.ts](../../src/config.test.ts) — `WALDO_WATCHDOG_DISABLED`
  parses to boolean.

**Risks:**
- `process.exit(1)` from inside a wedged handler may itself hang if the
  finalizers (SQLite close, log flush) are stuck. Mitigation: schedule a
  `setTimeout(() => process.kill(process.pid, 'SIGKILL'), 5000).unref()`
  immediately before `process.exit(1)` so worst-case the kernel kills
  us in 5s. The `.unref()` makes sure it doesn't keep the loop alive
  on graceful exit.

**Definition of done for Phase 2:**
- Both watchdog modules ≥90% line+branch coverage.
- Bootstrap test proves a fake wedge invokes `process.exit(1)`.
- Manual smoke (extending the Phase 1 runbook): instead of SIGSTOP,
  introduce a `while(true){}` from the Node REPL inside the container
  (or a dev-only env hook), confirm the watchdog fires within ~30s
  even before Docker's healthcheck would.
- `/security-scan` clean (the new files contain no secrets / no PII).
- `/docs-update` run.

---

## Phase 3 — Root cause: outbound + server timeouts

**Goal**: no single stuck connection — incoming or outgoing — can wedge
the event loop. Phases 1+2 become safety nets we hope never fire.

### Slice 3.1 — Shared `fetchWithTimeout`

**Files (new):**
- `src/sources/fetch-with-timeout.ts` — exports
  `createFetchWithTimeout(opts: { fetch: FetchLike; clock: Clock; defaultTimeoutMs: number }): FetchLike`.
  Wraps the underlying `FetchLike` with a default `AbortController`
  timeout. If the caller passes their own `signal`, both abort sources
  are linked (whichever fires first wins).
- `src/sources/fetch-with-timeout.test.ts`

**RED tests:**
1. `aborts at default timeout when caller passes no signal` — fake fetch
   hangs forever; promise rejects with `AbortError` at `defaultTimeoutMs`
   (verified via injected clock + fake timers).
2. `caller signal aborts before default timeout` — caller's `AbortController`
   fires at 100ms with timeout=10s; fetch aborts at 100ms with caller's
   reason preserved.
3. `default timeout aborts before caller signal` — caller's signal would
   fire at 10s with timeout=1s; fetch aborts at 1s with the timeout's
   reason.
4. `successful response within budget passes through unchanged` — body,
   status, headers all forwarded.
5. `cleanup: timer is cleared on successful response` — assert that no
   pending timers remain in the fake-timer queue after the promise
   resolves (otherwise we leak a handle per request).

### Slice 3.2 — Adopt `fetchWithTimeout` in every HTTP client

**Files (touch):**
- [src/sources/http-graph-client.ts](../../src/sources/http-graph-client.ts)
- [src/sources/http-teams-client.ts](../../src/sources/http-teams-client.ts)
- [src/sources/http-teams-channel-client.ts](../../src/sources/http-teams-channel-client.ts)
- [src/sources/http-yammer-client.ts](../../src/sources/http-yammer-client.ts)

**Approach:** these clients already accept a `FetchLike` constructor
arg. Change the *factory functions* (or the `index.ts` wiring that
constructs them) to wrap the raw `fetch` in `createFetchWithTimeout`
before passing it down. The clients themselves don't change — they
keep accepting a `FetchLike`. This preserves all existing tests
(which pass their own fake fetch and bypass the wrapper, exactly as
intended).

**RED tests:**
- For each of the 4 clients, one new integration-style test in the
  client's existing test file: `fetches a hung URL via fetchWithTimeout
  rejects with AbortError after configured timeout`. This verifies the
  wiring in `index.ts` actually applies the wrapper, not just that the
  wrapper exists.

**Risks:**
- A too-aggressive default timeout (say, 10s) breaks legitimate
  long-running Graph deltas. Default 60s is generous; per-call
  override available via the existing `signal` arg if a specific
  endpoint needs longer. Pick the default after eyeballing
  [src/sync/scheduler.ts](../../src/sync/scheduler.ts) for batch sizes.

### Slice 3.3 — Server-side request/header timeouts

**Files (touch):**
- [src/mcp/http-server.ts](../../src/mcp/http-server.ts) — after
  `createServer(...)`, before returning, set:
  ```ts
  server.requestTimeout = 60_000;       // 60s on the full request
  server.headersTimeout  = 30_000;      // 30s on headers
  server.keepAliveTimeout = 65_000;
  server.timeout = 0;                   // disable the legacy total timeout (covered by requestTimeout)
  ```
  These are Node's built-in protections against slow-loris and stuck
  handlers. A handler that doesn't `res.end()` in time gets the
  socket killed; subsequent requests work.

**RED tests:**
- New test in [src/mcp/http-server.test.ts](../../src/mcp/http-server.test.ts):
  spin up the server, send a request whose handler we deliberately
  block (use a registered tool that awaits a never-resolving promise),
  assert the connection is closed within `requestTimeout + 1s`. This
  is the only test in this plan that uses real timers; mark it
  `test.slow` if Vitest supports it, else cap it at ~2s by setting
  `requestTimeout = 1000` for that test.

**Risks:**
- Long Graph deltas proxied through a tool call could exceed 60s.
  Mitigation: tools that wrap long Graph calls are already supposed
  to stream / chunk; if any tool call genuinely needs more than 60s,
  raise `requestTimeout` for that path explicitly rather than
  globally. Document in the runbook.

### Slice 3.4 — Audit + add a lint rule against bare `fetch`

**Files (touch / new):**
- `eslint.config.js` (or whichever lint config exists — confirm in
  Slice 3.4 framing) — add a `no-restricted-globals` rule banning
  bare `fetch` in `src/sources/**` and `src/sync/**`. Suggested
  message: "Use the injected FetchLike, which is wrapped with a
  timeout. Bare fetch hangs forever and has wedged the server in
  prod."
- `docs/tdd/testability-patterns.md` — add a one-paragraph section
  "All outbound HTTP must go through a `FetchLike` wrapped by
  `createFetchWithTimeout`" with a link to slice 3.1.

**RED tests:**
- Run `npm run lint`. The rule should already pass on a clean tree
  (we just removed bare fetches in 3.2). Add one fixture file under
  `src/sources/__lint__/bare-fetch.fixture.ts` containing a literal
  `fetch(...)` call, and a test that runs the lint config against
  the fixture and asserts the rule fires. This locks the protection
  in for future regressions.

**Definition of done for Phase 3:**
- `fetchWithTimeout` ≥90% coverage.
- All 4 HTTP clients wrapped; per-client integration test green.
- Server timeouts applied; deliberately-stuck-handler test passes.
- Lint rule blocks new bare `fetch` in `src/sources` / `src/sync`.
- `/security-scan` clean.
- `/docs-update` run; setup notes for `WALDO_WATCHDOG_DISABLED` and
  the new server timeouts captured in
  [docs/setup.md](../setup.md) and [docs/user-guide.md](../user-guide.md).

---

## Sequencing

1. **Phase 1 first** (same-day ship). It is pure infra, no app code,
   instant value. Even if Phases 2+3 take a week, the user is no
   longer manually restarting the container.
2. **Phase 3 second**. It is the actual fix. Done before Phase 2 so
   that Phase 2's watchdog is "should never fire in practice" rather
   than "papering over a known bug".
3. **Phase 2 last**. Pure safety net; lower urgency once 3 is in.

If priorities change, all three phases stand alone — they share no
files except `docs/setup.md` updates.

## Out of scope

- **Worker-thread isolation for sync**: the durable cure for "one
  bad fetch wedges everything" is to run sync in a `worker_thread`
  so the HTTP server has its own loop. Track separately. Phase 3's
  timeouts make this less urgent.
- **Structured restart telemetry**: when the watchdog or autoheal
  fires, we should log a single distinctive line so future-me can
  grep for restart history. Covered by the `logger.error` calls in
  Phase 2.3 and Docker's own restart log line — no separate metrics
  pipeline.
- **Alerting**: no Slack/Pushover/email when a restart fires. Add
  later if restarts become frequent enough to need attention; for
  now the goal is silent recovery.

## Risks across the whole plan

- **Compose downtime during Phase 1 deploy**: bringing up the
  autoheal sidecar + new healthcheck command needs a `docker compose
  up -d` cycle. Use [/deploy-nas](../../.claude/skills/deploy-nas/SKILL.md)
  with a fresh build so the deploy is atomic.
- **Watchdog false positives causing restart loops**: if event-loop
  lag thresholds are too tight, the watchdog could keep killing a
  healthy server. Defaults are conservative (15s sustained
  unresponsiveness) and `WALDO_WATCHDOG_DISABLED` is the kill switch.
- **Lint rule churn**: banning bare `fetch` may fire on unrelated
  files (tests, OAuth flows). Scope the rule to `src/sources/**` and
  `src/sync/**` only. Verify before merge.
