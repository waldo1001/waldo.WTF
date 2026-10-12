# S3 — Abuse limits: body caps, rate limits, client cap, crash safety

Parent: [security-hardening.md](../security-hardening.md)

Status: **DONE 2026-10-12** (branch `security/hardening`). Note: the SDK 1.32.1 transport already caps `/mcp` bodies (`maxRequestBodySize`, set to 1 MiB) — a declared-length pre-check adds `Connection: close`.

## Goal
An unauthenticated internet caller can't exhaust memory, CPU (scrypt), disk
(client rows) or crash the process.

## Scope / files
- `src/mcp/read-body.ts` (new): `readBodyCapped(req, maxBytes)`. It aborts on
  `Content-Length` > cap, or on streamed bytes > cap → 413, connection closed.
  It replaces both `readJsonBody` and `readRawBody` (they are duplicates today).
  Caps: 64 KB for OAuth routes. `/mcp`: 1 MB, enforced by the `Content-Length`
  pre-check and by a byte-counting wrapper before handing to the SDK transport
  (to verify in RED: whether the SDK's StreamableHTTP transport already caps the
  body. If it does, keep the lower of the two).
- `src/auth/oauth/rate-limiter.ts` (new): fixed-window, in-memory, **clock injected**.
  Per-IP plus a global bucket, with defaults:
  - `/oauth/register`: 10/hour per IP, 50/hour global
  - `POST /oauth/authorize`: 10/min per IP, 30/min global (scrypt)
  - `/oauth/token`: 60/min per IP
  - Exceeded → 429 with `Retry-After`. Map entries are pruned on window roll (bounded memory).
- `src/mcp/client-ip.ts` (new): use `X-Forwarded-For` (left-most) **only when the
  socket peer is loopback**, else the socket address. Behind Funnel the peer is
  always `127.0.0.1`, so XFF is the only discriminator. If XFF is absent, the
  bucket key is `"unknown"` (still globally limited).
- `AuthStore`: `countClients()`, `pruneUnusedClients(olderThan)` (clients with no
  tokens and no codes, created more than 24 h ago). DCR: prune first, then reject
  with 503 `temporarily_unavailable` when the count is ≥ `WALDO_OAUTH_MAX_CLIENTS` (default 50).
- `http-server.ts`: wrap every async route body in a `handleSafely(res, fn)` that
  catches, logs (message only, no bodies/tokens), and returns 500 if headers aren't
  sent yet. **New finding**: today any throw becomes an unhandled rejection.
- Expired auth codes are pruned on each `saveAuthCode` (cheap DELETE with a `expires_at` index).

## RED test list
1. `readBodyCapped`: under the cap → body; `Content-Length` over the cap → 413 without reading; chunked stream over the cap → 413.
2. `/oauth/register` with a 65 KB body → 413; `/oauth/token` likewise; `/mcp` with 2 MB → 413 (authorized request).
3. rate limiter (fake clock): the Nth+1 call in the window → limited; next window → allowed; per-IP isolation; global bucket trips across IPs; memory pruned after a window.
4. `client-ip`: loopback peer + XFF `"1.2.3.4, 10.0.0.1"` → `1.2.3.4`; non-loopback peer + XFF → peer address (spoof ignored); loopback without XFF → `"unknown"`.
5. http-server: the 11th authorize POST from one IP within a minute → 429 + `Retry-After`; the **scrypt hasher is not invoked** for the limited request.
6. DCR: at the cap → 503; stale unused clients get pruned, after which registration succeeds; clients with tokens are never pruned.
7. `handleSafely`: the store throws during register/authorize/token → 500 JSON/HTML; the process does not emit `unhandledRejection` (spy).
8. authorize POST with a nonexistent client (the FK path) → 400 from S1 validation, never reaching the DB (regression guard).

## Risks
- claude.ai's backend egress IPs are shared across users, so per-IP limits could
  throttle legitimate traffic. The defaults are generous for a single-user server.
  The limits only cover OAuth endpoints, not `/mcp`.
- Funnel's XFF behavior is not guaranteed by docs. If it's missing, everything
  falls into `"unknown"`, which still works with the global limits.
