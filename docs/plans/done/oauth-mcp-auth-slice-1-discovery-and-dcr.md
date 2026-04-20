# OAuth MCP — Slice 1: Discovery + DCR + AuthStore seam

Parent: [oauth-mcp-auth.md](oauth-mcp-auth.md)

## Task

Land the two OAuth `.well-known` discovery documents, the RFC 7591 Dynamic
Client Registration endpoint, and the `AuthStore` storage seam (interface +
SQLite impl + in-memory fake) backed by a new schema v7 migration for
`oauth_clients`. No user flow yet — metadata + open DCR + storage shape only.

## Scope boundary

**In scope (this slice):**

- `GET /.well-known/oauth-authorization-server` (RFC 8414) returns JSON
  metadata describing the OAuth server: `issuer`, `authorization_endpoint`,
  `token_endpoint`, `registration_endpoint`, `response_types_supported`,
  `grant_types_supported`, `code_challenge_methods_supported: ["S256"]`,
  `token_endpoint_auth_methods_supported: ["none"]`, `scopes_supported:
  ["mcp"]`. Endpoints in the metadata are advertised even though the
  authorize/token routes don't exist yet — slice 2 + 3 wire them.
- `GET /.well-known/oauth-protected-resource` (RFC 9728) returns JSON:
  `resource`, `authorization_servers`, `bearer_methods_supported:
  ["header"]`, `scopes_supported: ["mcp"]`.
- `POST /oauth/register` (RFC 7591, **open** registration — no initial
  access token): accepts a JSON body with `redirect_uris` (required, ≥1 https
  or `http://localhost*`) and optional `client_name`. Issues a random
  `client_id` (32 bytes hex), persists the registration, returns the spec's
  Client Information Response. Public-client only (no `client_secret`,
  PKCE-only) — confidential clients deferred until a real client demands it.
- `AuthStore` interface in `src/auth/oauth/auth-store.ts` exposing
  `registerClient`, `getClient`, `listClients`. Reshaped in slices 2–4 as
  codes/tokens land.
- `SqliteAuthStore` (`src/auth/oauth/sqlite-auth-store.ts`) — same DB handle
  + same migration runner as `SqliteMessageStore`. Schema v7 adds
  `oauth_clients (client_id PK, client_name, redirect_uris_json, created_at)`.
- `InMemoryAuthStore` (`src/testing/in-memory-auth-store.ts`) — Map-backed
  fake passing the contract suite.
- `oauthAuthStoreContract(label, factory)` shared contract suite, mirroring
  `runMessageStoreContract` — every impl must pass.
- `oauth-config.ts` — reads new `WALDO_PUBLIC_URL` (required for metadata
  to be meaningful). `WALDO_ADMIN_PASSWORD` and
  `WALDO_DISABLE_STATIC_BEARER` are accepted (passed through, validated)
  even though they only become load-bearing in slices 2 + 4.
- Wire the three new HTTP routes onto `createMcpHttpServer` so they bypass
  the bearer middleware (metadata + DCR are unauthenticated).
- `.env.example` updated with the three new env vars.

**Out of scope (deferred):**

- `GET /oauth/authorize` and the consent page (slice 2).
- `POST /oauth/authorize` and `oauth_auth_codes` table (slice 2).
- `POST /oauth/token`, PKCE verification, refresh rotation,
  `oauth_access_tokens` / `oauth_refresh_tokens` tables (slice 3).
- MCP resource-guard middleware + `WWW-Authenticate` header (slice 4).
- CLI subcommands to list / revoke clients (deferred to a later slice
  alongside other operator tooling).
- Confidential clients with `client_secret`. Public/PKCE-only for v1.
- Rate limiting on `POST /oauth/register`. Open DCR is bounded by the
  consent gate in slice 2; if abuse appears, a separate hardening slice
  lands later.
- Docs (`docs/oauth.md`) — written in slice 5 once the full flow exists.

## Files to create / touch

**New:**

- `src/auth/oauth/auth-store.ts` — `AuthStore` interface + DTO types
  (`OAuthClientRegistration`, `OAuthClientRecord`).
- `src/auth/oauth/auth-store-contract.ts` — shared contract suite
  (`runAuthStoreContract`).
- `src/auth/oauth/sqlite-auth-store.ts` — `SqliteAuthStore` impl.
- `src/auth/oauth/sqlite-auth-store.test.ts` — runs the contract against
  `:memory:` SQLite.
- `src/auth/oauth/metadata.ts` — pure builders
  `buildAuthorizationServerMetadata(publicUrl)` and
  `buildProtectedResourceMetadata(publicUrl)`.
- `src/auth/oauth/metadata.test.ts` — pure-fn unit tests.
- `src/auth/oauth/dcr.ts` — `handleDynamicClientRegistration({ store, ids
  })` returning `{status, body}`; pure-ish (no I/O beyond store + id source).
- `src/auth/oauth/dcr.test.ts` — DCR handler unit tests.
- `src/auth/oauth/oauth-config.ts` — `loadOAuthConfig(env)` returning
  `{ publicUrl, adminPassword?, disableStaticBearer }` with validation.
- `src/auth/oauth/oauth-config.test.ts`.
- `src/auth/oauth/ids.ts` — `RandomIdSource` interface +
  `cryptoRandomIdSource` (`node:crypto.randomBytes(32).toString("hex")`)
  + a fake for tests.
- `src/auth/oauth/ids.test.ts`.
- `src/auth/oauth/index.ts` — barrel re-export for the small public surface.
- `src/testing/in-memory-auth-store.ts` — Map-backed fake.
- `src/testing/in-memory-auth-store.test.ts` — runs the contract suite.

**Edited:**

- `src/store/schema.ts` — bump `CURRENT_SCHEMA_VERSION` to 7, add
  `MIGRATION_7` (`CREATE TABLE oauth_clients ...`), wire into
  `applyMigrations`. Tests added in `src/store/schema.test.ts`.
- `src/store/schema.test.ts` — three new tests covering v7 (table created,
  v6→v7 preserves data, idempotent at v7).
- `src/mcp/http-server.ts` — accept optional `authStore`, `oauthConfig`,
  `ids`; mount the three routes ahead of the bearer check; bearer
  middleware path unchanged when the routes are absent (back-compat with
  existing tests).
- `src/mcp/http-server.test.ts` — new tests for the three routes
  (metadata roundtrip + DCR happy/unhappy + auth bypass).
- `src/index.ts` — construct `SqliteAuthStore`, `oauthConfig`, the random
  id source, wire them into `createMcpHttpServer`. New env reads via
  `loadOAuthConfig`.
- `.env.example` — add `WALDO_PUBLIC_URL`, `WALDO_ADMIN_PASSWORD`,
  `WALDO_DISABLE_STATIC_BEARER`.

## Seams involved

- `store` — new `AuthStore` interface following the
  [testability-patterns.md §3.2](../tdd/testability-patterns.md) shape;
  SQLite real impl, Map-backed in-memory fake, contract test for both.
- `http` — new routes mounted on the existing `node:http` server; reuses
  the existing `InProcessHttpServer`-style pattern (real port + `fetch` in
  http-server tests).
- `ids` — new `RandomIdSource` seam in the OAuth subtree, isolated to the
  OAuth code so the broader codebase isn't disturbed.
- No clock dependency yet (no expiry until slice 3); `created_at`
  defaults from a clock in the DCR handler.

## RED test list

- AC1: `applyMigrations` advances v6 → v7 and creates `oauth_clients`.
  - test file: `src/store/schema.test.ts`
  - test name: `"creates oauth_clients table on v6→v7"`
  - seam: store
  - edge: idempotent at v7; v6 data survives.
- AC2: `oauth_clients.client_id` is PRIMARY KEY (raw duplicate insert
  rejects).
  - test name: `"oauth_clients.client_id PRIMARY KEY rejects duplicate"`
  - seam: store
- AC3: `buildAuthorizationServerMetadata` produces a spec-shaped object
  for a given `publicUrl`.
  - test file: `src/auth/oauth/metadata.test.ts`
  - test names:
    - `"emits issuer + endpoints rooted at publicUrl"`
    - `"declares S256 PKCE, public-client (none) auth, mcp scope"`
    - `"strips a trailing slash on publicUrl when joining endpoints"`
- AC4: `buildProtectedResourceMetadata` advertises the MCP resource +
  authorization server pointer.
  - test names:
    - `"resource equals publicUrl + '/'"` (or the canonical MCP path)
    - `"authorization_servers contains publicUrl"`
    - `"bearer_methods_supported is ['header']"`
- AC5: `handleDynamicClientRegistration` happy path issues a 32-byte hex
  `client_id`, persists the record, returns the RFC 7591 Client
  Information Response.
  - test file: `src/auth/oauth/dcr.test.ts`
  - test name: `"happy path: returns 201 + client_id + echoes redirect_uris"`
  - seams: store, ids, clock
- AC6: DCR validation:
  - `"rejects body without redirect_uris with 400 invalid_client_metadata"`
  - `"rejects empty redirect_uris array"`
  - `"rejects a non-https / non-localhost redirect_uri"`
  - `"accepts http://localhost and http://127.0.0.1 redirect_uris"`
  - `"persists client_name when present, leaves null when absent"`
- AC7: `AuthStore` contract — runs against both SQLite + InMemory.
  - test files: `src/auth/oauth/sqlite-auth-store.test.ts`,
    `src/testing/in-memory-auth-store.test.ts`
  - test names (shared suite):
    - `"registerClient persists a record retrievable by getClient"`
    - `"getClient returns undefined for an unknown client_id"`
    - `"registerClient throws on a duplicate client_id"`
    - `"listClients returns rows ordered by createdAt ASC"`
- AC8: `loadOAuthConfig`:
  - `"requires WALDO_PUBLIC_URL"`
  - `"trims a trailing slash on WALDO_PUBLIC_URL"`
  - `"WALDO_DISABLE_STATIC_BEARER defaults to false; 'true' yields true"`
  - `"WALDO_ADMIN_PASSWORD is optional in slice 1"`
  - `"rejects a non-https publicUrl unless host is localhost / 127.0.0.1"`
- AC9: HTTP wiring:
  - test file: `src/mcp/http-server.test.ts`
  - test names:
    - `"GET /.well-known/oauth-authorization-server returns JSON metadata without auth"`
    - `"GET /.well-known/oauth-protected-resource returns JSON metadata without auth"`
    - `"POST /oauth/register without auth returns 201 + client_id"`
    - `"POST /oauth/register with malformed JSON returns 400"`
    - `"POST /oauth/register without redirect_uris returns 400 invalid_client_metadata"`
    - `"OAuth routes do not affect bearer-gated POST / behavior"`
- AC10: `cryptoRandomIdSource` returns 64-char hex strings (32 bytes).
  - test name: `"generates a 64-char hex string"`

## Open questions / assumptions

Per the parent plan's design choices these are stated assumptions for
the user to override if needed:

1. **Public clients only in v1.** No `client_secret`, PKCE-only. Matches
   claude.ai's connector. Confidential client support deferred.
2. **Open DCR is unauthenticated** (no initial access token). The consent
   gate in slice 2 is the real authorization boundary.
3. **`oauth_clients` lives in the same `lake.db` file** as `messages`,
   under a single migration runner. Alternative (separate `auth.db`) was
   rejected — one file is simpler to backup, schema v7 is additive.
4. **Endpoints declared in metadata before they exist.** Slice 1
   advertises `/oauth/authorize` and `/oauth/token` in
   `/.well-known/oauth-authorization-server` even though slices 2–3 add
   them. Risk: if a client crawls metadata between slice 1 deploy and
   slice 3 deploy, the advertised endpoints 404. Acceptable because the
   server is single-operator and slices land in sequence on a personal
   NAS.
5. **`oauth_clients.created_at` is unix-ms** to match `accounts.added_at`
   (the only existing precedent in the schema).
6. **DCR success status is 201 Created** with `Location: /oauth/clients/<id>`
   omitted (RFC 7591 §3.2 says 201 SHOULD; no `Location` header
   required). Body is the spec-shaped Client Information Response.

## Risks

- **Schema v7 migration on the live NAS lake** (882 MB messages
  table). Mitigation: migration is purely `CREATE TABLE`, zero touch to
  `messages` / FTS5; tested against a v6 fixture in `schema.test.ts`.
  Backup before deploy is part of the slice 5 cutover.
- **DCR open registration could be probed.** Mitigation: registration
  alone grants nothing — without consent the client cannot get tokens.
  If abuse shows up in logs, add a Funnel-level rate cap or require a
  static admin token on `/oauth/register` in a follow-up slice.
- **Metadata mismatch with claude.ai expectations.** Mitigation: slice 5
  is the live smoke; slice 1 follows the IETF specs verbatim and
  matches the field set the MCP spec lists.
- **`WALDO_PUBLIC_URL` mis-set** (e.g. `http://localhost:8765` on the
  NAS) silently produces unusable metadata. Mitigation: validation in
  `loadOAuthConfig` rejects non-https public URLs unless the host is
  `localhost` / `127.0.0.1`; surfaces a clear `ConfigError`.

## Out-of-scope follow-ups

- `docs/oauth.md` operator guide (slice 5).
- CLI: `--list-oauth-clients`, `--revoke-oauth-client <id>` (later slice).
- Background pruning of expired tokens (slice 3 + later).
- Per-client rate limiting on DCR (only if abuse appears).
- Metadata cache headers (`Cache-Control`) — clients can refetch each
  registration; revisit if claude.ai hammers the endpoint.
- Compose / deploy doc updates for the new env vars (slice 5).
