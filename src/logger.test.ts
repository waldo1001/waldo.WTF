import { describe, it, expect, vi, afterEach } from "vitest";
import { consoleLogger } from "./logger.js";

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
