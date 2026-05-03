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

  it("does not classify benign 401 substrings as auth", () => {
    expect(classifyError("took 401ms")).toBe("unknown-error");
    expect(classifyError("req_id=401")).toBe("unknown-error");
    expect(classifyError("port 4010 in use")).toBe("unknown-error");
    expect(classifyError("ETIMEDOUT after 4010ms")).toBe("unknown-error");
    expect(classifyError("checkpoint at offset 401")).toBe("unknown-error");
  });

  it("does not classify benign 410 substrings as delta-invalid", () => {
    expect(classifyError("took 410ms")).toBe("unknown-error");
    expect(classifyError("graph 4101: foo")).toBe("unknown-error");
    expect(classifyError("port 4101 in use")).toBe("unknown-error");
    expect(classifyError("offset 410 of 999")).toBe("unknown-error");
  });

  it("still classifies HTTP-anchored 401 patterns as auth", () => {
    expect(classifyError("401 Unauthorized")).toBe("auth");
    expect(classifyError("HTTP 401")).toBe("auth");
    expect(classifyError("Graph 401: token expired")).toBe("auth");
    expect(classifyError("yammer 401")).toBe("auth");
    expect(classifyError("status: 401")).toBe("auth");
    expect(classifyError("status=401")).toBe("auth");
    expect(classifyError("MSAL 401: refresh failed")).toBe("auth");
    expect(classifyError("401 Forbidden")).toBe("auth");
  });

  it("still classifies HTTP-anchored 410 patterns as delta-invalid", () => {
    expect(classifyError("410 Gone")).toBe("delta-invalid");
    expect(classifyError("HTTP 410 Gone")).toBe("delta-invalid");
    expect(classifyError("Graph 410: cursor expired")).toBe("delta-invalid");
    expect(classifyError("status: 410")).toBe("delta-invalid");
    expect(classifyError("status=410")).toBe("delta-invalid");
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
