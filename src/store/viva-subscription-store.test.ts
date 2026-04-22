import Database from "better-sqlite3";
import { FakeClock } from "../testing/fake-clock.js";
import { InMemoryVivaSubscriptionStore } from "../testing/in-memory-viva-subscription-store.js";
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
