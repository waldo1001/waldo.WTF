import { describe, it, expect } from "vitest";
import { InMemoryMessageStore } from "../../testing/in-memory-message-store.js";
import { FakeClock } from "../../testing/fake-clock.js";
import {
  handleGetSyncStatus,
  GET_SYNC_STATUS_TOOL,
  STALE_THRESHOLD_MS,
} from "./get-sync-status.js";

const clockAt = (iso: string): FakeClock => new FakeClock(new Date(iso));

describe("handleGetSyncStatus", () => {
  it("returns generatedAt from the clock in ISO", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = await handleGetSyncStatus(store, clock);
    expect(result.generatedAt).toBe("2026-04-13T12:00:00.000Z");
  });

  it("on an empty store returns zero rows with zero counts", async () => {
    const store = new InMemoryMessageStore();
    const clock = clockAt("2026-04-13T12:00:00Z");
    const result = await handleGetSyncStatus(store, clock);
    expect(result).toEqual({
      generatedAt: "2026-04-13T12:00:00.000Z",
      accountsTracked: 0,
      staleCount: 0,
      rows: [],
    });
  });

  it("sets stale=true when lastOkAt is older than the threshold", async () => {
    const store = new InMemoryMessageStore();
    const now = new Date("2026-04-13T12:00:00Z");
    // 16 minutes old — beyond the 15-minute threshold.
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 16 * 60 * 1000),
      account: "a@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 3,
    });
    const result = await handleGetSyncStatus(store, new FakeClock(now));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.stale).toBe(true);
    expect(result.staleCount).toBe(1);
  });

  it("sets stale=false when lastOkAt is within the threshold", async () => {
    const store = new InMemoryMessageStore();
    const now = new Date("2026-04-13T12:00:00Z");
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 5 * 60 * 1000),
      account: "a@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 1,
    });
    const result = await handleGetSyncStatus(store, new FakeClock(now));
    expect(result.rows[0]?.stale).toBe(false);
    expect(result.staleCount).toBe(0);
  });

  it("sets stale=true when there is no ok row at all", async () => {
    const store = new InMemoryMessageStore();
    const now = new Date("2026-04-13T12:00:00Z");
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 1 * 60 * 1000),
      account: "a@example.test",
      source: "outlook",
      status: "error",
      errorMessage: "graph 500",
    });
    const result = await handleGetSyncStatus(store, new FakeClock(now));
    expect(result.rows[0]?.stale).toBe(true);
    expect(result.rows[0]?.lastStatus).toBe("error");
    expect(result.rows[0]?.lastError).toBe("graph 500");
  });

  it("accountsTracked counts distinct accounts in rows", async () => {
    const store = new InMemoryMessageStore();
    const now = new Date("2026-04-13T12:00:00Z");
    const recent = new Date(now.getTime() - 60 * 1000);
    await store.appendSyncLog({
      ts: recent,
      account: "a@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 1,
    });
    await store.appendSyncLog({
      ts: recent,
      account: "a@example.test",
      source: "teams",
      status: "ok",
      messagesAdded: 1,
    });
    await store.appendSyncLog({
      ts: recent,
      account: "b@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 1,
    });
    const result = await handleGetSyncStatus(store, new FakeClock(now));
    expect(result.rows).toHaveLength(3);
    expect(result.accountsTracked).toBe(2);
  });

  it("serialises Date fields to ISO and omits undefined fields", async () => {
    const store = new InMemoryMessageStore();
    const now = new Date("2026-04-13T12:00:00Z");
    await store.setSyncState({
      account: "a@example.test",
      source: "outlook",
      deltaToken: "t",
      lastSyncAt: new Date("2026-04-13T11:55:00Z"),
    });
    await store.appendSyncLog({
      ts: new Date("2026-04-13T11:50:00Z"),
      account: "a@example.test",
      source: "outlook",
      status: "ok",
      messagesAdded: 9,
    });
    const result = await handleGetSyncStatus(store, new FakeClock(now));
    const row = result.rows[0];
    expect(row).toBeDefined();
    expect(row?.lastSyncAt).toBe("2026-04-13T11:55:00.000Z");
    expect(row?.lastOkAt).toBe("2026-04-13T11:50:00.000Z");
    expect(row?.lastStatus).toBe("ok");
    expect(row?.messagesAddedLastOk).toBe(9);
    expect(Object.keys(row ?? {})).not.toContain("lastError");
  });

  it("emits two rows (outlook + teams) for one account with mixed sources", async () => {
    const store = new InMemoryMessageStore();
    const now = new Date("2026-04-13T12:00:00Z");
    const account = "eric@example.test";
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 5 * 60 * 1000),
      account,
      source: "outlook",
      status: "ok",
      messagesAdded: 3,
    });
    await store.appendSyncLog({
      ts: new Date(now.getTime() - 3 * 60 * 1000),
      account,
      source: "teams",
      status: "ok",
      messagesAdded: 7,
    });
    const result = await handleGetSyncStatus(store, new FakeClock(now));
    expect(result.accountsTracked).toBe(1);
    expect(result.rows).toHaveLength(2);
    const outlook = result.rows.find((r) => r.source === "outlook");
    const teams = result.rows.find((r) => r.source === "teams");
    expect(outlook?.lastStatus).toBe("ok");
    expect(outlook?.messagesAddedLastOk).toBe(3);
    expect(teams?.lastStatus).toBe("ok");
    expect(teams?.messagesAddedLastOk).toBe(7);
    expect(result.staleCount).toBe(0);
  });

  it("exposes a no-param tool descriptor", () => {
    expect(GET_SYNC_STATUS_TOOL.name).toBe("get_sync_status");
    expect(GET_SYNC_STATUS_TOOL.inputSchema.type).toBe("object");
    expect(GET_SYNC_STATUS_TOOL.inputSchema.additionalProperties).toBe(false);
    expect(
      Object.keys(GET_SYNC_STATUS_TOOL.inputSchema.properties ?? {}),
    ).toEqual([]);
  });

  it("STALE_THRESHOLD_MS is 15 minutes", () => {
    expect(STALE_THRESHOLD_MS).toBe(15 * 60 * 1000);
  });
});
