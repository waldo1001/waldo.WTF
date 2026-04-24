import { describe, it, expect, vi, afterEach } from "vitest";
import { consoleLogger, createTimestampedConsoleLogger } from "./logger.js";
import { FakeClock } from "./testing/fake-clock.js";

describe("consoleLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards info to console.log and error to console.error", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    consoleLogger.info("hello");
    consoleLogger.error("boom");

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("hello");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith("boom");
  });
});

describe("createTimestampedConsoleLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefixes info lines with clock.now().toISOString() in brackets", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = new FakeClock(new Date("2026-04-24T12:34:56.789Z"));
    const logger = createTimestampedConsoleLogger(clock);
    logger.info("hello");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      "[2026-04-24T12:34:56.789Z] hello",
    );
  });

  it("prefixes error lines and routes to console.error", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = new FakeClock(new Date("2026-04-24T12:34:56.789Z"));
    const logger = createTimestampedConsoleLogger(clock);
    logger.error("boom");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      "[2026-04-24T12:34:56.789Z] boom",
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("reads clock.now() on every call, not at construction", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = new FakeClock(new Date("2026-04-24T12:00:00.000Z"));
    const logger = createTimestampedConsoleLogger(clock);
    logger.info("first");
    clock.advance(5 * 60 * 1000);
    logger.info("second");
    expect(logSpy).toHaveBeenNthCalledWith(
      1,
      "[2026-04-24T12:00:00.000Z] first",
    );
    expect(logSpy).toHaveBeenNthCalledWith(
      2,
      "[2026-04-24T12:05:00.000Z] second",
    );
  });

  it("prefixes multi-line messages exactly once at the start", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = new FakeClock(new Date("2026-04-24T00:00:00.000Z"));
    const logger = createTimestampedConsoleLogger(clock);
    logger.info("line one\nline two\nline three");
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [arg] = logSpy.mock.calls[0]!;
    expect(arg).toBe("[2026-04-24T00:00:00.000Z] line one\nline two\nline three");
    expect((arg as string).match(/\[2026-/g)?.length).toBe(1);
  });
});
