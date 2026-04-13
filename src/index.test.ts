import { describe, it, expect } from "vitest";
import { main } from "./index.js";
import { ConfigError } from "./config.js";

describe("main", () => {
  it("throws ConfigError when required env vars are absent (no side effects)", async () => {
    await expect(main({ env: {}, loadDotenv: false })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("throws ConfigError when only BEARER_TOKEN is set", async () => {
    await expect(
      main({ env: { BEARER_TOKEN: "x" }, loadDotenv: false }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
