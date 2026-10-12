import { describe, expect, it } from "vitest";
import { hashToken } from "./token-hash.js";

describe("hashToken", () => {
  it("returns the lowercase hex SHA-256 of the token", () => {
    // sha256("abc") — RFC 6234 test vector
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic and distinguishes inputs", () => {
    expect(hashToken("t-1")).toBe(hashToken("t-1"));
    expect(hashToken("t-1")).not.toBe(hashToken("t-2"));
  });
});
