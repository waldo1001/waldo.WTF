// Mutation testing config. Policy: docs/tdd/coverage-policy.md
// ("Minimum surviving-mutant rate: <20%" => mutation score break threshold 80).
//
// Usage in /tdd-cycle's MUTATE step: scope every run to the files touched in
// the current slice via `--mutate`, e.g.
//   npx stryker run --mutate "src/store/schema.ts,src/store/sqlite-message-store.ts"
// Running with no --mutate override mutates the whole default set below and
// is slow (minutes) — reserve that for periodic full-repo audits, not every
// TDD cycle.
//
// @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
export default {
  packageManager: "npm",
  testRunner: "vitest",
  reporters: ["clear-text", "progress", "html"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/**/*.d.ts",
    "!src/testing/**",
    "!src/**/__fixtures__/**",
    "!src/**/__lint__/**",
    "!src/**/__integration__/**",
    "!src/**/__contract__/**",
    // Composition root + env parsing — excluded from coverage too
    // (docs/tdd/coverage-policy.md §Exclusions); mutating pure wire-up code
    // produces no meaningful kills.
    "!src/index.ts",
    "!src/config.ts",
  ],
  thresholds: {
    high: 90,
    low: 80,
    break: 80,
  },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  // better-sqlite3 (native addon) crashes with SIGSEGV under Stryker's
  // default concurrency (multiple test-runner child processes hitting the
  // native binary at once) on this dev machine. Confirmed stable at 1;
  // raise only if re-verified crash-free on the target machine.
  concurrency: 1,
};
