import { describe, expect, it } from "vitest";
import { FakeClock } from "./fake-clock.js";

describe("FakeClock", () => {
  it("now() returns the initial time it was constructed with", () => {
    const initial = new Date("2026-04-13T08:00:00.000Z");
    const clock = new FakeClock(initial);
    expect(clock.now().toISOString()).toBe(initial.toISOString());
  });

  it("advance(ms) moves now() forward by the given milliseconds", () => {
    const clock = new FakeClock(new Date("2026-04-13T08:00:00.000Z"));
    clock.advance(1_500);
    expect(clock.now().toISOString()).toBe("2026-04-13T08:00:01.500Z");
    clock.advance(0);
    expect(clock.now().toISOString()).toBe("2026-04-13T08:00:01.500Z");
    clock.advance(500);
    expect(clock.now().toISOString()).toBe("2026-04-13T08:00:02.000Z");
  });

  it("set(d) replaces the current time with the given Date", () => {
    const clock = new FakeClock(new Date("2026-04-13T08:00:00.000Z"));
    clock.set(new Date("2026-05-01T12:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-05-01T12:00:00.000Z");
    // Explicit: setting backward is allowed (simulates clock skew).
    clock.set(new Date("2026-04-01T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
});
