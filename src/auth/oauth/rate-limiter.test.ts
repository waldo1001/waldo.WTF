import { describe, expect, it } from "vitest";
import { FakeClock } from "../../testing/fake-clock.js";
import { FixedWindowRateLimiter } from "./rate-limiter.js";

const T0 = new Date("2026-10-12T10:00:00Z");

const make = (perKey: number, global: number, windowMs = 60_000) => {
  const clock = new FakeClock(T0);
  const limiter = new FixedWindowRateLimiter({ clock, windowMs, perKey, global });
  return { clock, limiter };
};

describe("FixedWindowRateLimiter", () => {
  it("allows up to perKey calls in a window, then refuses with Retry-After seconds", () => {
    const { clock, limiter } = make(3, 100);
    for (let i = 0; i < 3; i++) expect(limiter.check("1.2.3.4").allowed).toBe(true);
    clock.advance(15_000);
    const refused = limiter.check("1.2.3.4");
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 45 });
  });

  it("rounds Retry-After up and never reports 0", () => {
    const { clock, limiter } = make(1, 100);
    limiter.check("k");
    clock.advance(59_999);
    expect(limiter.check("k")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("allows again once the window rolls over", () => {
    const { clock, limiter } = make(1, 100);
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(false);
    clock.advance(60_000);
    expect(limiter.check("k").allowed).toBe(true);
  });

  it("isolates keys from each other", () => {
    const { limiter } = make(1, 100);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("trips the global bucket across many keys", () => {
    const { limiter } = make(10, 3);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("c").allowed).toBe(true);
    expect(limiter.check("d").allowed).toBe(false);
  });

  it("does not count refused calls against the global bucket", () => {
    const { limiter } = make(1, 2);
    expect(limiter.check("a").allowed).toBe(true);
    for (let i = 0; i < 5; i++) expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("forgets all keys when the window rolls (bounded memory)", () => {
    const { clock, limiter } = make(5, 1000);
    for (let i = 0; i < 50; i++) limiter.check(`ip-${i}`);
    expect(limiter.trackedKeys()).toBe(50);
    clock.advance(60_000);
    limiter.check("fresh");
    expect(limiter.trackedKeys()).toBe(1);
  });
});
