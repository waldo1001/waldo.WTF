import { defineConfig } from "vitest/config";

// Policy reference: docs/tdd/coverage-policy.md
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/__integration__/**/*.test.ts"],
    allowOnly: !process.env.CI,
    testTimeout: 5_000,
    hookTimeout: 5_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/testing/**",
        "src/**/__fixtures__/**",
        "src/**/*.test.ts",
        "src/**/__integration__/**",
        "src/**/__contract__/**",
        // composition root — wires real MSAL/SQLite/http together. Excluded
        // per docs/tdd/coverage-policy.md §Exclusions. Validated by smoke run.
        "src/index.ts",
      ],
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
