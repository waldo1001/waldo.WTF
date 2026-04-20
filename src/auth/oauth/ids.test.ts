import { describe, expect, it } from "vitest";
import { cryptoRandomIdSource, type RandomIdSource } from "./ids.js";

describe("cryptoRandomIdSource", () => {
  it("generates a 64-char hex string (32 random bytes)", () => {
    const ids: RandomIdSource = cryptoRandomIdSource;
    const id = ids.next();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different value on each call", () => {
    const ids: RandomIdSource = cryptoRandomIdSource;
    const a = ids.next();
    const b = ids.next();
    expect(a).not.toBe(b);
  });
});
