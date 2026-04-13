import { describe, it, expect } from "vitest";
import { main } from "./index.js";

describe("main", () => {
  it("rejects with 'not implemented'", async () => {
    await expect(main()).rejects.toThrow("not implemented");
  });
});
