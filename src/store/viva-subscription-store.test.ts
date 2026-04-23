import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { FakeClock } from "../testing/fake-clock.js";
import { InMemoryVivaSubscriptionStore } from "../testing/in-memory-viva-subscription-store.js";
import { applyMigrations } from "./schema.js";
import { runVivaSubscriptionStoreContract } from "./viva-subscription-store-contract.js";
import { SqliteVivaSubscriptionStore } from "./viva-subscription-store.js";

runVivaSubscriptionStoreContract("SqliteVivaSubscriptionStore", () => {
  const db = new Database(":memory:");
  const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
  const tickClock = {
    now: () => {
      const d = clock.now();
      clock.advance(1);
      return d;
    },
  };
  return new SqliteVivaSubscriptionStore(db, tickClock);
});

runVivaSubscriptionStoreContract("InMemoryVivaSubscriptionStore", () => {
  const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
  const tickClock = {
    now: () => {
      const d = clock.now();
      clock.advance(1);
      return d;
    },
  };
  return new InMemoryVivaSubscriptionStore(tickClock);
});

describe("viva_subscriptions schema migration v13", () => {
  it("adds a nullable tenant_id column", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(db);
      const cols = db
        .prepare("PRAGMA table_info(viva_subscriptions)")
        .all() as { name: string; notnull: number }[];
      const tc = cols.find((c) => c.name === "tenant_id");
      expect(tc).toBeDefined();
      expect(tc?.notnull).toBe(0);
      const ver = db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      expect(ver.user_version).toBeGreaterThanOrEqual(13);
    } finally {
      db.close();
    }
  });

  it("preserves pre-v13 rows with tenant_id = NULL", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE viva_subscriptions (
          account TEXT NOT NULL,
          network_id TEXT NOT NULL,
          network_name TEXT,
          community_id TEXT NOT NULL,
          community_name TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          subscribed_at INTEGER NOT NULL,
          last_cursor_at INTEGER,
          PRIMARY KEY (account, community_id)
        );
      `);
      db.exec(
        `INSERT INTO viva_subscriptions (account, network_id, community_id, subscribed_at)
         VALUES ('a@example.test', 'net-1', 'com-1', 0)`,
      );
      db.exec("PRAGMA user_version = 12");
      applyMigrations(db);
      const row = db
        .prepare(
          "SELECT tenant_id FROM viva_subscriptions WHERE community_id='com-1'",
        )
        .get() as { tenant_id: unknown };
      expect(row.tenant_id).toBeNull();
    } finally {
      db.close();
    }
  });
});
