import { describe, expect, it } from "vitest";
import { scryptPasswordHasher, PlaintextPasswordHasher } from "./password.js";

describe("scryptPasswordHasher", () => {
  it("hash produces a non-empty string", async () => {
    const hash = await scryptPasswordHasher.hash("my-password");
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
    expect(hash).toContain(":");
  });

  it("verify returns true for correct password", async () => {
    const hash = await scryptPasswordHasher.hash("correct-horse-battery");
    const ok = await scryptPasswordHasher.verify("correct-horse-battery", hash);
    expect(ok).toBe(true);
  });

  it("verify returns false for wrong password", async () => {
    const hash = await scryptPasswordHasher.hash("correct-horse-battery");
    const ok = await scryptPasswordHasher.verify("wrong-password", hash);
    expect(ok).toBe(false);
  });

  it("verify returns false for malformed stored hash", async () => {
    const ok = await scryptPasswordHasher.verify("any", "no-colon-here");
    expect(ok).toBe(false);
  });

  it("two calls to hash produce different salts (different outputs)", async () => {
    const h1 = await scryptPasswordHasher.hash("same");
    const h2 = await scryptPasswordHasher.hash("same");
    expect(h1).not.toBe(h2);
  });
});

describe("PlaintextPasswordHasher", () => {
  const hasher = new PlaintextPasswordHasher();

  it("hash produces a deterministic non-empty string", async () => {
    const h = await hasher.hash("hello");
    expect(h).toBe("plain:hello");
  });

  it("verify returns true for matching password", async () => {
    const h = await hasher.hash("secret");
    expect(await hasher.verify("secret", h)).toBe(true);
  });

  it("verify returns false for wrong password", async () => {
    const h = await hasher.hash("secret");
    expect(await hasher.verify("wrong", h)).toBe(false);
  });
});
