import Database from "better-sqlite3";
import { describe, it } from "vitest";
import { FakeClock } from "../testing/fake-clock.js";
import { InMemoryCalendarAccountStore } from "../testing/in-memory-calendar-account-store.js";
import { SqliteCalendarAccountStore } from "./calendar-account-store.js";
import { runCalendarAccountStoreContract } from "./calendar-account-store-contract.js";

function tickingClock(startIso: string) {
  const clock = new FakeClock(new Date(startIso));
  return {
    now: () => {
      const d = clock.now();
      clock.advance(1);
      return d;
    },
  };
}

runCalendarAccountStoreContract("SqliteCalendarAccountStore", () => {
  const db = new Database(":memory:");
  return new SqliteCalendarAccountStore(db, tickingClock("2026-08-12T12:00:00Z"));
});

runCalendarAccountStoreContract("InMemoryCalendarAccountStore", () => {
  return new InMemoryCalendarAccountStore(tickingClock("2026-08-12T12:00:00Z"));
});

describe("SqliteCalendarAccountStore", () => {
  it("re-applying migrations on an existing db is a no-op (constructor is idempotent)", () => {
    const db = new Database(":memory:");
    new SqliteCalendarAccountStore(db);
    new SqliteCalendarAccountStore(db);
  });
});
