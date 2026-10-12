import { describe, expect, it } from "vitest";
import { loadOAuthConfig, OAuthConfigError } from "./oauth-config.js";
import { DEFAULT_REDIRECT_ALLOWLIST } from "./redirect-allowlist.js";

describe("loadOAuthConfig", () => {
  it("requires WALDO_PUBLIC_URL", () => {
    expect(() => loadOAuthConfig({})).toThrow(OAuthConfigError);
  });

  it("returns publicUrl when WALDO_PUBLIC_URL is set", () => {
    const cfg = loadOAuthConfig({
      WALDO_PUBLIC_URL: "https://nas.example.ts.net",
    });
    expect(cfg.publicUrl).toBe("https://nas.example.ts.net");
  });

  it("trims a trailing slash on WALDO_PUBLIC_URL", () => {
    const cfg = loadOAuthConfig({
      WALDO_PUBLIC_URL: "https://nas.example.ts.net/",
    });
    expect(cfg.publicUrl).toBe("https://nas.example.ts.net");
  });

  it("WALDO_DISABLE_STATIC_BEARER defaults to false", () => {
    const cfg = loadOAuthConfig({
      WALDO_PUBLIC_URL: "https://nas.example.ts.net",
    });
    expect(cfg.disableStaticBearer).toBe(false);
  });

  it("WALDO_DISABLE_STATIC_BEARER='true' yields true", () => {
    const cfg = loadOAuthConfig({
      WALDO_PUBLIC_URL: "https://nas.example.ts.net",
      WALDO_DISABLE_STATIC_BEARER: "true",
    });
    expect(cfg.disableStaticBearer).toBe(true);
  });

  it("WALDO_DISABLE_STATIC_BEARER values other than 'true' yield false", () => {
    const cfg = loadOAuthConfig({
      WALDO_PUBLIC_URL: "https://nas.example.ts.net",
      WALDO_DISABLE_STATIC_BEARER: "yes",
    });
    expect(cfg.disableStaticBearer).toBe(false);
  });

  it("WALDO_ADMIN_PASSWORD is optional in slice 1 (returned when present)", () => {
    const cfg = loadOAuthConfig({
      WALDO_PUBLIC_URL: "https://nas.example.ts.net",
      WALDO_ADMIN_PASSWORD: "secret-pw",
    });
    expect(cfg.adminPassword).toBe("secret-pw");
  });

  it("adminPassword is undefined when env var absent or empty", () => {
    const cfg = loadOAuthConfig({
      WALDO_PUBLIC_URL: "https://nas.example.ts.net",
    });
    expect(cfg.adminPassword).toBeUndefined();
    const cfg2 = loadOAuthConfig({
      WALDO_PUBLIC_URL: "https://nas.example.ts.net",
      WALDO_ADMIN_PASSWORD: "",
    });
    expect(cfg2.adminPassword).toBeUndefined();
  });

  it("rejects a non-https publicUrl unless host is localhost / 127.0.0.1", () => {
    expect(() =>
      loadOAuthConfig({ WALDO_PUBLIC_URL: "http://nas.example.ts.net" }),
    ).toThrow(OAuthConfigError);
  });

  it("accepts http://localhost and http://127.0.0.1 publicUrl", () => {
    const a = loadOAuthConfig({ WALDO_PUBLIC_URL: "http://localhost:8765" });
    expect(a.publicUrl).toBe("http://localhost:8765");
    const b = loadOAuthConfig({ WALDO_PUBLIC_URL: "http://127.0.0.1:8765" });
    expect(b.publicUrl).toBe("http://127.0.0.1:8765");
  });

  it("rejects a malformed publicUrl", () => {
    expect(() =>
      loadOAuthConfig({ WALDO_PUBLIC_URL: "not a url" }),
    ).toThrow(OAuthConfigError);
  });

  it("redirectAllowlist defaults to the claude.ai / claude.com callbacks", () => {
    const cfg = loadOAuthConfig({ WALDO_PUBLIC_URL: "https://nas.example.ts.net" });
    expect(cfg.redirectAllowlist).toEqual(DEFAULT_REDIRECT_ALLOWLIST);
  });

  it("WALDO_OAUTH_REDIRECT_ALLOWLIST replaces the default (comma-separated, trimmed)", () => {
    const cfg = loadOAuthConfig({
      WALDO_PUBLIC_URL: "https://nas.example.ts.net",
      WALDO_OAUTH_REDIRECT_ALLOWLIST:
        " https://a.example/cb , https://b.example/cb ,",
    });
    expect(cfg.redirectAllowlist).toEqual([
      "https://a.example/cb",
      "https://b.example/cb",
    ]);
  });

  it("rejects a non-https or malformed WALDO_OAUTH_REDIRECT_ALLOWLIST entry", () => {
    for (const bad of ["http://a.example/cb", "not a url", "https://u@a.example/cb"]) {
      expect(() =>
        loadOAuthConfig({
          WALDO_PUBLIC_URL: "https://nas.example.ts.net",
          WALDO_OAUTH_REDIRECT_ALLOWLIST: bad,
        }),
      ).toThrow(OAuthConfigError);
    }
  });

  it("rejects an allowlist entry carrying only a password", () => {
    expect(() =>
      loadOAuthConfig({
        WALDO_PUBLIC_URL: "https://nas.example.ts.net",
        WALDO_OAUTH_REDIRECT_ALLOWLIST: "https://:pw@a.example/cb",
      }),
    ).toThrow(OAuthConfigError);
  });

  it("maxClients defaults to 50", () => {
    expect(loadOAuthConfig({ WALDO_PUBLIC_URL: "https://nas.example.ts.net" }).maxClients).toBe(50);
  });

  it("WALDO_OAUTH_MAX_CLIENTS overrides maxClients and must be a positive integer", () => {
    expect(
      loadOAuthConfig({
        WALDO_PUBLIC_URL: "https://nas.example.ts.net",
        WALDO_OAUTH_MAX_CLIENTS: "7",
      }).maxClients,
    ).toBe(7);
    expect(
      loadOAuthConfig({
        WALDO_PUBLIC_URL: "https://nas.example.ts.net",
        WALDO_OAUTH_MAX_CLIENTS: "120",
      }).maxClients,
    ).toBe(120);
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      expect(() =>
        loadOAuthConfig({
          WALDO_PUBLIC_URL: "https://nas.example.ts.net",
          WALDO_OAUTH_MAX_CLIENTS: bad,
        }),
      ).toThrow(OAuthConfigError);
    }
  });

  it("maxGrantDays defaults to 180", () => {
    expect(loadOAuthConfig({ WALDO_PUBLIC_URL: "https://nas.example.ts.net" }).maxGrantDays).toBe(180);
  });

  it("WALDO_OAUTH_MAX_GRANT_DAYS overrides maxGrantDays and must be a positive integer", () => {
    expect(
      loadOAuthConfig({
        WALDO_PUBLIC_URL: "https://nas.example.ts.net",
        WALDO_OAUTH_MAX_GRANT_DAYS: "90",
      }).maxGrantDays,
    ).toBe(90);
    for (const bad of ["0", "x", "-3", "2.5"]) {
      expect(() =>
        loadOAuthConfig({
          WALDO_PUBLIC_URL: "https://nas.example.ts.net",
          WALDO_OAUTH_MAX_GRANT_DAYS: bad,
        }),
      ).toThrow(OAuthConfigError);
    }
  });
});

