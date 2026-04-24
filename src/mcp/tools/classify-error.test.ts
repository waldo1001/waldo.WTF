import { describe, it, expect } from "vitest";
import {
  classifyError,
  extractRetryAfterSeconds,
} from "./classify-error.js";

describe("classifyError", () => {
  it("returns 'auth' for TokenExpiredError messages", () => {
    expect(classifyError("TokenExpiredError: Yammer 401")).toBe("auth");
    expect(classifyError("Yammer 401")).toBe("auth");
    expect(classifyError("TokenExpiredError")).toBe("auth");
  });

  it("returns 'auth' for Graph 401 / 401 unauthorized messages", () => {
    expect(classifyError("Graph 401: Unauthorized")).toBe("auth");
    expect(classifyError("401 Unauthorized")).toBe("auth");
    expect(classifyError("HTTP 401: token expired")).toBe("auth");
  });

  it("returns 'rate-limit' for GraphRateLimitedError-style messages", () => {
    expect(classifyError("graph rate limited, retry after 42s")).toBe(
      "rate-limit",
    );
    expect(
      classifyError("GraphRateLimitedError: graph rate limited, retry after 6s"),
    ).toBe("rate-limit");
  });

  it("returns 'rate-limit' when Retry-After text is present", () => {
    expect(classifyError("HTTP 429 Retry-After: 30")).toBe("rate-limit");
    expect(classifyError("too many requests, retry after 10s")).toBe(
      "rate-limit",
    );
  });

  it("returns 'delta-invalid' for DeltaTokenInvalidError / resync / 410", () => {
    expect(classifyError("DeltaTokenInvalidError: token expired")).toBe(
      "delta-invalid",
    );
    expect(classifyError("resync required")).toBe("delta-invalid");
    expect(classifyError("HTTP 410 Gone")).toBe("delta-invalid");
  });

  it("returns 'unknown-error' for empty string and unmatched text", () => {
    expect(classifyError("")).toBe("unknown-error");
    expect(classifyError("   ")).toBe("unknown-error");
    expect(classifyError("ENETDOWN")).toBe("unknown-error");
    expect(classifyError("ECONNRESET")).toBe("unknown-error");
  });
});

describe("extractRetryAfterSeconds", () => {
  it("parses N from 'retry after Ns'", () => {
    expect(extractRetryAfterSeconds("graph rate limited, retry after 42s")).toBe(
      42,
    );
    expect(extractRetryAfterSeconds("retry after 6s")).toBe(6);
  });

  it("parses N from 'Retry-After: N'", () => {
    expect(extractRetryAfterSeconds("HTTP 429 Retry-After: 30")).toBe(30);
  });

  it("returns undefined when no retry-after is present", () => {
    expect(extractRetryAfterSeconds("boom")).toBeUndefined();
    expect(extractRetryAfterSeconds("")).toBeUndefined();
    expect(extractRetryAfterSeconds("TokenExpiredError: 401")).toBeUndefined();
  });
});
