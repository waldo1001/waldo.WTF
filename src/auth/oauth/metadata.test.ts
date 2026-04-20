import { describe, expect, it } from "vitest";
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from "./metadata.js";

describe("buildAuthorizationServerMetadata (RFC 8414)", () => {
  it("emits issuer + endpoints rooted at publicUrl", () => {
    const meta = buildAuthorizationServerMetadata("https://nas.example.ts.net");
    expect(meta.issuer).toBe("https://nas.example.ts.net");
    expect(meta.authorization_endpoint).toBe(
      "https://nas.example.ts.net/oauth/authorize",
    );
    expect(meta.token_endpoint).toBe("https://nas.example.ts.net/oauth/token");
    expect(meta.registration_endpoint).toBe(
      "https://nas.example.ts.net/oauth/register",
    );
  });

  it("declares S256 PKCE, public-client (none) auth, mcp scope", () => {
    const meta = buildAuthorizationServerMetadata("https://nas.example.ts.net");
    expect(meta.response_types_supported).toEqual(["code"]);
    expect(meta.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(meta.scopes_supported).toEqual(["mcp"]);
  });

  it("strips a trailing slash on publicUrl when joining endpoints", () => {
    const meta = buildAuthorizationServerMetadata(
      "https://nas.example.ts.net/",
    );
    expect(meta.issuer).toBe("https://nas.example.ts.net");
    expect(meta.authorization_endpoint).toBe(
      "https://nas.example.ts.net/oauth/authorize",
    );
  });
});

describe("buildProtectedResourceMetadata (RFC 9728)", () => {
  it("resource equals publicUrl with trailing slash stripped", () => {
    const meta = buildProtectedResourceMetadata("https://nas.example.ts.net/");
    expect(meta.resource).toBe("https://nas.example.ts.net");
  });

  it("authorization_servers contains publicUrl", () => {
    const meta = buildProtectedResourceMetadata("https://nas.example.ts.net");
    expect(meta.authorization_servers).toEqual([
      "https://nas.example.ts.net",
    ]);
  });

  it("bearer_methods_supported is ['header']", () => {
    const meta = buildProtectedResourceMetadata("https://nas.example.ts.net");
    expect(meta.bearer_methods_supported).toEqual(["header"]);
    expect(meta.scopes_supported).toEqual(["mcp"]);
  });
});
