import { describe, expect, it } from "vitest";
import { StoreError } from "./types.js";
import type { VivaSubscriptionStore } from "./viva-subscription-store.js";

export type VivaSubscriptionStoreFactory = () =>
  | VivaSubscriptionStore
  | Promise<VivaSubscriptionStore>;

export function runVivaSubscriptionStoreContract(
  label: string,
  factory: VivaSubscriptionStoreFactory,
): void {
  describe(`VivaSubscriptionStore contract (${label})`, () => {
    it("subscribe stores a row enabled=true with subscribedAt and no cursor", async () => {
      const store = await factory();
      const sub = await store.subscribe({
        account: "a@example.test",
        networkId: "net-1",
        communityId: "com-1",
      });
      expect(sub.account).toBe("a@example.test");
      expect(sub.networkId).toBe("net-1");
      expect(sub.communityId).toBe("com-1");
      expect(sub.enabled).toBe(true);
      expect(sub.subscribedAt).toBeInstanceOf(Date);
      expect(sub.networkName).toBeUndefined();
      expect(sub.communityName).toBeUndefined();
      expect(sub.lastCursorAt).toBeUndefined();
    });

    it("subscribe round-trips network/community names", async () => {
      const store = await factory();
      const sub = await store.subscribe({
        account: "a@example.test",
        networkId: "net-1",
        networkName: "Contoso",
        communityId: "com-1",
        communityName: "Engineering",
      });
      expect(sub.networkName).toBe("Contoso");
      expect(sub.communityName).toBe("Engineering");
    });

    it("subscribe rejects empty account/networkId/communityId with StoreError", async () => {
      const store = await factory();
      await expect(
        store.subscribe({ account: "", networkId: "n", communityId: "c" }),
      ).rejects.toBeInstanceOf(StoreError);
      await expect(
        store.subscribe({
          account: "a@example.test",
          networkId: "",
          communityId: "c",
        }),
      ).rejects.toBeInstanceOf(StoreError);
      await expect(
        store.subscribe({
          account: "a@example.test",
          networkId: "n",
          communityId: "",
        }),
      ).rejects.toBeInstanceOf(StoreError);
    });

    it("subscribe rejects duplicate (account, communityId) with StoreError", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        networkId: "net-1",
        communityId: "com-1",
      });
      await expect(
        store.subscribe({
          account: "a@example.test",
          networkId: "net-1",
          communityId: "com-1",
        }),
      ).rejects.toBeInstanceOf(StoreError);
    });

    it("subscribe allows the same communityId under different accounts", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        networkId: "net-1",
        communityId: "com-1",
      });
      await store.subscribe({
        account: "b@example.test",
        networkId: "net-1",
        communityId: "com-1",
      });
      const a = await store.listForAccount("a@example.test");
      const b = await store.listForAccount("b@example.test");
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it("listForAccount returns [] for an unknown account", async () => {
      const store = await factory();
      expect(await store.listForAccount("nobody@example.test")).toEqual([]);
    });

    it("listForAccount returns rows ordered by subscribedAt ASC", async () => {
      const store = await factory();
      const s1 = await store.subscribe({
        account: "a@example.test",
        networkId: "net-1",
        communityId: "com-1",
      });
      const s2 = await store.subscribe({
        account: "a@example.test",
        networkId: "net-1",
        communityId: "com-2",
      });
      const rows = await store.listForAccount("a@example.test");
      expect(rows.map((r) => r.communityId)).toEqual([
        s1.communityId,
        s2.communityId,
      ]);
    });

    it("unsubscribe removes by (account, communityId) and reports removed=true; second call false", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        networkId: "net-1",
        communityId: "com-1",
      });
      expect(await store.unsubscribe("a@example.test", "com-1")).toEqual({
        removed: true,
      });
      expect(await store.unsubscribe("a@example.test", "com-1")).toEqual({
        removed: false,
      });
      expect(await store.listForAccount("a@example.test")).toEqual([]);
    });

    it("unsubscribe is scoped to the given account", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        networkId: "net-1",
        communityId: "com-1",
      });
      await store.subscribe({
        account: "b@example.test",
        networkId: "net-1",
        communityId: "com-1",
      });
      expect(await store.unsubscribe("a@example.test", "com-1")).toEqual({
        removed: true,
      });
      expect(await store.listForAccount("b@example.test")).toHaveLength(1);
    });

    it("setCursor updates lastCursorAt and is read back via listForAccount", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        networkId: "net-1",
        communityId: "com-1",
      });
      await store.setCursor(
        "a@example.test",
        "com-1",
        new Date("2026-04-21T10:00:00Z"),
      );
      const [row] = await store.listForAccount("a@example.test");
      expect(row?.lastCursorAt?.toISOString()).toBe(
        "2026-04-21T10:00:00.000Z",
      );
    });

    it("setCursor on a missing subscription is a no-op (no throw, no row created)", async () => {
      const store = await factory();
      await store.setCursor(
        "a@example.test",
        "com-missing",
        new Date("2026-04-21T10:00:00Z"),
      );
      expect(await store.listForAccount("a@example.test")).toEqual([]);
    });

    it("toggleEnabled flips the enabled flag and returns the updated row", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        networkId: "net-1",
        communityId: "com-1",
      });
      const disabled = await store.toggleEnabled(
        "a@example.test",
        "com-1",
        false,
      );
      expect(disabled?.enabled).toBe(false);
      const enabled = await store.toggleEnabled(
        "a@example.test",
        "com-1",
        true,
      );
      expect(enabled?.enabled).toBe(true);
    });

    it("toggleEnabled returns null for a missing subscription", async () => {
      const store = await factory();
      expect(
        await store.toggleEnabled("a@example.test", "com-missing", false),
      ).toBeNull();
    });

    it("listEnabledForAccount returns only enabled rows", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        networkId: "net-1",
        communityId: "com-1",
      });
      await store.subscribe({
        account: "a@example.test",
        networkId: "net-1",
        communityId: "com-2",
      });
      await store.toggleEnabled("a@example.test", "com-1", false);
      const rows = await store.listEnabledForAccount("a@example.test");
      expect(rows.map((r) => r.communityId)).toEqual(["com-2"]);
    });
  });
}
