import { defineConfig } from "vitest/config";

// Drop-in Vitest config for waldo.WTF.
// Policy reference: ../docs/tdd/coverage-policy.md
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/__integration__/**/*.test.ts"],
    // Fail fast on .only in CI — no one should ever commit focus-mode tests.
    allowOnly: !process.env.CI,
    // Tests must be fast. See methodology §6.
    testTimeout: 5_000,
    hookTimeout: 5_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        // Composition roots — integration tested, not unit tested.
        "src/index.ts",
        "src/config.ts",
        // Type-only files.
        "src/**/*.d.ts",
        // Test doubles themselves (covered by their contract tests).
        "src/testing/**",
        // Static fixtures.
        "src/**/__fixtures__/**",
        // Test files shouldn't count toward production coverage.
        "src/**/*.test.ts",
        "src/**/__integration__/**",
        "src/**/__contract__/**",
      ],
      // Per-file thresholds — a global average hides untested hot-spots.
      // See ../docs/tdd/coverage-policy.md.
      thresholds: {
        perFile: true,
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
