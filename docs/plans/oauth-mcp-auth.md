# OAuth 2.1 for the MCP endpoint

## Goal

Let claude.ai (and therefore Claude mobile) register waldo.WTF as a
custom remote MCP connector. The current static-bearer auth works fine
for Claude Desktop's local config, but claude.ai's custom-connector UI
only speaks OAuth 2.1 with Dynamic Client Registration (per the remote
MCP spec), so mobile access is blocked until the server publishes a
proper OAuth surface.

## Why OAuth and not a bridge

The endpoint is already publicly reachable over Tailscale Funnel. A
single static bearer is a weak perimeter for a public endpoint holding
the user's entire mail / Teams / WhatsApp lake. Moving to OAuth 2.1:

- matches the MCP remote-server spec,
- gives per-client credentials with revocation,
- requires explicit user consent at `/authorize`,
- lets Claude Desktop keep its local static-bearer path for zero-friction
  local dev (fallback, not primary).

An OAuth-bridging reverse proxy was considered and rejected: it
duplicates the auth boundary, introduces a second service to operate,
and doesn't reduce the total code — it just moves it.

## Scope boundary

**In scope (v1 — enough for claude.ai registration + mobile access):**
- RFC 8414 `/.well-known/oauth-authorization-server` metadata
- RFC 9728 `/.well-known/oauth-protected-resource` metadata
- RFC 7591 Dynamic Client Registration endpoint (`POST /oauth/register`)
- Authorization code flow with **PKCE required** (OAuth 2.1)
- Consent page at `GET /oauth/authorize` gated by a single static
  admin password from `.env` (`WALDO_ADMIN_PASSWORD`)
- Token endpoint at `POST /oauth/token` issuing opaque access + refresh
  tokens
- Refresh-token rotation (OAuth 2.1 MUST)
- Access-token validation middleware on the MCP endpoint
- `WWW-Authenticate: Bearer resource_metadata=...` header on 401
- SQLite-backed auth store (new `AuthStore` seam) with tables:
  `oauth_clients`, `oauth_auth_codes`, `oauth_access_tokens`,
  `oauth_refresh_tokens`
- Static-bearer path kept alongside OAuth (Claude Desktop fallback)
- Docs (user guide, deploy-synology, claude-desktop-wiring, new
  `docs/oauth.md`)

**Out of scope (deferred unless live friction):**
- OpenID Connect / ID tokens — MCP doesn't need identity beyond
  "is this token valid"
- Multiple admin users — single-operator system, one password
- JWT access tokens — opaque + SQLite is simpler to reason about,
  revocation is trivial, there's no downstream resource server
- Scopes beyond a single `mcp` scope — granularity not needed yet
- Session cookies / stay-logged-in on the consent page — re-auth on
  every claude.ai registration is fine (rare event)
- Rate limiting / brute-force protection on `/oauth/authorize` —
  Funnel + strong password + slow hash is enough for v1; add if abuse
  appears
- Revocation endpoint (RFC 7009) — deferred until a client actually
  asks for it; pruning expired tokens in a background task is enough
  for v1
- Admin UI to list / revoke registered clients — CLI subcommand
  (`--list-oauth-clients`, `--revoke-oauth-client <id>`) is enough

## Slicing

Five TDD slices, each a self-contained PR. Each slice has its own plan
file under `docs/plans/`:

1. **Slice 1 — Discovery + DCR + AuthStore seam**
   [`oauth-mcp-auth-slice-1-discovery-and-dcr.md`](oauth-mcp-auth-slice-1-discovery-and-dcr.md)
   Lands: the two `.well-known` endpoints, `POST /oauth/register`,
   `AuthStore` interface + SQLite impl + in-memory fake, schema v7
   migration for `oauth_clients`. No user flow yet. MCP endpoint
   unchanged; still static-bearer. Gates by publishing machine-readable
   metadata so slice 4 can wire the `WWW-Authenticate` header.

2. **Slice 2 — Authorization endpoint + consent**
   `oauth-mcp-auth-slice-2-authorize.md` (draft after slice 1)
   Lands: `GET /oauth/authorize` (consent HTML), `POST /oauth/authorize`
   (admin-password check → auth code), PKCE `code_challenge` storage,
   `oauth_auth_codes` table.

3. **Slice 3 — Token endpoint**
   `oauth-mcp-auth-slice-3-token.md`
   Lands: `POST /oauth/token` for both `authorization_code` and
   `refresh_token` grants, PKCE verifier check, token issuance,
   refresh-token rotation, `oauth_access_tokens` +
   `oauth_refresh_tokens` tables.

4. **Slice 4 — MCP endpoint access-token validation**
   `oauth-mcp-auth-slice-4-resource-guard.md`
   Lands: middleware that accepts either a valid OAuth access token
   **or** the legacy static bearer (desktop fallback);
   `WWW-Authenticate` header with `resource_metadata=` pointer on 401.

5. **Slice 5 — Live smoke with claude.ai + mobile**
   `oauth-mcp-auth-slice-5-live-smoke.md`
   Lands: docs + live registration on claude.ai, first mobile query,
   operator notes on failure modes observed in practice.

## Big design choices (surfaced for review before slice 1)

1. **Token format: opaque, SQLite-stored.** Hashed at rest with
   `crypto.scrypt`. Simpler than JWT, trivial revocation, single-server
   deployment so no stateless-validation benefit. Cost: every MCP
   request does one indexed SQLite lookup.
2. **Admin auth for consent: static password in `.env`.** Single-user
   home system. Password hashed with scrypt at server start; never
   stored plain in SQLite. Alternative (tie consent to the existing
   bearer) was rejected — would conflate the operator secret with the
   end-user credential.
3. **Keep static bearer alongside OAuth.** Claude Desktop + `curl` smoke
   tests keep working. Phased out only if / when a cleaner desktop auth
   story appears. A config knob `WALDO_DISABLE_STATIC_BEARER=true` lets
   a security-conscious operator turn it off.
4. **Auth endpoints live on the same origin as MCP.** Single Funnel
   mount, no DNS gymnastics, matches the MCP remote-server spec's
   "auth server can be co-located with resource server" option.
5. **DCR is open (no initial access token).** A claude.ai registration
   needs to succeed without prior coordination. Abuse is bounded: a
   registered client without authorization gets nothing — the consent
   page is the real gate.
6. **No refresh-token reuse detection yet.** Rotation + short TTL is
   enough for v1; the spec-mandated stronger detection (invalidate
   whole chain on reuse) deferred to a later slice if abuse shows up.

## Files the top-level effort will touch (cumulative across slices)

- New: `src/auth/oauth/` (metadata, DCR, authorize, token, middleware,
  store seam, SQLite impl, in-memory fake, password hasher, tests)
- New: `src/auth/oauth-config.ts` — reads `WALDO_ADMIN_PASSWORD`,
  `WALDO_PUBLIC_URL`, `WALDO_DISABLE_STATIC_BEARER` from env
- Edit: `src/store/schema.ts` — schema v7 migration (clients table in
  slice 1; codes/tokens tables in slices 2–3)
- Edit: `src/mcp/http-server.ts` — mount OAuth routes + swap bearer
  middleware for dual-path validator in slice 4
- Edit: `src/index.ts` — wire the `AuthStore` and config
- Edit: `.env.example`, `docker-compose.yml`, `docs/deploy-synology.md`
  — new env vars
- New: `docs/oauth.md` — operator guide (register client, rotate
  admin password, revoke client via CLI)
- Edit: `docs/user-guide.md`, `docs/claude-desktop-wiring.md` — point
  at the OAuth flow for mobile / claude.ai, retain the bearer notes
  for desktop

## Risks

- **Spec compliance drift.** MCP's remote-auth spec is evolving.
  Target revision: `2025-03-26` (OAuth 2.1 + DCR). Check against the
  current revision before slice 1 code; adjust if the well-known
  paths or DCR shape moved.
- **Claude.ai-specific quirks.** Anthropic's connector registration
  may expect specific redirect URI patterns, token lifetimes, or
  metadata fields. Slice 5 is where these surface; build in a small
  buffer for a follow-up slice 6 if needed.
- **PKCE implementation bugs = unauthenticated access.** Slice 3 gets
  the most careful review + exhaustive tests (every branch of the
  challenge/verifier check, timing-safe compare).
- **Schema migration on the live NAS lake.** Three new tables, all
  additive, no touch to `messages`. Backup before first
  `--migrate oauth-v7`-style deploy.
- **Static admin password leakage.** `.env` already mode 0600 root
  on the NAS. Document rotation in `docs/oauth.md`. A weak password
  is the user's problem; recommend `openssl rand -hex 24`.

## Definition of done (top-level)

- All 5 slices shipped and linked from `PROGRESS.md`.
- claude.ai custom-connector registration succeeds end-to-end,
  verified by a real mobile-app query returning data from the lake.
- `/security-scan` clean across every slice.
- ≥90% line + branch coverage on every OAuth file.
- Static-bearer path still passes existing e2e test (`src/mcp/e2e-http.test.ts`).
- Operator docs let a reader unfamiliar with OAuth register a new
  client, rotate the admin password, and revoke a compromised client.

## Acceptance by the user (before slice 1 starts)

1. Slicing ordering (discovery → authorize → token → guard → live).
2. Six design choices in the §"Big design choices" section above —
   especially: opaque tokens, static admin password, keep static
   bearer alongside.
3. Env-var names (`WALDO_ADMIN_PASSWORD`, `WALDO_PUBLIC_URL`,
   `WALDO_DISABLE_STATIC_BEARER`).
