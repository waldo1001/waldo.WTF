import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

describe("no-restricted-globals: bare fetch in src/sources and src/sync", () => {
  it("flags the bare-fetch fixture under src/sources/__lint__", async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const results = await eslint.lintFiles([
      "src/sources/__lint__/bare-fetch.fixture.ts",
    ]);
    expect(results).toHaveLength(1);
    const result = results[0]!;
    const ruleHits = result.messages.filter(
      (m) => m.ruleId === "no-restricted-globals",
    );
    expect(ruleHits).toHaveLength(1);
    expect(ruleHits[0]!.severity).toBe(2);
    expect(ruleHits[0]!.message).toContain("FetchLike");
  });

  it("clean tree: no bare-fetch hits in src/sources or src/sync excluding fixtures", async () => {
    const eslint = new ESLint({
      cwd: repoRoot,
      overrideConfig: [
        { ignores: ["src/sources/__lint__/**"] },
      ] as unknown as ESLint.Options["overrideConfig"],
    });
    const results = await eslint.lintFiles([
      "src/sources/**/*.ts",
      "src/sync/**/*.ts",
    ]);
    const offenders = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === "no-restricted-globals")
        .map((m) => `${r.filePath}:${m.line}: ${m.message}`),
    );
    expect(offenders).toEqual([]);
  });
});
