import { describe, expect, it } from "vitest";
import { StoreError } from "./types.js";
import type { TeamsChannelSubscriptionStore } from "./teams-channel-subscription-store.js";

export type TeamsChannelSubscriptionStoreFactory = () =>
  | TeamsChannelSubscriptionStore
  | Promise<TeamsChannelSubscriptionStore>;

export function runTeamsChannelSubscriptionStoreContract(
  label: string,
  factory: TeamsChannelSubscriptionStoreFactory,
): void {
  describe(`TeamsChannelSubscriptionStore contract (${label})`, () => {
    it("subscribe stores a row enabled=true with subscribedAt and no cursor", async () => {
      const store = await factory();
      const sub = await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        channelId: "chan-1",
      });
      expect(sub.account).toBe("a@example.test");
      expect(sub.teamId).toBe("team-1");
      expect(sub.channelId).toBe("chan-1");
      expect(sub.enabled).toBe(true);
      expect(sub.subscribedAt).toBeInstanceOf(Date);
      expect(sub.teamName).toBeUndefined();
      expect(sub.channelName).toBeUndefined();
      expect(sub.lastCursorAt).toBeUndefined();
    });

    it("subscribe round-trips teamName and channelName", async () => {
      const store = await factory();
      const sub = await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        teamName: "Contoso R&D",
        channelId: "chan-1",
        channelName: "Announcements",
      });
      expect(sub.teamName).toBe("Contoso R&D");
      expect(sub.channelName).toBe("Announcements");
    });

    it("subscribe rejects empty account/teamId/channelId with StoreError", async () => {
      const store = await factory();
      await expect(
        store.subscribe({ account: "", teamId: "t", channelId: "c" }),
      ).rejects.toBeInstanceOf(StoreError);
      await expect(
        store.subscribe({
          account: "a@example.test",
          teamId: "",
          channelId: "c",
        }),
      ).rejects.toBeInstanceOf(StoreError);
      await expect(
        store.subscribe({
          account: "a@example.test",
          teamId: "t",
          channelId: "",
        }),
      ).rejects.toBeInstanceOf(StoreError);
    });

    it("subscribe rejects duplicate (account, teamId, channelId) with StoreError", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        channelId: "chan-1",
      });
      await expect(
        store.subscribe({
          account: "a@example.test",
          teamId: "team-1",
          channelId: "chan-1",
        }),
      ).rejects.toBeInstanceOf(StoreError);
    });

    it("subscribe allows the same channelId under different accounts", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        channelId: "chan-1",
      });
      await store.subscribe({
        account: "b@example.test",
        teamId: "team-1",
        channelId: "chan-1",
      });
      const a = await store.listForAccount("a@example.test");
      const b = await store.listForAccount("b@example.test");
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it("subscribe allows the same channelId across different teams for one account", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        channelId: "chan-shared",
      });
      await store.subscribe({
        account: "a@example.test",
        teamId: "team-2",
        channelId: "chan-shared",
      });
      const rows = await store.listForAccount("a@example.test");
      expect(rows).toHaveLength(2);
    });

    it("listForAccount returns [] for an unknown account", async () => {
      const store = await factory();
      expect(await store.listForAccount("nobody@example.test")).toEqual([]);
    });

    it("listForAccount returns rows ordered by subscribedAt ASC", async () => {
      const store = await factory();
      const s1 = await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        channelId: "chan-1",
      });
      const s2 = await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        channelId: "chan-2",
      });
      const rows = await store.listForAccount("a@example.test");
      expect(rows.map((r) => r.channelId)).toEqual([
        s1.channelId,
        s2.channelId,
      ]);
    });

    it("unsubscribe removes by (account, teamId, channelId) and reports removed=true; second call false", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        channelId: "chan-1",
      });
      expect(
        await store.unsubscribe("a@example.test", "team-1", "chan-1"),
      ).toEqual({
        removed: true,
      });
      expect(
        await store.unsubscribe("a@example.test", "team-1", "chan-1"),
      ).toEqual({
        removed: false,
      });
      expect(await store.listForAccount("a@example.test")).toEqual([]);
    });

    it("unsubscribe is scoped to the given account", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        channelId: "chan-1",
      });
      await store.subscribe({
        account: "b@example.test",
        teamId: "team-1",
        channelId: "chan-1",
      });
      expect(
        await store.unsubscribe("a@example.test", "team-1", "chan-1"),
      ).toEqual({
        removed: true,
      });
      expect(await store.listForAccount("b@example.test")).toHaveLength(1);
    });

    it("setCursor updates lastCursorAt and is read back via listForAccount", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        channelId: "chan-1",
      });
      await store.setCursor(
        "a@example.test",
        "team-1",
        "chan-1",
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
        "team-missing",
        "chan-missing",
        new Date("2026-04-21T10:00:00Z"),
      );
      expect(await store.listForAccount("a@example.test")).toEqual([]);
    });

    it("toggleEnabled flips the enabled flag and returns the updated row", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        channelId: "chan-1",
      });
      const disabled = await store.toggleEnabled(
        "a@example.test",
        "team-1",
        "chan-1",
        false,
      );
      expect(disabled?.enabled).toBe(false);
      const enabled = await store.toggleEnabled(
        "a@example.test",
        "team-1",
        "chan-1",
        true,
      );
      expect(enabled?.enabled).toBe(true);
    });

    it("toggleEnabled returns null for a missing subscription", async () => {
      const store = await factory();
      expect(
        await store.toggleEnabled(
          "a@example.test",
          "team-missing",
          "chan-missing",
          false,
        ),
      ).toBeNull();
    });

    it("listAll returns [] on an empty store", async () => {
      const store = await factory();
      expect(await store.listAll()).toEqual([]);
    });

    it("listAll returns every row across accounts, sorted (account ASC, teamId ASC, channelId ASC)", async () => {
      const store = await factory();
      await store.subscribe({
        account: "b@example.test",
        teamId: "team-1",
        channelId: "chan-2",
      });
      await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        channelId: "chan-2",
      });
      await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        channelId: "chan-1",
      });
      const rows = await store.listAll();
      expect(
        rows.map((r) => `${r.account}/${r.teamId}/${r.channelId}`),
      ).toEqual([
        "a@example.test/team-1/chan-1",
        "a@example.test/team-1/chan-2",
        "b@example.test/team-1/chan-2",
      ]);
    });

    it("listEnabledForAccount returns only enabled rows", async () => {
      const store = await factory();
      await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        channelId: "chan-1",
      });
      await store.subscribe({
        account: "a@example.test",
        teamId: "team-1",
        channelId: "chan-2",
      });
      await store.toggleEnabled(
        "a@example.test",
        "team-1",
        "chan-1",
        false,
      );
      const rows = await store.listEnabledForAccount("a@example.test");
      expect(rows.map((r) => r.channelId)).toEqual(["chan-2"]);
    });
  });
}
