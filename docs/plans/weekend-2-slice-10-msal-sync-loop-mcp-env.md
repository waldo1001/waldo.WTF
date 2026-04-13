# Weekend 2 — Slice 10: MSAL adapter + sync loop + MCP transport + env wiring

## Task

Close out Weekend 2 by landing the four remaining unchecked items in one
bundled slice:

1. **Real MSAL `AuthClient` adapter** wrapping `@azure/msal-node`
   `PublicClientApplication`, persisting state through the existing
   `TokenCacheStore`.
2. **5-minute sync loop** (`SyncScheduler`) that iterates accounts,
   drives `GraphClient` delta paging, upserts through `MessageStore`,
   and appends a row to `sync_log` per account per run.
3. **Skeleton HTTP MCP server** — transport only. Node `node:http`,
   bearer-token middleware, no MCP tools yet. Health endpoint + 401 on
   bad/missing bearer.
4. **`.env` wiring** — load `.env` into `process.env` at the CLI entry
   point and plug `loadConfig` + the new components into a usable
   `main()`.

These are bundled because they're the final Weekend 2 wiring and each
piece is small on its own. Each still gets its own RED test list and
its own GREEN/REFACTOR pass inside this plan — no merging steps.

## Why this slice next

- PROGRESS.md Weekend 2 remaining items are exactly these four.
- Auth seam, store seam, FTS5, schema, FakeGraphClient, and
  FakeAuthClient all already exist. The only missing pieces are the
  real MSAL adapter, the orchestration (sync loop), and the transport
  shell for Weekend 3's MCP tools. Nothing new has to be designed from
  scratch.
- Doing them together lets `main()` actually run end-to-end against
  fakes and gives Weekend 3 a single place to hang MCP tools.

## Scope boundary

**IN this slice:**

### Sub-slice A — MSAL `AuthClient` adapter
- `src/auth/msal-auth-client.ts`:
  - `MsalAuthClient implements AuthClient`.
  - Constructor: `{ clientId: string; authority?: string;
    cacheStore: TokenCacheStore; pca?: PublicClientApplication }` —
    `pca` is injectable for tests; when omitted, the constructor
    builds one with a `cachePlugin` that delegates `beforeCacheAccess`
    / `afterCacheAccess` to `cacheStore.load` / `cacheStore.save`.
  - `listAccounts()` → maps MSAL `AccountInfo[]` → our `Account[]`.
  - `getTokenSilent(account)` → `pca.acquireTokenSilent({ account,
    scopes: ["Mail.Read"] })`; on MSAL failure throws
    `AuthError("silent-failed", { cause })`; never falls back to
    interactive.
  - `loginWithDeviceCode(onPrompt)` → `pca.acquireTokenByDeviceCode({
    scopes: ["Mail.Read"], deviceCodeCallback: (r) =>
    onPrompt(r.message) })`; returns the resulting `Account`; throws
    `AuthError("device-code-failed", { cause })` on failure.
  - `DEFAULT_AUTHORITY = "https://login.microsoftonline.com/common"`
    exported.
- Unit tests use an in-memory fake `PublicClientApplication`
  (duck-typed to the three methods the adapter calls). No live
  network, no real MSAL.
- `@azure/msal-node` added as a runtime dependency in `package.json`.

### Sub-slice B — Sync loop (`SyncScheduler`)
- `src/sync/sync-inbox.ts`:
  - `syncInbox({ account, auth, graph, store, clock, deltaEndpoint })`
    — pure function. Performs one delta sweep for one account:
    1. Resolve start URL: existing `deltaToken` from
       `store.getSyncState(account, "outlook")`, else `deltaEndpoint`
       (default `"/me/mailFolders/inbox/messages/delta"`).
    2. Acquire token via `auth.getTokenSilent(account)`.
    3. Loop `graph.getDelta(url, token)`:
       - Upsert non-removed messages (map `GraphMessage` → `Message`;
         use `clock.now()` for `importedAt`, parse `receivedDateTime`
         into `sentAt`).
       - Delete `@removed` messages via `store.deleteMessages`.
       - Follow `@odata.nextLink` until a `@odata.deltaLink` arrives.
    4. `store.setSyncState({ account, source: "outlook", deltaToken:
       newDeltaLink, lastSyncAt: clock.now() })`.
    5. Return `{ added: number; removed: number }`.
  - Error handling in this slice: propagate `TokenExpiredError`,
    `GraphRateLimitedError`, `DeltaTokenInvalidError` to caller
    unchanged. No retry, no backoff — `SyncScheduler` decides.
- `src/sync/sync-scheduler.ts`:
  - `SyncScheduler` class, constructed with `{ auth, graph, store,
    clock, setTimer, intervalMs }`. `setTimer` is an injected
    `(fn, ms) => Handle` seam so tests control timing without real
    `setInterval`.
  - `runOnce()`:
    1. `auth.listAccounts()`.
    2. For each account: `try { syncInbox(...) }`; on success append a
       `sync_log` row `{ status: "ok", messagesAdded: added }`; on
       failure append `{ status: "error", errorMessage: String(err) }`
       and continue to the next account (one account's failure must
       not stop the rest).
  - `start()` schedules `runOnce` every `intervalMs` via `setTimer`;
    the first run fires immediately (`runOnce()` awaited before the
    first timer is armed). Concurrent runs are prevented by an
    internal `isRunning` flag — if the timer fires while a run is in
    progress, it's skipped (logged via injected `onSkip` callback,
    optional).
  - `stop()` clears the active timer.
- Constant `DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000` exported.
- All unit tests use `FakeAuthClient` + `FakeGraphClient` +
  `InMemoryMessageStore` + `FakeClock` + a fake `setTimer`.

### Sub-slice C — Skeleton HTTP MCP server
- `src/mcp/http-server.ts`:
  - `createMcpHttpServer({ bearerToken, logger? })` returns a
    `http.Server` built with `node:http` (no framework).
  - Routes:
    - `GET /health` → `200 { ok: true }`. No auth required.
    - Any other path → bearer check first.
  - Bearer middleware:
    - Missing or malformed `Authorization` header → `401` with body
      `{"error":"unauthorized"}`.
    - Wrong bearer → `401`.
    - Correct bearer but unknown route → `404 { error: "not_found" }`.
  - **Explicitly no MCP tools / no `@modelcontextprotocol/sdk` yet.**
    The server is a transport shell Weekend 3 will hang tools off of.
  - Constant-time string compare for the bearer to avoid timing
    leaks, via `crypto.timingSafeEqual` on equal-length buffers
    (pre-check lengths to avoid throwing).
- Unit tests spin the server on an ephemeral port (`listen(0)`) and
  hit it with `fetch`. Each test closes the server in `afterEach`.

### Sub-slice D — `.env` wiring + `main()`
- `dotenv` added as a runtime dependency.
- `src/index.ts`:
  - `main()` becomes: `dotenv.config()` →
    `loadConfig(process.env)` → construct `TokenCacheStore`
    (rooted at `config.authDir`) → `MsalAuthClient` → real
    `SqliteMessageStore` via `openDatabase(config.dbPath)` → placeholder
    `GraphClient` stub that throws `not implemented: real graph` when
    called (real HTTP Graph adapter is a later slice) → `SyncScheduler`
    (started) → `createMcpHttpServer({ bearerToken })` listening on
    `config.port`.
  - No business logic in `main()` beyond wiring. Orchestration
    functions (`buildApp`, `wireSyncScheduler`) live next to their
    owners and are individually tested.
- `src/config.ts`: extend `Config` with optional `port: number`
  (default `8765`) and `syncIntervalMs: number` (default
  `DEFAULT_SYNC_INTERVAL_MS`). Env vars: `WALDO_PORT`,
  `WALDO_SYNC_INTERVAL_MS`. Keep the existing required-var contract
  unchanged — `MS_CLIENT_ID` and `BEARER_TOKEN` stay required.
- `.env.example` at repo root:
  ```
  MS_CLIENT_ID=
  BEARER_TOKEN=
  # WALDO_DB_PATH=./data/lake.db
  # WALDO_AUTH_DIR=./data/auth
  # WALDO_PORT=8765
  # WALDO_SYNC_INTERVAL_MS=300000
  ```
- `src/index.test.ts` — `main()` is deliberately not unit-tested beyond
  a "throws ConfigError when env is empty" case. Real wiring is
  validated by the per-component tests; running `main()` for real is a
  manual verification step.

**OUT of this slice (explicitly deferred):**
- Real HTTP `GraphClient` adapter. Sync loop works against
  `FakeGraphClient` in tests, and `main()` wires a stub that throws
  until the real adapter lands (next slice, Weekend 3 or late
  Weekend 2 follow-up).
- Any MCP tool (`get_recent_activity`, `search`, `get_sync_status`).
  Transport shell only.
- `@modelcontextprotocol/sdk` installation — Weekend 3.
- MSAL live login. The adapter is unit-tested against a fake PCA;
  a live run is a manual smoke test after merge.
- Retry/backoff policy for `GraphRateLimitedError`. Current behavior:
  surface the error, fail that account's run, log it, continue.
- TLS / reverse proxy concerns for the HTTP server. Bound to
  `127.0.0.1` by default; Synology Tailscale fronting is Weekend 5.
- Structured logging library. A minimal `logger` interface with
  `info`/`warn`/`error` is enough.

## Files to touch

**Create:**
- `src/auth/msal-auth-client.ts`
- `src/auth/msal-auth-client.test.ts`
- `src/sync/sync-inbox.ts`
- `src/sync/sync-inbox.test.ts`
- `src/sync/sync-scheduler.ts`
- `src/sync/sync-scheduler.test.ts`
- `src/mcp/http-server.ts`
- `src/mcp/http-server.test.ts`
- `.env.example`

**Edit:**
- `src/config.ts` + `src/config.test.ts` (add `port`, `syncIntervalMs`)
- `src/index.ts` + `src/index.test.ts` (wire `main()`)
- `package.json` (add `@azure/msal-node`, `dotenv` as dependencies)
- `PROGRESS.md` (tick the four Weekend 2 items, note real Graph
  adapter still pending; do during UPDATE DOCS)
- `docs/changelog.md` via `/docs-update`

## Seams

- `MsalAuthClient` takes an injectable `pca` so tests never touch real
  `@azure/msal-node`. The real constructor path (no `pca` passed) is
  covered by one "smoke" test that only asserts the object constructs
  — not its behavior.
- `SyncScheduler.setTimer` is a `(fn, ms) => { clear: () => void }`
  seam. Tests pass a fake that records calls and fires manually; real
  wiring passes a thin `setInterval` wrapper.
- `GraphClient` stays the seam between sync loop and network. Tests
  inject `FakeGraphClient`. `main()` injects a `NotImplementedGraph`
  stub until the real adapter lands.
- `MessageStore` is already the seam for persistence; sync loop tests
  use `InMemoryMessageStore`.
- HTTP server takes a `logger` seam (default = silent) so tests don't
  spam stdout.
- `clock` (`Clock` from `src/clock.ts`) for `importedAt` and
  `lastSyncAt`. No `new Date()` inside business logic.

## RED test list

### `src/auth/msal-auth-client.test.ts`
1. `listAccounts` maps MSAL `AccountInfo` (`username`,
   `homeAccountId`, `tenantId`) to our `Account` shape, preserving
   order.
2. `listAccounts` returns `[]` when MSAL's `getAllAccounts` returns
   `[]`.
3. `getTokenSilent` calls `pca.acquireTokenSilent` with
   `scopes: ["Mail.Read"]` and the given account, and returns an
   `AccessToken` with `token`, `expiresOn`, and the same `account`.
4. `getTokenSilent` wraps MSAL errors as `AuthError` with
   `kind: "silent-failed"` and preserves `cause`.
5. `loginWithDeviceCode` invokes the supplied `onPrompt` with
   MSAL's device-code `message`, then returns the resulting
   `Account`.
6. `loginWithDeviceCode` wraps MSAL errors as
   `AuthError("device-code-failed")`.
7. Constructor without `pca` builds an MSAL instance bound to
   `clientId` and `DEFAULT_AUTHORITY`, and wires a `cachePlugin`
   that routes reads to `cacheStore.load` and writes to
   `cacheStore.save` (verified via a spy `TokenCacheStore`, not by
   reflecting into MSAL internals — call the exposed
   `beforeCacheAccess` / `afterCacheAccess` directly through a
   captured reference or via `pca` construction options passthrough).

### `src/sync/sync-inbox.test.ts`
1. First-ever sync (no prior `deltaToken`) starts from the default
   endpoint and fetches a single page ending in `@odata.deltaLink`;
   one message is upserted; `setSyncState` is called once with the
   new deltaLink and `lastSyncAt = clock.now()`. Return value:
   `{ added: 1, removed: 0 }`.
2. Subsequent sync starts from the stored `deltaToken` rather than
   the default endpoint.
3. Paging: response with `@odata.nextLink` is followed; messages
   from both pages are upserted exactly once; `deltaToken` is the
   one from the final page.
4. `@removed` messages are routed to `deleteMessages`, not
   `upsertMessages`.
5. `receivedDateTime` is parsed into a `Date` on the resulting
   `Message.sentAt`; `importedAt` equals `clock.now()`.
6. `TokenExpiredError` from `graph.getDelta` propagates; `syncState`
   is not updated.
7. `DeltaTokenInvalidError` propagates; `syncState` is not updated
   (caller restarts full sync next run).
8. The Graph `from`/`body` fields map to `senderName`,
   `senderEmail`, `body`, `bodyHtml` as documented in the brief.

### `src/sync/sync-scheduler.test.ts`
1. `runOnce` with zero accounts performs zero Graph calls and
   writes zero `sync_log` rows.
2. `runOnce` with two accounts performs one `syncInbox` per account
   and appends two `sync_log` rows with `status: "ok"` and the
   respective `messagesAdded` counts.
3. `runOnce` when one account's `syncInbox` throws: the other
   account still runs; failing account gets a `status: "error"`
   row with `errorMessage` stringified from the thrown error; the
   successful account still gets its `ok` row.
4. `start()` awaits the first `runOnce` before arming the timer,
   then passes `intervalMs` to `setTimer`.
5. `stop()` clears the active timer handle.
6. When the timer fires while a previous `runOnce` is still
   in-flight, the tick is skipped (no second concurrent run; fake
   `onSkip` callback invoked once).
7. `DEFAULT_SYNC_INTERVAL_MS === 300_000`.

### `src/mcp/http-server.test.ts`
1. `GET /health` returns `200` with `{ ok: true }` and no auth.
2. `GET /anything` without `Authorization` header returns `401` with
   `{"error":"unauthorized"}`.
3. `GET /anything` with a malformed header (`"Bearer"` only, no
   token) returns `401`.
4. `GET /anything` with the wrong bearer returns `401`.
5. `GET /anything` with the correct bearer returns `404
   {"error":"not_found"}` — transport is alive, no routes yet.
6. Bearer comparison is length-safe: a shorter-than-expected bearer
   returns `401` without throwing.
7. Server starts on `listen(0)` and returns a closable `http.Server`.

### `src/config.test.ts` (additions)
1. `port` defaults to `8765` when `WALDO_PORT` is unset.
2. `port` reads and parses `WALDO_PORT` as an integer when set.
3. `port` throws `ConfigError` when `WALDO_PORT` is set but not a
   positive integer.
4. `syncIntervalMs` defaults to `DEFAULT_SYNC_INTERVAL_MS`.
5. `syncIntervalMs` reads `WALDO_SYNC_INTERVAL_MS` as integer ms.

### `src/index.test.ts` (additions)
1. `main()` throws `ConfigError` when `MS_CLIENT_ID` /
   `BEARER_TOKEN` are absent (no side effects: no server listen, no
   db open — assert via injectable factories or by running with an
   empty env object).

## Risks

- **`@azure/msal-node` surface drift.** The `cachePlugin` API
  (`beforeCacheAccess` / `afterCacheAccess`) is stable but the types
  are fiddly. Keep the adapter's surface area to the three methods
  the codebase actually uses and duck-type `pca` in tests.
- **Scheduler race conditions.** The "timer fires during an
  in-flight run" case is the one that historically gets missed.
  Explicit RED test for it (§Scheduler-6) so the `isRunning` flag
  can't be dropped in a later refactor.
- **Bearer comparison timing.** Using `===` leaks length via short-
  circuit. `crypto.timingSafeEqual` throws on length mismatch — the
  adapter must pre-check and return `401` before comparing.
- **`main()` becoming a hidden integration test.** Keep `main()`
  pure wiring; if a code path can't be exercised without booting
  the whole app, extract it into a tested helper (`buildApp`).
- **Sync loop writing through the real `SqliteMessageStore` in a
  test run.** All sync-loop tests use `InMemoryMessageStore`. The
  SQLite path is only reachable from `main()`.
- **Scope creep into real Graph adapter.** Tempting because the
  sync loop "obviously needs it". It does not — `FakeGraphClient`
  satisfies every test and `NotImplementedGraph` stub keeps
  `main()` honest about what's real.

## Out-of-scope (reminder)

Real HTTP Graph adapter, MCP tools, `@modelcontextprotocol/sdk`,
retry/backoff policy, structured logger, TLS, live MSAL login,
Weekend 3+ items.
