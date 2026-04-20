# OAuth MCP — Slice 4: MCP endpoint access-token validation

Parent: [oauth-mcp-auth.md](oauth-mcp-auth.md)

## Task

Replace the single-path `isAuthorized` check with a dual-path validator:
accept either a valid OAuth access token (looked up from `AuthStore`) **or**
the legacy static bearer (unless `WALDO_DISABLE_STATIC_BEARER=true`).
On 401, emit `WWW-Authenticate: Bearer resource_metadata=<publicUrl>/.well-known/oauth-protected-resource`.

## Scope boundary

**In scope:**

- `validateOAuthToken(token, store, clock)` — looks up the token in
  `AuthStore.getAccessToken`. Returns the token pair or undefined.
- `isAuthorizedDual(header, bearerToken, store, clock, oauth?)` — tries OAuth
  first; falls back to static bearer unless `disableStaticBearer`.
- `WWW-Authenticate` header on every 401: `Bearer resource_metadata=<url>`
  when oauth is configured, bare `Bearer` otherwise.
- `WALDO_DISABLE_STATIC_BEARER` config flag honoured in `McpHttpServerOptions`.
- All existing bearer-gated tests stay green (static bearer path still works).

**Out of scope:**

- Token revocation.
- Scope checking beyond "token is valid".

## RED test list

- http-server: `"valid OAuth access token grants MCP access"`
- http-server: `"expired OAuth access token returns 401"`
- http-server: `"unknown OAuth access token returns 401"`
- http-server: `"401 with OAuth configured includes WWW-Authenticate resource_metadata header"`
- http-server: `"401 without OAuth configured still returns 401 (bare response)"`
- http-server: `"static bearer still works when disableStaticBearer is false/unset"`
- http-server: `"static bearer rejected when disableStaticBearer is true"`
