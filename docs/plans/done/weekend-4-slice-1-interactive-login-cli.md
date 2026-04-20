# Weekend 4 — Slice 1: Interactive login CLI (`--add-account`)

## Goal

Let a new Microsoft account be logged in from the production entry point
without reaching for the spike. Today `MsalAuthClient.loginWithDeviceCode`
exists but is not wired into any runnable command — `main()` only starts
the server + sync loop and silently assumes the token cache is already
populated.

## Why this slice first

PROGRESS.md Weekend 4 first bullet ("Remaining Microsoft accounts logged
in") is blocked until there is a way to run the device-code flow against
the real `TokenCacheStore` in-repo. Every other Weekend 4 slice (Teams
schema, TeamsClient, sync wiring, MCP coverage) assumes accounts are
present, so this is the gate.

## Scope boundary

**IN:**
- New `src/cli.ts` exposing:
  - `runCli(argv, deps?)` — argv parser dispatching between server mode
    (delegates to existing `main()`) and login mode.
  - `addAccount(opts)` — loads config, builds `TokenCacheStore` +
    `MsalAuthClient` (or uses injected `auth`), calls
    `loginWithDeviceCode`, returns `{ account }`. No DB, no HTTP.
- CLI bootstrap at the bottom of `src/cli.ts`
  (`if (import.meta.url === \`file://${process.argv[1]}\`)`) that calls
  `runCli(process.argv.slice(2))`, prints device-code prompt to stdout,
  prints `Added account: <username>` on success, and exits with the
  right code on failure.
- `npm` script `add-account` and `start` entry points.
- Unit tests: argv parsing, ConfigError propagation, injected
  `FakeAuthClient` exercising the login path, prompt forwarding,
  unknown-flag error.

**OUT:**
- Any change to `main()` body, server, scheduler, or MCP surface.
- Real MSAL — live login remains a manual smoke. Tests inject
  `FakeAuthClient`.
- `--list-accounts` / `--remove-account`. Deferred.
- Multi-account orchestration — one login per invocation.

## Files to touch

- `src/cli.ts` (new)
- `src/cli.test.ts` (new)
- `package.json` — add `"start"` and `"add-account"` scripts.
- `docs/changelog.md` (docs-update step).

## Seams

- `AuthClient` — already an interface, `FakeAuthClient` already exists.
- `TokenCacheStore` — already fs-injectable.
- stdout — inject a `print: (msg: string) => void` so tests can capture.

## RED test list

1. `runCli(['--add-account'], deps)` invokes `auth.loginWithDeviceCode`
   exactly once and resolves with `{ mode: 'add-account', account }`.
2. `runCli(['--add-account'], deps)` forwards the MSAL device-code
   message to the injected `print` callback.
3. `runCli([], { env: {}, loadDotenv: false })` returns
   `{ mode: 'server' }` intent but surfaces `ConfigError` from
   `loadConfig` when env is empty. (We assert ConfigError.)
4. `runCli(['--add-account'], { env: {}, loadDotenv: false })` throws
   `ConfigError` — login mode also needs `MS_CLIENT_ID`.
5. `runCli(['--wat'])` throws a usage error mentioning the unknown flag.
6. `addAccount({ env, auth, print })` returns the account from the fake
   without touching the filesystem or network.
7. `addAccount` surfaces `AuthError` when the fake's scripted device-code
   result is an error.

## Risks

- Node ESM `import.meta.url` main-module check is finicky under tsx vs
  compiled output. Mitigation: bootstrap block is one line, untested,
  `/* c8 ignore */`d; the testable surface is `runCli` / `addAccount`.
- Accidentally starting the server when `--add-account` is passed.
  Mitigation: `runCli` dispatches before any call to `main()`.

## Out of scope (explicit)

- Wiring the bootstrap into an actual npm binary or `bin` field.
- Docs beyond changelog + a one-line pointer in
  getting-started.md if natural.

## Definition of done

- RED list above is all green.
- `vitest run --coverage` ≥ 90% line + branch on touched files.
- `/security-scan` clean.
- `/docs-update` logs the slice.
- Committed + pushed.

---

**Auto-approved per user instruction ("auto-approved after each plan").**
