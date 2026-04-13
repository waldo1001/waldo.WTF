# Testing toolchain — drop-in for Weekend 2

These files are templates. Copy them into the TypeScript project root when
it's created at Weekend 2 (per the build plan in
[../waldo.WTF-project-brief.md](../waldo.WTF-project-brief.md) §7).

## Files

- [vitest.config.ts](vitest.config.ts) — Vitest config with 90% thresholds, per-file enforcement, and the exclusions from [../docs/tdd/coverage-policy.md](../docs/tdd/coverage-policy.md).
- [package.deps.json](package.deps.json) — the exact dev dependencies to add to the project's `package.json` at Weekend 2. Copy the `devDependencies` and `scripts` blocks.
- [tsconfig.test.json](tsconfig.test.json) — TypeScript config extension for tests (strict, no emit, includes vitest globals).
- [examples/](examples/) — worked examples showing the testability patterns for this project's seams. Use as reference when writing the first real tests.
  - [examples/delta-sync.test.example.ts](examples/delta-sync.test.example.ts) — canonical unit test shape using injected `GraphClient`, `MessageStore`, `Clock`, `Logger`.
  - [examples/fake-graph-client.example.ts](examples/fake-graph-client.example.ts) — how to build a deterministic fake for the Microsoft Graph seam.
  - [examples/fake-clock.example.ts](examples/fake-clock.example.ts) — fake `Clock` implementation.

## Why these exist outside `src/`

At the time of writing (Weekend 1), there is no TypeScript project yet — just
a spike at `/Users/waldo/Temp/waldo-wtf-spike/`. These templates live here so
that the moment `waldo.WTF/` becomes a real npm project, Claude can pull them
in without reinventing the config.

## Installation (when Weekend 2 lands)

```sh
cd waldo.WTF
npm init -y
# merge the devDependencies + scripts from testing/package.deps.json into package.json
npm install
cp testing/vitest.config.ts ./vitest.config.ts
cp testing/tsconfig.test.json ./tsconfig.test.json
mkdir -p src/testing
# port the example fakes into src/testing/ as real source files
```

Then run `npm test`. With zero tests, Vitest will report "no test files found"
— that's the correct starting state. The first real test is the first RED in
the first `/tdd-cycle`.
