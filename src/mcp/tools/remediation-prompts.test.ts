import { describe, it, expect } from "vitest";
import {
  buildRemediationPrompt,
  redactSecretsFromError,
} from "./remediation-prompts.js";

describe("redactSecretsFromError", () => {
  it("redacts Bearer <token> substrings to '[REDACTED]'", () => {
    expect(
      redactSecretsFromError("401: Bearer eyJhbGciOiJIUzI1 invalid"),
    ).toBe("401: [REDACTED] invalid");
  });

  it("redacts long opaque base64-ish blobs", () => {
    const blob = "abc123ABCdef456XYZ0PQRstu789=_-".repeat(4);
    expect(redactSecretsFromError(`token: ${blob}`)).toBe("token: [REDACTED]");
  });

  it("leaves short strings and normal error text untouched", () => {
    expect(redactSecretsFromError("graph rate limited, retry after 42s")).toBe(
      "graph rate limited, retry after 42s",
    );
    expect(redactSecretsFromError("Yammer 401")).toBe("Yammer 401");
  });

  it("returns '' for empty input", () => {
    expect(redactSecretsFromError("")).toBe("");
  });
});

describe("buildRemediationPrompt", () => {
  it("auth: mentions --add-account and interpolates account + tenant", () => {
    const p = buildRemediationPrompt({
      category: "auth",
      account: "waldo@example.test",
      source: "outlook",
      tenantId: "tenant-abc",
      lastError: "TokenExpiredError: Yammer 401",
    });
    expect(p).toContain("waldo@example.test");
    expect(p).toContain("--add-account");
    expect(p).toContain("tenant-abc");
  });

  it("delta-invalid: mentions full resync and names the sync_state row", () => {
    const p = buildRemediationPrompt({
      category: "delta-invalid",
      account: "waldo@example.test",
      source: "teams",
      lastError: "DeltaTokenInvalidError: token expired",
    });
    expect(p.toLowerCase()).toContain("resync");
    expect(p).toContain("sync_state");
    expect(p).toContain("waldo@example.test");
    expect(p).toContain("teams");
  });

  it("rate-limit: cites retryAfterSeconds when present, default guidance when absent", () => {
    const withRetry = buildRemediationPrompt({
      category: "rate-limit",
      account: "waldo@example.test",
      source: "outlook",
      lastError: "graph rate limited, retry after 42s",
      retryAfterSeconds: 42,
    });
    expect(withRetry).toContain("42");
    const withoutRetry = buildRemediationPrompt({
      category: "rate-limit",
      account: "waldo@example.test",
      source: "outlook",
      lastError: "HTTP 429",
    });
    expect(withoutRetry.toLowerCase()).toContain("wait");
  });

  it("stale: surfaces last-ok timestamp and mentions the scheduler", () => {
    const p = buildRemediationPrompt({
      category: "stale",
      account: "waldo@example.test",
      source: "outlook",
      lastOkAt: "2026-04-24T09:00:00.000Z",
      staleMs: 45 * 60 * 1000,
    });
    expect(p).toContain("2026-04-24T09:00:00.000Z");
    expect(p.toLowerCase()).toContain("scheduler");
  });

  it("repeated-failure: surfaces consecutive-failures count", () => {
    const p = buildRemediationPrompt({
      category: "repeated-failure",
      account: "waldo@example.test",
      source: "teams",
      consecutiveFailures: 7,
      lastError: "unknown",
    });
    expect(p).toContain("7");
    expect(p.toLowerCase()).toContain("consecutive");
  });

  it("viva-sub-drift: includes community + external-tenant label + consent hint", () => {
    const external = buildRemediationPrompt({
      category: "viva-sub-drift",
      account: "waldo@example.test",
      source: "viva-engage",
      communityId: "com-123",
      communityName: "Contoso Engineering",
      tenantId: "tenant-xyz",
    });
    expect(external).toContain("com-123");
    expect(external).toContain("Contoso Engineering");
    expect(external).toContain("tenant-xyz");
    expect(external.toLowerCase()).toContain("external tenant");
    expect(external.toLowerCase()).toContain("consent");

    const home = buildRemediationPrompt({
      category: "viva-sub-drift",
      account: "waldo@example.test",
      source: "viva-engage",
      communityId: "com-home",
    });
    expect(home.toLowerCase()).not.toContain("external tenant");
  });

  it("never-synced: mentions scheduler has not yet run + check logs", () => {
    const p = buildRemediationPrompt({
      category: "never-synced",
      account: "waldo@example.test",
    });
    expect(p.toLowerCase()).toContain("not yet");
    expect(p.toLowerCase()).toContain("log");
  });

  it("unknown-error: mentions manual investigation + includes redacted lastError", () => {
    const p = buildRemediationPrompt({
      category: "unknown-error",
      account: "waldo@example.test",
      source: "outlook",
      lastError: "Bearer eyJhbGciOiJIUzI1 invalid",
    });
    expect(p).toContain("[REDACTED]");
    expect(p).not.toContain("eyJhbGciOiJIUzI1");
  });

  it("stale: handles missing lastOkAt and staleMs gracefully", () => {
    const p = buildRemediationPrompt({
      category: "stale",
      account: "a@example.test",
      source: "outlook",
    });
    expect(p.toLowerCase()).toContain("last successful sync: unknown");
    expect(p).not.toContain("Staleness:");
  });

  it("auth / delta-invalid / rate-limit: render cleanly without lastError", () => {
    const auth = buildRemediationPrompt({
      category: "auth",
      account: "a@example.test",
      source: "outlook",
    });
    expect(auth).not.toContain("Last error:");

    const delta = buildRemediationPrompt({
      category: "delta-invalid",
      account: "a@example.test",
      source: "teams",
    });
    expect(delta).not.toContain("Last error:");

    const rl = buildRemediationPrompt({
      category: "rate-limit",
      account: "a@example.test",
      source: "outlook",
    });
    expect(rl).not.toContain("Last error:");
  });

  it("repeated-failure / unknown-error: render cleanly without lastError", () => {
    const rf = buildRemediationPrompt({
      category: "repeated-failure",
      account: "a@example.test",
      source: "teams",
      consecutiveFailures: 4,
    });
    expect(rf).toContain("4");
    expect(rf).not.toContain("Last error:");

    const ue = buildRemediationPrompt({
      category: "unknown-error",
      account: "a@example.test",
      source: "outlook",
    });
    expect(ue).not.toContain("Last error:");
  });

  it("repeated-failure defaults consecutiveFailures to 0 when absent", () => {
    const p = buildRemediationPrompt({
      category: "repeated-failure",
      account: "a@example.test",
    });
    expect(p).toContain("0");
  });

  it("source is rendered as 'unknown' when omitted (e.g. account-wide finding)", () => {
    const p = buildRemediationPrompt({
      category: "auth",
      account: "a@example.test",
    });
    expect(p).toContain("unknown");
    const u = buildRemediationPrompt({
      category: "unknown-error",
      account: "a@example.test",
    });
    expect(u).toContain("unknown");
    const s = buildRemediationPrompt({
      category: "stale",
      account: "a@example.test",
    });
    expect(s).toContain("unknown");
  });

  it("viva-sub-drift: renders 'unknown' community when nothing is known", () => {
    const p = buildRemediationPrompt({
      category: "viva-sub-drift",
      account: "a@example.test",
      source: "viva-engage",
    });
    expect(p).toContain("community unknown");
  });

  it("viva-sub-drift: communityName without communityId falls back to empty parens", () => {
    const p = buildRemediationPrompt({
      category: "viva-sub-drift",
      account: "a@example.test",
      source: "viva-engage",
      communityName: "Contoso",
    });
    expect(p).toContain("Contoso ()");
  });

  it("redacts Bearer tokens and long blobs from any interpolated lastError", () => {
    const p = buildRemediationPrompt({
      category: "auth",
      account: "a@example.test",
      source: "outlook",
      lastError:
        "auth failed: Bearer abcdef.ghijkl.mnopqr — request " +
        "aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkkkllll",
    });
    expect(p).not.toContain("abcdef.ghijkl.mnopqr");
    expect(p).not.toContain("aaaabbbbccccdddd");
    expect(p).toContain("[REDACTED]");
  });
});
