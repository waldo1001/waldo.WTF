import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { FakeClock } from "../testing/fake-clock.js";
import { InMemoryTeamsChannelSubscriptionStore } from "../testing/in-memory-teams-channel-subscription-store.js";
import { applyMigrations } from "./schema.js";
import { runTeamsChannelSubscriptionStoreContract } from "./teams-channel-subscription-store-contract.js";
import { SqliteTeamsChannelSubscriptionStore } from "./teams-channel-subscription-store.js";
import type { MessageSource } from "./types.js";

runTeamsChannelSubscriptionStoreContract(
  "SqliteTeamsChannelSubscriptionStore",
  () => {
    const db = new Database(":memory:");
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const tickClock = {
      now: () => {
        const d = clock.now();
        clock.advance(1);
        return d;
      },
    };
    return new SqliteTeamsChannelSubscriptionStore(db, tickClock);
  },
);

runTeamsChannelSubscriptionStoreContract(
  "InMemoryTeamsChannelSubscriptionStore",
  () => {
    const clock = new FakeClock(new Date("2026-04-21T12:00:00Z"));
    const tickClock = {
      now: () => {
        const d = clock.now();
        clock.advance(1);
        return d;
      },
    };
    return new InMemoryTeamsChannelSubscriptionStore(tickClock);
  },
);

describe("teams_channel_subscriptions schema migration v14", () => {
  it("adds teams_channel_subscriptions table with expected columns", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(db);
      const cols = db
        .prepare("PRAGMA table_info(teams_channel_subscriptions)")
        .all() as { name: string }[];
      const names = cols.map((c) => c.name).sort();
      expect(names).toEqual(
        [
          "account",
          "channel_id",
          "channel_name",
          "enabled",
          "last_cursor_at",
          "subscribed_at",
          "team_id",
          "team_name",
        ].sort(),
      );
    } finally {
      db.close();
    }
  });

  it("creates account+enabled index for scheduler skip-if-empty queries", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(db);
      const idx = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tcs_account_enabled'",
        )
        .get() as { name: string } | undefined;
      expect(idx?.name).toBe("idx_tcs_account_enabled");
    } finally {
      db.close();
    }
  });

  it("bumps user_version to 14", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(db);
      const ver = db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      expect(ver.user_version).toBeGreaterThanOrEqual(14);
    } finally {
      db.close();
    }
  });

  it("preserves pre-v14 rows in sibling tables (viva_subscriptions)", () => {
    const db = new Database(":memory:");
    try {
      // simulate v13 by applying everything, then write a row, drop the
      // teams_channel_subscriptions table, set user_version back to 13,
      // and re-run applyMigrations. The migration must only add the new
      // table without disturbing existing data.
      applyMigrations(db);
      db.exec(
        `INSERT INTO viva_subscriptions
           (account, network_id, community_id, subscribed_at)
         VALUES ('a@example.test', 'net-1', 'com-1', 0)`,
      );
      db.exec("DROP TABLE teams_channel_subscriptions");
      db.exec("PRAGMA user_version = 13");
      applyMigrations(db);
      const row = db
        .prepare(
          "SELECT community_id FROM viva_subscriptions WHERE account='a@example.test'",
        )
        .get() as { community_id: string } | undefined;
      expect(row?.community_id).toBe("com-1");
      const tab = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='teams_channel_subscriptions'",
        )
        .get();
      expect(tab).toBeDefined();
    } finally {
      db.close();
    }
  });
});

describe("MessageSource", () => {
  it("accepts 'teams-channel' as a literal", () => {
    const s: MessageSource = "teams-channel";
    expect(s).toBe("teams-channel");
  });
});
