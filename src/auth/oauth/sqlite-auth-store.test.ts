import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../../store/schema.js";
import { runAuthStoreContract } from "./auth-store-contract.js";
import { SqliteAuthStore } from "./sqlite-auth-store.js";

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
});
