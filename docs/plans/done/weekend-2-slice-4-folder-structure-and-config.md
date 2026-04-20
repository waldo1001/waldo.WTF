## Task

Create the Weekend 2 folder skeleton and land a typed `Config` loader,
proven by failing-then-passing tests on env parsing. Add a stub
`src/index.ts` entrypoint that wires nothing yet. No auth, sync, store,
or MCP logic in this slice — just the shape future slices will fill in.

## Why this slice next

- PROGRESS.md Weekend 2 next unchecked: "Folder structure (`src/auth`,
  `src/sources`, `src/store`, `src/sync`, `src/mcp`, `src/config.ts`,
  `src/index.ts`)".
- `src/sources/` already exists (slice 3). Remaining module folders
  don't — landing them as empty dirs anchors import paths for the
  upcoming TDD slices (auth first, then store, then sync).
- `Config` is the one piece with real behavior: every future slice
  needs typed access to `MS_CLIENT_ID`, `BEARER_TOKEN`, DB path, etc.
  Doing it now (pure function, no singleton, injected) keeps the
  dependency-injection pattern consistent from the start.
- Low risk: pure function over `Record<string, string | undefined>`,
  no fs, no network, no native deps, no secrets in tests.

## Scope boundary

**IN this slice:**
- Create empty dirs with `.gitkeep`:
  - `src/auth/`
  - `src/store/`
  - `src/sync/`
  - `src/mcp/`
  (`src/sources/` already exists.)
- `src/config.ts`:
  - `Config` type (readonly): `msClientId: string`, `bearerToken:
    string`, `dbPath: string`, `authDir: string`.
  - `ConfigError` class (extends `Error`) with a `missing: string[]`
    field.
  - `loadConfig(env: Record<string, string | undefined>): Config` —
    pure function, no `process.env` access inside. Validates required
    keys, applies defaults for path fields, throws `ConfigError`
    listing ALL missing required keys (not just the first).
  - Exported constants for default paths (so tests can assert without
    hardcoding strings twice).
- `src/config.test.ts` — unit tests (RED list below).
- `src/index.ts`:
  - Minimal stub: `export async function main(): Promise<void>` that
    throws `new Error("not implemented")`. Top-level guard
    `if (import.meta.url === ...)` deferred — no CLI wiring yet.
  - No `process.env` read here either; wiring happens in a later slice.
- `.env.example` at repo root documenting `MS_CLIENT_ID`,
  `BEARER_TOKEN`, optional `WALDO_DB_PATH`, `WALDO_AUTH_DIR`.

**OUT of this slice (explicitly deferred):**
- Real MSAL auth, token cache persistence (`src/auth/*`).
- SQLite schema + store (`src/store/*`).
- Sync loop + `sync_log` (`src/sync/*`).
- MCP transport/tools (`src/mcp/*`).
- Real Graph HTTP client (still only the interface + fake from slice 3).
- Reading `process.env` or loading `.env` files (dotenv). `loadConfig`
  takes env as an argument so tests stay pure; the caller that reads
  `process.env` arrives with the CLI wiring slice.
- `index.ts` actually running anything.

## Files to touch

- **Create**: `src/auth/.gitkeep`, `src/store/.gitkeep`,
  `src/sync/.gitkeep`, `src/mcp/.gitkeep`, `src/config.ts`,
  `src/config.test.ts`, `src/index.ts`, `.env.example`.
- **Edit**: `PROGRESS.md` (tick the folder-structure box) during the
  UPDATE DOCS step.

## Seams

- `loadConfig(env)` takes env as a parameter — the "read `process.env`"
  seam lives at the CLI entrypoint, not inside config logic. This
  matches the clock/fs/graph pattern: business logic never touches
  globals directly.

## RED test list (`src/config.test.ts`)

1. `loadConfig` returns a fully-populated `Config` when all required
   env vars are present.
2. `loadConfig` applies the default `dbPath` when `WALDO_DB_PATH` is
   unset.
3. `loadConfig` applies the default `authDir` when `WALDO_AUTH_DIR` is
   unset.
4. `loadConfig` honors `WALDO_DB_PATH` when set.
5. `loadConfig` honors `WALDO_AUTH_DIR` when set.
6. `loadConfig` throws `ConfigError` when `MS_CLIENT_ID` is missing,
   and `err.missing` contains `"MS_CLIENT_ID"`.
7. `loadConfig` throws `ConfigError` when `BEARER_TOKEN` is missing,
   and `err.missing` contains `"BEARER_TOKEN"`.
8. `loadConfig` throws `ConfigError` listing BOTH keys when both are
   missing (not just the first one hit).
9. `loadConfig` treats empty-string values as missing (not valid).
10. `loadConfig` does not mutate the input env object.
11. Returned `Config` is readonly at the type level (compile-time
    assertion via `Readonly<Config>` / `as const` usage — documented as
    a type test, not a runtime test).
12. `main()` in `src/index.ts` rejects with `"not implemented"` — this
    is a placeholder test that gets replaced when real wiring lands;
    included so the file has coverage from day one.

## Risks

- **Over-scoping**: Temptation to wire `process.env` + dotenv + CLI
  now. Resisted — that belongs with the first slice that actually
  needs to run something end-to-end.
- **`.gitkeep` churn**: Empty dirs feel silly but anchor import paths
  and make the folder structure visible in PR reviews. Accepted.
- **Readonly assertion**: TypeScript-only check; may not add runtime
  value. Keeping it as a documented type test, not a runtime
  assertion.

## Definition of done

- All 12 tests written, proven RED, then GREEN.
- `npm test` passes with ≥90% line+branch coverage on
  `src/config.ts` and `src/index.ts`.
- `/security-scan` clean (no secrets in `.env.example`, no real tokens
  in tests).
- `/docs-update` run: changelog entry + PROGRESS.md folder-structure
  box ticked.
- Self-review checklist from methodology §2.8 passed.
