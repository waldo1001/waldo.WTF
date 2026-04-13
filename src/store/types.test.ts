import { describe, expect, it } from "vitest";
import { StoreError } from "./types.js";

describe("StoreError", () => {
  it("defaults the message to the kind when none is provided", () => {
    const err = new StoreError("not-found");
    expect(err.kind).toBe("not-found");
    expect(err.message).toBe("not-found");
    expect(err.name).toBe("StoreError");
    expect(err).toBeInstanceOf(Error);
  });

  it("preserves an explicit message and cause", () => {
    const cause = new Error("underlying");
    const err = new StoreError("corrupt", "boom", { cause });
    expect(err.message).toBe("boom");
    expect(err.cause).toBe(cause);
  });
});
