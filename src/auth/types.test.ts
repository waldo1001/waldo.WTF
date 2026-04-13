import { describe, expect, it } from "vitest";
import { AuthError } from "./types.js";

describe("AuthError", () => {
  it("defaults the message to the kind when none is provided", () => {
    const err = new AuthError("no-accounts");
    expect(err.kind).toBe("no-accounts");
    expect(err.message).toBe("no-accounts");
    expect(err.name).toBe("AuthError");
    expect(err).toBeInstanceOf(Error);
  });

  it("preserves an explicit message and cause", () => {
    const cause = new Error("underlying");
    const err = new AuthError("cache-corrupt", "boom", { cause });
    expect(err.message).toBe("boom");
    expect(err.cause).toBe(cause);
  });
});
