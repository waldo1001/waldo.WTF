# Testability Patterns — waldo.WTF

The TDD methodology requires that every seam can be faked. This document
enumerates the seams waldo.WTF has (or will have) and the exact shape they
take as injectable dependencies.

**Rule**: business logic never imports a side-effect module directly. It
accepts an interface via a parameter or a dependency object. The
composition root (`src/index.ts`) is the *only* place real implementations
are constructed and wired together.

---

## 1. The composition root pattern

```ts
// src/index.ts — the ONLY place real dependencies are constructed.
import { createGraphHttpClient } from "./sources/graph-http";
import { openSqliteStore } from "./store/sqlite";
import { SystemClock } from "./support/clock";
import { createJsonLogger } from "./support/logger";
import { startSyncLoop } from "./sync/loop";
import { startMcpServer } from "./mcp/server";

const clock = new SystemClock();
const logger = createJsonLogger(process.stdout);
const store = openSqliteStore(process.env.DB_PATH!, { mode: "wal" });
const graph = createGraphHttpClient(fetch);

startSyncLoop({ clock, logger, store, graph, /* ... */ });
startMcpServer({ clock, logger, store, /* ... */ });
```

Every module below the root takes its deps as arguments. This is boring,
explicit, and makes `src/index.ts` the *only* file that cannot be unit
tested. (That's fine — it's excluded in [coverage-policy.md](coverage-policy.md).)

---

## 2. The `Deps` object convention

For modules with more than 2 dependencies, group them into a `Deps` object:

```ts
// src/sync/delta.ts
export interface DeltaSyncDeps {
  graph: GraphClient;
  store: MessageStore;
  clock: Clock;
  logger: Logger;
  tokenFor: (account: string) => Promise<string>;
}

export const makeDeltaSync = (deps: DeltaSyncDeps) =>
  async (account: string, source: "outlook" | "teams") => {
    // ...
  };
```

This pattern gives you:
- one place to add a new dependency without changing every call site
- trivially complete fakes in tests (`{ graph, store, clock, logger, tokenFor }`)
- no hidden globals

---

## 3. The seams

### 3.1 Graph HTTP — `GraphClient`

**Real**: `src/sources/graph-http.ts` — wraps `fetch` against
`graph.microsoft.com`. The **only** file allowed to import `fetch` or
mention the Graph URL. All error translation (401→TokenExpired,
429→RateLimited, 410→DeltaTokenInvalid) lives here.

**Fake**: `src/testing/fake-graph-client.ts` — scripted step-by-step
responses. See [../../testing/examples/fake-graph-client.example.ts](../../testing/examples/fake-graph-client.example.ts).

**Contract test**: `src/sources/__contract__/graph-client.contract.test.ts`
runs a shared suite against both the real client (hitting a local mock HTTP
server) and the fake, ensuring the fake does not drift from the interface
the real client exposes.

### 3.2 Message store — `MessageStore`

**Real**: `src/store/sqlite.ts` — `better-sqlite3` in WAL mode. The only
file allowed to `import "better-sqlite3"`.

**Fake**: two options, pick per-test.
- `createInMemoryStore()` — uses `better-sqlite3` with `":memory:"`. Fast,
  real SQL, no disk. Preferred for unit tests that need actual query
  behavior (FTS5, joins, indexes).
- `FakeMessageStore` — plain JavaScript Map-backed. Only for tests that
  genuinely don't care about SQL semantics (e.g. testing the sync loop's
  retry logic where only `insertMany` return value matters).

**Integration tests**: always real `better-sqlite3` in a tmp-dir WAL db,
deleted in `afterEach`. Never the real `lake.db`.

### 3.3 Clock — `Clock`

**Interface**: `interface Clock { now(): number /* unix ms */ }`.

**Real**: `class SystemClock { now() { return Date.now(); } }`.

**Fake**: `FakeClock` — see [../../testing/examples/fake-clock.example.ts](../../testing/examples/fake-clock.example.ts).
Constructor takes an ISO string or ms. `advance(ms)` to step forward.

Business logic NEVER calls `Date.now()` directly. Audit rule enforced in
REVIEW: grep for `Date\.now\(` outside `src/support/clock.ts` and
`src/testing/`.

### 3.4 Filesystem — `FileSystem`

Used for: token cache persistence, WhatsApp `.txt` ingestion, archive
moves.

```ts
export interface FileSystem {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer | string, mode?: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  watch(dir: string, glob: string, onEvent: (path: string) => void): () => void;
  listDir(path: string): Promise<string[]>; // sorted
}
```

**Real**: `src/support/fs-node.ts` — wraps `node:fs/promises` + `chokidar`.

**Fake**: `InMemoryFileSystem` — backed by a `Map<string, Buffer>`. Supports
`watch()` by exposing a `trigger(path)` method the test can call to
simulate a new file landing.

Business logic NEVER imports `node:fs` directly.

### 3.5 MSAL token cache — `TokenProvider`

MSAL is a particularly leaky seam because `@azure/msal-node` has its own
API surface. We wrap it:

```ts
export interface TokenProvider {
  getTokenSilent(account: string): Promise<string>;
  addAccountInteractive(): Promise<{ account: string }>;
  listAccounts(): Promise<string[]>;
}
```

**Real**: `src/auth/msal-provider.ts` — the only file allowed to
`import "@azure/msal-node"`. Disk cache plugin lives here.

**Fake**: `FakeTokenProvider` — returns canned tokens, can be scripted to
throw `TokenExpiredError` for specific accounts.

### 3.6 Logger — `Logger`

```ts
export interface Logger {
  info(event: string, ctx?: Record<string, unknown>): void;
  warn(event: string, ctx?: Record<string, unknown>): void;
  error(event: string, ctx?: Record<string, unknown>): void;
}
```

**Real**: `src/support/logger.ts` — writes JSON lines to `process.stdout`
(or a file stream).

**Fake**: `ArrayLogger` — `{ entries: [] }`. Tests assert
`logger.entries.find(e => e.event === "delta_sync_completed")`. Never
assert on formatted strings; always on structured events.

### 3.7 HTTP server — `HttpServer`

MCP transport lives behind this seam so tests can hit the MCP tools
without opening a real port.

```ts
export interface HttpServer {
  start(port: number): Promise<void>;
  stop(): Promise<void>;
  on(method: "GET" | "POST", path: string, handler: RequestHandler): void;
}
```

**Real**: `src/support/http-node.ts` — wraps Node's `node:http`.

**Fake**: `InProcessHttpServer` — a test double where `start`/`stop` are
no-ops and tests invoke handlers directly via
`server.call("POST", "/mcp", { headers, body })`. Used in MCP tool tests
and integration tests for bearer-token middleware.

### 3.8 ID generation — `IdSource`

Anywhere we need a stable hash (message primary key, WhatsApp dedup):

```ts
export interface IdSource {
  hashOf(parts: readonly string[]): string; // stable sha256 hex
}
```

**Real**: `src/support/ids.ts` — uses `node:crypto`.

**Fake**: `FakeIdSource` — can be the real sha256 (usually fine) or a
deterministic counter for tests that want readable IDs.

---

## 4. Checklist: is my new module testable?

Before writing a new source file, answer these. "No" to any = redesign.

- [ ] Does it accept its dependencies via a `Deps` object or function
      parameters, rather than importing them directly?
- [ ] Is every I/O primitive it uses (fetch, fs, clock, random, crypto,
      process.env) behind an interface?
- [ ] Can I construct an instance of it in a test using only fakes, with
      zero network / zero disk / zero wall-clock reads?
- [ ] Does every error it can throw have a typed class or a well-known
      error code a test can assert on?
- [ ] Can I exercise every branch of its logic from outside, without
      reaching into private state?

If all yes, it will be easy to test. If any no, fix the seam *before*
writing the RED test — the test will be easier and the code will be
better.

---

## 5. Anti-patterns banned in this repo

- `new Date()` / `Date.now()` in business logic → use `clock.now()`.
- `Math.random()` anywhere → seeded or from `ids`.
- `process.env.X` outside `src/config.ts` → config is loaded once and
  passed as a value.
- `require(...)` dynamic imports → ESM only, static imports.
- `fetch(...)` outside `src/sources/graph-http.ts` and
  `src/support/http-node.ts`. **Lint-enforced** (slice A3.4): the
  ESLint rule `no-restricted-globals` bans bare `fetch` in
  `src/sources/**` and `src/sync/**`. Every outbound HTTP call must
  go through an injected `FetchLike`, and the production wiring in
  [`src/index.ts`](../../src/index.ts) wraps that `FetchLike` with
  [`createFetchWithTimeout`](../../src/sources/fetch-with-timeout.ts)
  so no single stuck connection can wedge the event loop. Regression
  test: [`src/__meta__/lint-bare-fetch.test.ts`](../../src/__meta__/lint-bare-fetch.test.ts).
- `import("better-sqlite3")` outside `src/store/sqlite.ts`.
- `import("@azure/msal-node")` outside `src/auth/msal-provider.ts`.
- Singletons (`let instance: X | undefined`) → always pass the instance
  as a dependency.

A test in `src/__meta__/seam-boundaries.test.ts` greps the codebase for
these patterns and fails if found outside their allowlist. Write it at
Weekend 2.
