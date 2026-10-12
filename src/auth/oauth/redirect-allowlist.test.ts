import { describe, expect, it } from "vitest";
import {
  DEFAULT_REDIRECT_ALLOWLIST,
  isRedirectAllowed,
} from "./redirect-allowlist.js";

const allow = DEFAULT_REDIRECT_ALLOWLIST;

describe("isRedirectAllowed", () => {
  it("allows the claude.ai and claude.com connector callbacks by default", () => {
    expect(
      isRedirectAllowed("https://claude.ai/api/mcp/auth_callback", allow),
    ).toBe(true);
    expect(
      isRedirectAllowed("https://claude.com/api/mcp/auth_callback", allow),
    ).toBe(true);
  });

  it("allows http loopback callbacks on any port and path (Desktop / Claude Code)", () => {
    expect(isRedirectAllowed("http://localhost:53682/callback", allow)).toBe(
      true,
    );
    expect(isRedirectAllowed("http://127.0.0.1:1/x", allow)).toBe(true);
    expect(isRedirectAllowed("http://[::1]:8080/cb", allow)).toBe(true);
    expect(isRedirectAllowed("http://localhost/cb", allow)).toBe(true);
  });

  it("rejects an arbitrary https host (consent phishing target)", () => {
    expect(isRedirectAllowed("https://evil.example/cb", allow)).toBe(false);
  });

  it("rejects look-alike hosts and paths", () => {
    expect(
      isRedirectAllowed(
        "https://claude.ai.evil.example/api/mcp/auth_callback",
        allow,
      ),
    ).toBe(false);
    expect(isRedirectAllowed("https://claude.ai/api/mcp/other", allow)).toBe(
      false,
    );
    expect(isRedirectAllowed("http://evil.localhost.example/cb", allow)).toBe(
      false,
    );
    expect(
      isRedirectAllowed("http://claude.ai/api/mcp/auth_callback", allow),
    ).toBe(false);
  });

  it("rejects userinfo and fragments even on an allowed host", () => {
    expect(
      isRedirectAllowed(
        "https://claude.ai@evil.example/api/mcp/auth_callback",
        allow,
      ),
    ).toBe(false);
    expect(
      isRedirectAllowed("http://user:pw@localhost:1234/cb", allow),
    ).toBe(false);
    expect(
      isRedirectAllowed("https://claude.ai/api/mcp/auth_callback#x", allow),
    ).toBe(false);
  });

  it("rejects malformed URIs and non-http schemes", () => {
    expect(isRedirectAllowed("not a url", allow)).toBe(false);
    expect(isRedirectAllowed("javascript:alert(1)", allow)).toBe(false);
    expect(isRedirectAllowed("ftp://localhost/cb", allow)).toBe(false);
  });

  it("honours a custom allowlist and still allows loopback", () => {
    const custom = ["https://example.test/cb"];
    expect(isRedirectAllowed("https://example.test/cb", custom)).toBe(true);
    expect(
      isRedirectAllowed("https://claude.ai/api/mcp/auth_callback", custom),
    ).toBe(false);
    expect(isRedirectAllowed("http://localhost:9/cb", custom)).toBe(true);
  });

  it("rejects username-only and password-only credentials on loopback", () => {
    expect(isRedirectAllowed("http://user@localhost:1/cb", allow)).toBe(false);
    expect(isRedirectAllowed("http://:pw@localhost:1/cb", allow)).toBe(false);
  });

  it("rejects a loopback callback carrying a fragment, even an empty one", () => {
    expect(isRedirectAllowed("http://localhost:1/cb#x", allow)).toBe(false);
    expect(isRedirectAllowed("http://localhost:1/cb#", allow)).toBe(false);
  });

  it("never allows a non-https remote scheme even if it is listed", () => {
    expect(isRedirectAllowed("ftp://files.example/cb", ["ftp://files.example/cb"])).toBe(false);
  });
});
