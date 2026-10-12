import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../../store/schema.js";
import { runAuthStoreContract } from "./auth-store-contract.js";
import { SqliteAuthStore } from "./sqlite-auth-store.js";
import { hashToken } from "./token-hash.js";

runAuthStoreContract("SqliteAuthStore", () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  return new SqliteAuthStore(db);
});

describe("SqliteAuthStore (impl-specific)", () => {
  it("rethrows non-duplicate sqlite errors verbatim", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new SqliteAuthStore(db);
    db.close();
    await expect(
      store.registerClient({
        clientId: "x",
        redirectUris: ["https://claude.ai/cb"],
        createdAt: new Date(0),
      }),
    ).rejects.toThrow(/database/i);
  });

  it("stores only hashes of access tokens, refresh tokens and auth codes", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new SqliteAuthStore(db);
    const now = new Date("2026-04-20T10:00:00Z");
    const later = new Date("2026-05-20T10:00:00Z");
    await store.registerClient({ clientId: "c1", redirectUris: [], createdAt: now });
    await store.saveTokenPair({
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
      clientId: "c1",
      scope: "mcp",
      accessExpiresAt: later,
      refreshExpiresAt: later,
      createdAt: now,
      grantCreatedAt: now,
    });
    await store.saveAuthCode({
      code: "secret-code",
      clientId: "c1",
      redirectUri: "x",
      scope: "mcp",
      codeChallenge: "ch",
      expiresAt: later,
      createdAt: now,
    });
    const dump = JSON.stringify([
      db.prepare("SELECT * FROM oauth_access_tokens").all(),
      db.prepare("SELECT * FROM oauth_auth_codes").all(),
    ]);
    expect(dump).not.toContain("secret-");
    expect(dump).toContain(hashToken("secret-access"));
    expect(dump).toContain(hashToken("secret-refresh"));
    expect(dump).toContain(hashToken("secret-code"));
    // ...and the plaintext still works for lookup / consumption.
    expect(await store.getAccessToken("secret-access", now)).toBeDefined();
    const consumed = await store.consumeAuthCode("secret-code", now);
    expect(consumed?.code).toBe("secret-code");
  });
});

