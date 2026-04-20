import Database from "better-sqlite3";
import { FakeClock } from "../testing/fake-clock.js";
import { InMemorySteeringStore } from "../testing/in-memory-steering-store.js";
import { runSteeringStoreContract } from "./steering-store-contract.js";
import { SqliteSteeringStore } from "./steering-store.js";

runSteeringStoreContract("SqliteSteeringStore", () => {
  const db = new Database(":memory:");
  const clock = new FakeClock(new Date("2026-04-20T12:00:00Z"));
  const tickClock = {
    now: () => {
      const d = clock.now();
      clock.advance(1);
      return d;
    },
  };
  return new SqliteSteeringStore(db, tickClock);
});

runSteeringStoreContract("InMemorySteeringStore", () => {
  const clock = new FakeClock(new Date("2026-04-20T12:00:00Z"));
  const tickClock = {
    now: () => {
      const d = clock.now();
      clock.advance(1);
      return d;
    },
  };
  return new InMemorySteeringStore(tickClock);
});
