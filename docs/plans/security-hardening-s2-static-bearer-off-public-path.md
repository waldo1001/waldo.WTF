# S2 — Take the static bearer off the public path

Parent: [security-hardening.md](security-hardening.md)

## Goal
The non-expiring `BEARER_TOKEN` cannot be used by anything arriving through
Funnel, and Jarvis (the only static-bearer consumer, running on the same Mac mini) keeps working.

## Options

**A. Second loopback-only listener (recommended).**
`WALDO_INTERNAL_PORT` (e.g. `8766`) opens a second HTTP server bound to `127.0.0.1` only.
It accepts **only** the static bearer and serves `/mcp` + `/health`, with no OAuth routes.
When `WALDO_PUBLIC_URL` is set, the public listener (`8765`, the one Serve/Funnel
proxies to) becomes **OAuth-only**: the static bearer is rejected there. Jarvis sets
`JARVIS_WTF_MCP_URL=http://127.0.0.1:8766/mcp`.
- ✅ Doesn't rely on what headers Funnel/Serve add or strip.
- ✅ Tailnet devices can't reach `8766` (loopback bind). Funnel/Serve config doesn't change.
- ✖ A static bearer from the laptop over the tailnet stops working. Nothing uses that today (verified).

**B. Header-based gating on one listener.** Allow the static bearer only if the peer is
loopback and either (no `X-Forwarded-For`, i.e. a direct local call) or
`Tailscale-User-Login` is present. Tailscale documents that it omits identity headers
for Funnel and strips spoofed ones.
- ✖ Relies on Serve always setting `X-Forwarded-For` (not in the Serve KB page I
  checked; would need an empirical header dump on the Mac mini). If that ever changes,
  Funnel traffic looks like a direct local call: fail-open.

**C. Flip the default:** `WALDO_PUBLIC_URL` set ⇒ static bearer disabled unless
`WALDO_ALLOW_STATIC_BEARER=true`.
- ✖ On its own it breaks Jarvis (it can't do interactive OAuth). Only useful combined with A, which is what A already does.

## Scope / files (option A)
- `src/config.ts`: `internalPort?: number` from `WALDO_INTERNAL_PORT` (validated 1–65535, ≠ `port`).
- `src/mcp/http-server.ts`: a `mode: "public" | "internal"` option. Public + oauth means OAuth tokens only. Internal means static bearer only, no OAuth routes. With no oauth configured, public keeps today's static-bearer behavior (tailnet-only/dev setups unchanged).
- `src/index.ts`: start the internal server on `127.0.0.1:<internalPort>` when set. Hard-coded bind, not `bindHost`. Close both on shutdown.
- `.gitignore`: add `.claude/settings.local.json`, `.claude/worktrees/`.
- `WALDO_DISABLE_STATIC_BEARER` stays honoured (it now also disables the internal listener's bearer → the internal listener is not started).

## RED test list
1. config: `WALDO_INTERNAL_PORT` parsed; invalid / equal to `port` → config error; absent → undefined.
2. public + oauth: static bearer → 401; valid OAuth token → 200.
3. public without oauth: static bearer → 200 (unchanged).
4. internal: static bearer → 200; OAuth access token → 401; `/oauth/register` → 404; `/.well-known/*` → 404.
5. index/main: with `internalPort` set, the internal server listens on `127.0.0.1` (asserted from `server.address()`) even when `bindHost` is `0.0.0.0`; both servers close on shutdown.
6. `WALDO_DISABLE_STATIC_BEARER=true` + `internalPort` → the internal listener is not started (logged).
7. `.gitignore` contains both entries (a simple file assertion in the security-scan, not a Vitest test; listed for traceability).

## Risks
- **Jarvis ordering**: if you deploy before switching Jarvis's URL, Jarvis 401s until it's switched. The umbrella plan's operator order handles this. The failure is loud (Jarvis spec 605 throws instead of returning `[]`).
- Port `8766` collisions on the Mac mini. Check with `lsof -i :8766` before choosing.
- Also `/local-smoke` needs to exercise both listeners. Its SKILL.md is updated in `/docs-update`.
