import { describe, expect, it } from "vitest";
import { StoreError } from "./types.js";
import type { CalendarAccountStore } from "./calendar-account-store.js";

export type CalendarAccountStoreFactory = () =>
  | CalendarAccountStore
  | Promise<CalendarAccountStore>;

export function runCalendarAccountStoreContract(
  label: string,
  factory: CalendarAccountStoreFactory,
): void {
  describe(`CalendarAccountStore contract (${label})`, () => {
    it("enable stores a row with transcriptsEnabled=false, enabledAt set, and tenantId omitted (not present as undefined) when not provided", async () => {
      const store = await factory();
      const row = await store.enable({ account: "a@example.test" });
      expect(row.account).toBe("a@example.test");
      expect(row.transcriptsEnabled).toBe(false);
      expect(row.tenantId).toBeUndefined();
      expect(row.enabledAt).toBeInstanceOf(Date);
      // toStrictEqual (unlike toEqual) distinguishes an omitted key from an
      // explicit `tenantId: undefined` — proves the conditional spread
      // actually omits the key rather than merely returning undefined.
      expect(row).toStrictEqual({
        account: "a@example.test",
        transcriptsEnabled: false,
        enabledAt: row.enabledAt,
      });
    });

    it("enable persists tenantId when provided", async () => {
      const store = await factory();
      const row = await store.enable({
        account: "a@example.test",
        tenantId: "tenant-1",
      });
      expect(row.tenantId).toBe("tenant-1");
    });

    it("enable rejects an empty or whitespace-only account with StoreError", async () => {
      const store = await factory();
      for (const account of ["", "   "]) {
        try {
          await store.enable({ account });
          expect.fail("expected throw");
        } catch (caught) {
          expect(caught).toBeInstanceOf(StoreError);
          expect((caught as StoreError).kind).toBe("conflict");
          expect((caught as StoreError).message).toContain("non-empty");
        }
      }
    });

    it("enable is idempotent — re-enabling an already-enabled account does not throw and updates tenantId", async () => {
      const store = await factory();
      await store.enable({ account: "a@example.test", tenantId: "tenant-1" });
      const second = await store.enable({
        account: "a@example.test",
        tenantId: "tenant-2",
      });
      expect(second.tenantId).toBe("tenant-2");
      const all = await store.listAll();
      expect(all).toHaveLength(1);
    });

    it("disable removes the row and reports removed=true", async () => {
      const store = await factory();
      await store.enable({ account: "a@example.test" });
      const result = await store.disable("a@example.test");
      expect(result).toEqual({ removed: true });
      expect(await store.isEnabled("a@example.test")).toBe(false);
    });

    it("disable on an account with no row reports removed=false", async () => {
      const store = await factory();
      const result = await store.disable("missing@example.test");
      expect(result).toEqual({ removed: false });
    });

    it("isEnabled reflects enable/disable state", async () => {
      const store = await factory();
      expect(await store.isEnabled("a@example.test")).toBe(false);
      await store.enable({ account: "a@example.test" });
      expect(await store.isEnabled("a@example.test")).toBe(true);
      await store.disable("a@example.test");
      expect(await store.isEnabled("a@example.test")).toBe(false);
    });

    it("setTranscriptsEnabled toggles the flag and returns the updated row", async () => {
      const store = await factory();
      await store.enable({ account: "a@example.test" });
      const enabled = await store.setTranscriptsEnabled("a@example.test", true);
      expect(enabled?.transcriptsEnabled).toBe(true);
      const disabled = await store.setTranscriptsEnabled("a@example.test", false);
      expect(disabled?.transcriptsEnabled).toBe(false);
    });

    it("setTranscriptsEnabled on an account with no calendar row returns null", async () => {
      const store = await factory();
      const result = await store.setTranscriptsEnabled(
        "missing@example.test",
        true,
      );
      expect(result).toBeNull();
    });

    it("isTranscriptsEnabled reflects the flag independently of calendar isEnabled", async () => {
      const store = await factory();
      expect(await store.isTranscriptsEnabled("a@example.test")).toBe(false);
      await store.enable({ account: "a@example.test" });
      // Calendar-enabled but transcripts not yet turned on.
      expect(await store.isEnabled("a@example.test")).toBe(true);
      expect(await store.isTranscriptsEnabled("a@example.test")).toBe(false);
      await store.setTranscriptsEnabled("a@example.test", true);
      expect(await store.isTranscriptsEnabled("a@example.test")).toBe(true);
      await store.setTranscriptsEnabled("a@example.test", false);
      expect(await store.isTranscriptsEnabled("a@example.test")).toBe(false);
    });

    it("isTranscriptsEnabled is false for an account with no calendar row at all", async () => {
      const store = await factory();
      expect(await store.isTranscriptsEnabled("never-seen@example.test")).toBe(
        false,
      );
    });

    it("listEnabled returns only accounts currently enabled, sorted by account", async () => {
      const store = await factory();
      await store.enable({ account: "b@example.test" });
      await store.enable({ account: "a@example.test" });
      await store.disable("b@example.test");
      const rows = await store.listEnabled();
      expect(rows.map((r) => r.account)).toEqual(["a@example.test"]);
    });

    it("listAll returns every enabled account, sorted, and [] when empty", async () => {
      const store = await factory();
      expect(await store.listAll()).toEqual([]);
      await store.enable({ account: "b@example.test" });
      await store.enable({ account: "a@example.test" });
      const rows = await store.listAll();
      expect(rows.map((r) => r.account)).toEqual([
        "a@example.test",
        "b@example.test",
      ]);
    });
  });
}
