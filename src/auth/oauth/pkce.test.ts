import { describe, expect, it } from "vitest";
import { verifyPkceS256 } from "./pkce.js";
import { createHash } from "node:crypto";

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

const makeChallenge = (verifier: string): string =>
  b64url(createHash("sha256").update(verifier).digest());

describe("verifyPkceS256", () => {
  it("returns true when verifier hashes to challenge", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = makeChallenge(verifier);
    expect(verifyPkceS256(challenge, verifier)).toBe(true);
  });

  it("returns false for wrong verifier", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = makeChallenge(verifier);
    expect(verifyPkceS256(challenge, "wrong-verifier")).toBe(false);
  });

  it("returns false for empty verifier", () => {
    const challenge = makeChallenge("some-verifier");
    expect(verifyPkceS256(challenge, "")).toBe(false);
  });

  it("returns false for empty challenge", () => {
    expect(verifyPkceS256("", "some-verifier")).toBe(false);
  });

  it("is timing-safe: same result regardless of challenge length mismatch", () => {
    const result = verifyPkceS256("short", "some-verifier");
    expect(result).toBe(false);
  });
});
