# Weekend 2 — Slice 5: Auth seam + token cache store

## Task

Land the `src/auth/` module's **testable core**: an `AuthClient`
interface (device-code login, silent token acquisition, list accounts),
a `FakeAuthClient` for tests, and a `TokenCacheStore` that persists
MSAL's serialized token cache through the existing `FileSystem` seam.
No real `@azure/msal-node` wiring in this slice — that's a thin
adapter in a follow-up slice, mirroring how `FakeGraphClient` landed
before the real `GraphClient`.

## Why this slice next

- PROGRESS.md Weekend 2 next unchecked: "Port spike logic from
  `/Users/waldo/Temp/waldo-wtf-spike` — reference, don't copy-paste".
- Auth is the natural entry point: every downstream slice (store,
  sync, MCP) needs an access token and a per-account identity. Nailing
  the seam now keeps DI consistent.
- The spike's `spike.js` has three auth concerns mashed together:
  MSAL client construction, a fs-backed `cachePlugin`, and a
  `getTokenSilent` / `deviceCodeLogin` control flow. Splitting them
  behind an interface is what makes the sync loop testable later.
- Interface + fake is pure and fast to test. The real MSAL adapter is
  thin and mostly verifiable only via live login — defer it so this
  slice stays inside `/tdd-cycle`.

## Scope boundary

**IN this slice:**
- `src/auth/types.ts`:
  - `Account` type: `{ username: string; homeAccountId: string; tenantId: string }`.
  - `AccessToken` type: `{ token: string; expiresOn: Date; account: Account }`.
  - `AuthError` class extending `Error` with a `kind:
    "silent-failed" | "no-accounts" | "device-code-failed" |
    "cache-corrupt"` discriminant.
- `src/auth/auth-client.ts`:
  - `AuthClient` interface:
    - `listAccounts(): Promise<readonly Account[]>`
    - `getTokenSilent(account: Account): Promise<AccessToken>`
    - `loginWithDeviceCode(onPrompt: (message: string) => void): Promise<Account>`
- `src/auth/token-cache-store.ts`:
  - `TokenCacheStore` class, constructed with `{ fs: FileSystem;
    path: string }`.
  - `load(): Promise<string | null>` — returns serialized cache or
    null if file does not exist. Throws `AuthError("cache-corrupt")`
    on read error that is not ENOENT.
  - `save(serialized: string): Promise<void>` — writes with mode
    `0o600`, atomic via temp-file + rename through the `FileSystem`
    seam.
  - No MSAL import. No knowledge of cache contents — it's an opaque
    string blob.
- `src/testing/fake-auth-client.ts`:
  - `FakeAuthClient implements AuthClient`, scripted like
    `FakeGraphClient`:
    - Constructor takes `{ accounts: Account[]; tokens: Map<string,
      AccessToken | Error>; deviceCodeResult?: Account | Error }`.
    - Records `calls` for assertions.
    - `getTokenSilent` returns/throws per script; unknown account →
      `AuthError("silent-failed")`.
    - `loginWithDeviceCode` invokes `onPrompt` with a canned message
      then returns/throws the scripted result.
- Tests (RED list below):
  - `src/auth/token-cache-store.test.ts`
  - `src/testing/fake-auth-client.test.ts`

**OUT of this slice (explicitly deferred):**
- Real `@azure/msal-node` adapter implementing `AuthClient`. Lands
  next, with a live-login manual verification step — not unit-tested.
- `loadConfig` wiring that passes `authDir` into a `TokenCacheStore`
  construction. Happens when the CLI entrypoint slice arrives.
- Delta-state persistence (`delta-state.json`) — belongs to the sync
  slice, not auth.
- Multi-account loop / `syncInbox` — sync slice.
- Any `process.env` or dotenv reads.
- Any network I/O.

## Files to touch

- **Create**:
  - `src/auth/types.ts`
  - `src/auth/auth-client.ts`
  - `src/auth/token-cache-store.ts`
  - `src/auth/token-cache-store.test.ts`
  - `src/testing/fake-auth-client.ts`
  - `src/testing/fake-auth-client.test.ts`
- **Edit**: `PROGRESS.md` (add a sub-bullet under "Port spike logic"
  noting auth seam landed; do NOT tick the parent box — real MSAL
  adapter is still pending) during UPDATE DOCS.

## Seams

- `TokenCacheStore` depends on `FileSystem` (from `src/fs.ts`) — no
  direct `node:fs` import. Atomic write = `writeFile(tmp) → rename`,
  both through the seam. Tests use `InMemoryFileSystem`.
- `AuthClient` is the seam for MSAL itself. Business logic (future
  sync loop) takes an `AuthClient`, never an MSAL instance. Real
  adapter and fake are interchangeable.
- No clock dependency yet — `AccessToken.expiresOn` is a plain `Date`
  supplied by whoever constructs it (fake: test; real: MSAL's
  response). Refresh-window logic is a later slice.

## RED test list

### `src/auth/token-cache-store.test.ts`
1. `load` returns `null` when the cache file does not exist.
2. `load` returns the serialized string when the file exists.
3. `load` throws `AuthError` with `kind: "cache-corrupt"` when the
   underlying fs read fails for a reason other than "not found".
4. `save` writes the serialized string to the configured path with
   mode `0o600`.
5. `save` writes atomically: data lands at a temp path first, then
   `rename` moves it into place (assert via `InMemoryFileSystem`
   call log).
6. `save` then `load` round-trips the exact string.
7. Two sequential `save` calls leave only the final content at the
   target path (no temp files lingering).

### `src/testing/fake-auth-client.test.ts`
1. `listAccounts` returns the configured accounts in order.
2. `getTokenSilent` returns the scripted `AccessToken` for a known
   account.
3. `getTokenSilent` throws the scripted `Error` when the script maps
   that account to an error.
4. `getTokenSilent` throws `AuthError("silent-failed")` for an
   account that was never scripted.
5. `loginWithDeviceCode` invokes `onPrompt` with the canned message
   before resolving.
6. `loginWithDeviceCode` returns the scripted account.
7. `loginWithDeviceCode` throws when scripted with an error.
8. `calls` records each invocation with its method name and args so
   tests can assert ordering.

## Risks

- **Over-designing the `AuthClient` surface.** Only the three methods
  the spike actually uses are in scope. Refresh, logout, per-scope
  acquisition, etc. land when a test demands them.
- **Atomic-write semantics on `InMemoryFileSystem`.** If the current
  in-memory fs doesn't model `rename` overwrite, the test will surface
  it — fix the fake, not the store.
- **`AccessToken.expiresOn` ergonomics.** Tempting to compute "is
  expired" here. Don't — that needs the clock seam and belongs to the
  sync slice.

## Out-of-scope (reminder)

Real MSAL, delta state, sync loop, SQLite, MCP, CLI wiring, dotenv.
