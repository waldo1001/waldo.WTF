import { describe, expect, it } from "vitest";
import { FakeClock } from "../../testing/fake-clock.js";
import { InMemoryMessageStore } from "../../testing/in-memory-message-store.js";
import {
  LIST_ACCOUNTS_TOOL,
  handleListAccounts,
} from "./list-accounts.js";

const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));

describe("LIST_ACCOUNTS_TOOL descriptor", () => {
  it("is named list_accounts with an empty-object inputSchema", () => {
    expect(LIST_ACCOUNTS_TOOL.name).toBe("list_accounts");
    expect(LIST_ACCOUNTS_TOOL.inputSchema.properties).toEqual({});
  });
});

describe("handleListAccounts", () => {
  it("returns empty on an empty store", async () => {
    const store = new InMemoryMessageStore();
    const result = await handleListAccounts(store, clock);
    expect(result).toEqual({ count: 0, accounts: [] });
  });

  it("projects username, displayName, addedAt — omits tenantId", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertAccount({
      username: "alice@example.test",
      displayName: "Alice",
      tenantId: "tenant-1",
      addedAt: new Date("2026-04-13T08:00:00Z"),
    });
    const result = await handleListAccounts(store, clock);
    expect(result.count).toBe(1);
    const acc = result.accounts[0]!;
    expect(acc.username).toBe("alice@example.test");
    expect(acc.displayName).toBe("Alice");
    expect(acc.addedAt).toBe("2026-04-13T08:00:00.000Z");
    expect((acc as unknown as { tenantId?: string }).tenantId).toBeUndefined();
  });

  it("omits displayName when not set on the record", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertAccount({
      username: "bob@example.test",
      addedAt: new Date("2026-04-13T09:00:00Z"),
    });
    const result = await handleListAccounts(store, clock);
    const acc = result.accounts[0]!;
    expect(acc.username).toBe("bob@example.test");
    expect(acc.displayName).toBeUndefined();
  });

  it("returns accounts in addedAt ASC order (delegated to store.listAccounts)", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertAccount({
      username: "c@example.test",
      addedAt: new Date("2026-04-13T10:00:00Z"),
    });
    await store.upsertAccount({
      username: "a@example.test",
      addedAt: new Date("2026-04-13T08:00:00Z"),
    });
    await store.upsertAccount({
      username: "b@example.test",
      addedAt: new Date("2026-04-13T09:00:00Z"),
    });
    const result = await handleListAccounts(store, clock);
    expect(result.accounts.map((a) => a.username)).toEqual([
      "a@example.test",
      "b@example.test",
      "c@example.test",
    ]);
  });
});
