import { describe, expect, it } from "vitest";
import { systemClock } from "./clock.js";

describe("systemClock", () => {
  it("now() returns current wall time", () => {
    const before = Date.now();
    const observed = systemClock.now().getTime();
    const after = Date.now();
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });
});
