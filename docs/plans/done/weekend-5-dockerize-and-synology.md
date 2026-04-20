# Weekend 5 — Dockerize and move to Synology

## Task

Package waldo.WTF as a container image that runs the existing MCP
server + sync loop, with SQLite and the MSAL token cache persisted via
bind-mounted volumes, and deploy it to a Synology NAS reachable from
the Mac over Tailscale. The software side (Dockerfile, bind host
config, compose file, local smoke test, manual) is done here; the
physical NAS steps are captured in a step-by-step operator manual so
waldo can execute them by hand at the Synology UI.

## Scope boundary

**IN**

- New `WALDO_BIND_HOST` config knob (default `127.0.0.1` — preserves
  current behaviour for `tsx src/index.ts`); container sets it to
  `0.0.0.0`.
- Thread `bindHost` through [src/index.ts](../../src/index.ts) so
  `httpServer.listen(port, bindHost)` uses it.
- RED tests for the new config field (valid host, default, empty
  string → default).
- `Dockerfile` at repo root — multi-stage, `node:22-bookworm-slim`
  base (not alpine — `better-sqlite3` needs a C toolchain and the
  bookworm-slim prebuilt wheels are simpler than fighting musl).
  Non-root user. `/data/db` and `/data/auth` declared as VOLUMEs.
- `.dockerignore` — exclude `node_modules`, `coverage`, `data`,
  `*.db`, `.env`, `docs`, tests.
- `docker-compose.yml` at repo root — one service, two bind mounts,
  env file, restart policy, healthcheck hitting the MCP `/health`
  (or equivalent — reuse whatever the MCP HTTP server already
  exposes; if none, skip the healthcheck rather than invent one).
- Local smoke test on Mac: `docker compose up`, curl an MCP tool
  with the bearer token over the mapped port, confirm SQLite file
  lands in the bind-mounted volume.
- [docs/deploy-synology.md](../../docs/deploy-synology.md) — new
  operator manual covering: prerequisites, Container Manager +
  Tailscale install, SSH file layout on the NAS (internal SSD paths,
  NOT `/volume1` SMB shares), compose import, env file creation,
  first-run MSAL device-code login inside the container, Claude
  Desktop MCP JSON repoint, troubleshooting (WAL on SMB = corruption,
  cached tokens, port binding).

**OUT** (deferred)

- Any change to how MSAL device-code login runs. Reuse the existing
  [src/cli.ts](../../src/cli.ts) flow; document how to `docker
  compose run --rm waldo login` (or `exec`) against the live
  container for the first-run auth.
- Actually doing the NAS deployment. Manual is written; waldo
  executes it. The plan's "done" criterion for the deployment part
  is *the manual is accurate enough that a fresh reader can follow
  it without guessing*, not *the container is running on the NAS*.
- Publishing the image to a registry. Build locally, `docker save`
  → `scp` → `docker load` on the NAS, OR `docker compose build` on
  the NAS directly. Manual documents both; registry push is a
  Weekend 5+ follow-up.
- HTTPS / TLS termination. Tailscale gives us a private tailnet, so
  plain HTTP over the tailnet is the v1 story. Cert work is a
  follow-up.
- Synology-specific orchestration (Portainer, DSM package, systemd
  on the NAS). Container Manager UI is enough.
- CI build of the image. Manual build for now.
- Any change to sync, MCP tool handlers, or schema.

## Files to create / touch

- [src/config.ts](../../src/config.ts) — add `bindHost: string` to
  `Config` and `DEFAULT_BIND_HOST = "127.0.0.1"`; read
  `WALDO_BIND_HOST` env var.
- [src/config.test.ts](../../src/config.test.ts) — RED tests for the
  new field (default, override, trimmed, empty string → default).
- [src/index.ts](../../src/index.ts) — pass `config.bindHost` to
  `httpServer.listen`; update the `logger.info` line to print the
  actual bind host.
- [src/index.test.ts](../../src/index.test.ts) — assert `listen` is
  called with the configured bind host (if the test already
  asserts on `listen`, extend it; otherwise add one focused test).
- `Dockerfile` (new, repo root)
- `.dockerignore` (new, repo root)
- `docker-compose.yml` (new, repo root)
- `.env.example` — add `WALDO_BIND_HOST=0.0.0.0` example line with a
  comment explaining it's for container use only.
- [docs/deploy-synology.md](../../docs/deploy-synology.md) (new) —
  the operator manual.
- [docs/setup.md](../../docs/setup.md) — add a short "Running in
  Docker" section linking to `deploy-synology.md`.
- [docs/changelog.md](../../docs/changelog.md) — entry (via
  `/docs-update`).
- [PROGRESS.md](../../PROGRESS.md) — tick Weekend 5 software boxes;
  leave the NAS-hands-on boxes unchecked.

## Seams involved

- **config** (new field, plumbed through composition root)
- **http** (bind host now data-driven)
- No change to auth / graph / teams / store / clock.

## RED test list

- AC1: `loadConfig` returns `bindHost: "127.0.0.1"` when
  `WALDO_BIND_HOST` is unset.
  - test file: `src/config.test.ts`
  - test name: `"defaults bindHost to 127.0.0.1"`
  - seams touched: config
  - edge cases: preserves current local-dev behaviour

- AC2: `loadConfig` returns the env value when `WALDO_BIND_HOST` is
  set to `"0.0.0.0"`.
  - test file: `src/config.test.ts`
  - test name: `"uses WALDO_BIND_HOST when provided"`
  - seams touched: config
  - edge cases: container-mode happy path

- AC3: `loadConfig` treats empty-string `WALDO_BIND_HOST` as unset
  (falls back to default), mirroring how `WALDO_DB_PATH` is
  handled via `present()`.
  - test file: `src/config.test.ts`
  - test name: `"treats empty WALDO_BIND_HOST as unset"`
  - seams touched: config
  - edge cases: consistency with existing env-handling

- AC4: `main()` passes `config.bindHost` to `httpServer.listen`.
  - test file: `src/index.test.ts`
  - test name: `"binds http server to configured bindHost"`
  - seams touched: http
  - edge cases: use an injected port=0 + spy on listen args, OR
    assert via `httpServer.address()` if already used in tests —
    prefer whichever pattern is already established in the file.

No automated tests for the Dockerfile or compose file. They're
validated by the local smoke test documented in the manual:

1. `docker compose build`
2. `docker compose up -d`
3. `curl -H "Authorization: Bearer $BEARER_TOKEN"
   http://127.0.0.1:8765/mcp/...` hits a tool
4. `ls ./data/db/lake.db` shows the bind-mounted DB file
5. `docker compose down` — data survives

## Open questions / assumptions

- **Confirmed**: Target NAS is **Synology DS223** (Realtek RTD1619B,
  **arm64**). Manual and build commands bake in `--platform
  linux/arm64`. If `better-sqlite3` lacks an arm64 prebuilt on
  `node:22-bookworm-slim`, the Dockerfile adds a builder stage with
  `apt-get install python3 make g++` — decide at build time.
- **Assumption**: Tailscale is installed via Synology's official
  package (DSM 7.2+), not the Docker sidecar pattern. Container
  joins the host network namespace OR is reached via the NAS's
  tailnet IP + published port. Manual will use the **published
  port** approach (simpler, no `network_mode: host` surprises).
- **Confirmed**: First-run login uses the existing
  `--add-account` CLI flag ([src/cli.ts:101](../../src/cli.ts#L101)),
  which calls `auth.loginWithDeviceCode()` and writes
  `token-cache.json` into `config.authDir`. In the container that
  path is `/data/auth`, bind-mounted. Flow:
  `docker compose run --rm waldo --add-account`, follow the device
  code prompt in an attached terminal, then `docker compose up -d`
  for the long-running server.
- **Assumption**: No change to `BEARER_TOKEN` rotation story. The
  `.env` file on the NAS holds it; Claude Desktop's MCP config
  holds the matching value.
- **Assumption**: Healthcheck. If the MCP HTTP server doesn't
  expose an unauthenticated `/health` or similar, the compose file
  omits `healthcheck` rather than inventing an endpoint (that'd
  be a feature, not a deployment task). Will grep before committing.

## Risks

- **SQLite on SMB = corruption.** The manual must *loudly* warn
  against putting `/data/db` on a network share. Bind mount to an
  internal-SSD path like `/volume1/docker/waldo-wtf/db` only if
  `/volume1` is actually an internal volume (it usually is on
  single-volume Synologys; multi-volume setups vary). Manual will
  tell reader to verify with `df` / DSM Storage Manager.
- **`127.0.0.1` default is a footgun in-container.** Mitigation: the
  manual and `.env.example` both show `WALDO_BIND_HOST=0.0.0.0`;
  the log line on startup prints the bind host so a misconfigured
  container is obvious from `docker logs`.
- **Device-code login inside a detached container is awkward** —
  user needs to see the code and open a browser. Manual walks
  through `docker compose run --rm` for the initial login before
  `docker compose up -d` for the long-running process, so the
  interactive prompt is attached to the user's terminal.
- **Architecture mismatch.** Building `amd64` on an M-series Mac and
  shipping to an arm64 NAS (or vice versa) silently produces an
  image that won't start. Manual uses `docker buildx build
  --platform linux/<arch>` explicitly.
- **Tailscale MagicDNS name drift.** If waldo renames the NAS in
  the tailnet admin, the Claude Desktop MCP URL breaks. Manual
  notes this and suggests pinning by tailnet IP as a fallback.

## Out-of-scope follow-ups

- Publish the image to GHCR so the NAS can `docker compose pull`
  instead of building.
- CI job that builds multi-arch images on PR merge.
- Proper healthcheck endpoint (requires an MCP server feature —
  separate slice).
- HTTPS termination (Tailscale Funnel or Caddy sidecar).
- Automatic MSAL token refresh observability (metric / log line
  when the refresh token rotates).
- Migrate `deploy-synology.md` screenshots / DSM version pinning
  once waldo runs it end-to-end and captures real UI shots.

## Step ordering

1. PLAN (this doc) — **wait for approval.**
2. FRAME (≤150 words) in chat.
3. RED: write the four failing config/index tests. `npm test` to
   prove they fail for the right reason.
4. SCAFFOLD: add `bindHost` to the `Config` type and
   `DEFAULT_BIND_HOST`, but leave `loadConfig` returning the
   default unconditionally so AC2 still fails.
5. GREEN: wire `WALDO_BIND_HOST` through `loadConfig`, then thread
   `config.bindHost` into `httpServer.listen` in `src/index.ts`.
   All four tests green.
6. REFACTOR: fold the new env handling into the same `present()`
   pattern already used; update the startup log line.
7. COVER: `npm test` with coverage; confirm touched files ≥90%.
8. Author `Dockerfile`, `.dockerignore`, `docker-compose.yml`,
   `.env.example` additions.
9. Local smoke test (the five-step curl/ls sequence above). If
   anything fails, fix and re-run — do NOT ship a manual built on
   a broken image.
10. Author [docs/deploy-synology.md](../../docs/deploy-synology.md)
    with the exact commands and env values used in the successful
    local smoke test, adapted for the NAS environment.
11. `/security-scan` — expect it to flag nothing; the `.env.example`
    must contain placeholder values only.
12. `/docs-update` — changelog entry, setup.md link, PROGRESS.md
    ticks.
13. REVIEW per methodology §2.8.
