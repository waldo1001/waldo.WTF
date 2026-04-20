import { describe, expect, it } from "vitest";
import { StoreError } from "./types.js";
import type { SteeringStore } from "./steering-store.js";

export type SteeringStoreFactory = () => SteeringStore | Promise<SteeringStore>;

export function runSteeringStoreContract(
  label: string,
  factory: SteeringStoreFactory,
): void {
  describe(`SteeringStore contract (${label})`, () => {
    it("addRule stores a sender_email rule with enabled=true and a numeric id", async () => {
      const store = await factory();
      const rule = await store.addRule({
        ruleType: "sender_email",
        pattern: "foo@bar.com",
      });
      expect(typeof rule.id).toBe("number");
      expect(rule.enabled).toBe(true);
      expect(rule.ruleType).toBe("sender_email");
      expect(rule.pattern).toBe("foo@bar.com");
      expect(rule.source).toBeUndefined();
      expect(rule.account).toBeUndefined();
      expect(rule.reason).toBeUndefined();
      expect(rule.createdAt).toBeInstanceOf(Date);
    });

    it("addRule normalizes pattern to lowercase for sender_email", async () => {
      const store = await factory();
      const rule = await store.addRule({
        ruleType: "sender_email",
        pattern: "Foo@Bar.COM",
      });
      expect(rule.pattern).toBe("foo@bar.com");
    });

    it("addRule normalizes pattern to lowercase for sender_domain", async () => {
      const store = await factory();
      const rule = await store.addRule({
        ruleType: "sender_domain",
        pattern: "Marketing.Example.COM",
      });
      expect(rule.pattern).toBe("marketing.example.com");
    });

    it("addRule preserves thread_id pattern case (ids are opaque)", async () => {
      const store = await factory();
      const rule = await store.addRule({
        ruleType: "thread_id",
        pattern: "ChAt-1/AbC",
      });
      expect(rule.pattern).toBe("ChAt-1/AbC");
    });

    it("addRule rejects unknown rule_type", async () => {
      const store = await factory();
      await expect(
        store.addRule({
          // Simulating an invalid client call.
          ruleType: "not_a_type" as never,
          pattern: "foo",
        }),
      ).rejects.toBeInstanceOf(StoreError);
    });

    it("addRule rejects empty pattern", async () => {
      const store = await factory();
      await expect(
        store.addRule({ ruleType: "sender_email", pattern: "   " }),
      ).rejects.toBeInstanceOf(StoreError);
    });

    it("addRule rejects sender_domain pattern containing '@'", async () => {
      const store = await factory();
      await expect(
        store.addRule({ ruleType: "sender_domain", pattern: "foo@bar.com" }),
      ).rejects.toBeInstanceOf(StoreError);
    });

    it("addRule dedupes on (ruleType, pattern, source, account)", async () => {
      const store = await factory();
      await store.addRule({
        ruleType: "sender_email",
        pattern: "foo@bar.com",
      });
      await expect(
        store.addRule({
          ruleType: "sender_email",
          pattern: "Foo@Bar.com",
        }),
      ).rejects.toBeInstanceOf(StoreError);
    });

    it("addRule allows same (type, pattern) under different scopes", async () => {
      const store = await factory();
      await store.addRule({
        ruleType: "sender_email",
        pattern: "foo@bar.com",
      });
      await store.addRule({
        ruleType: "sender_email",
        pattern: "foo@bar.com",
        source: "outlook",
      });
      await store.addRule({
        ruleType: "sender_email",
        pattern: "foo@bar.com",
        account: "a@example.test",
      });
      const rules = await store.listRules();
      expect(rules).toHaveLength(3);
    });

    it("addRule round-trips optional scope and reason", async () => {
      const store = await factory();
      const rule = await store.addRule({
        ruleType: "sender_domain",
        pattern: "newsletters.example.com",
        source: "outlook",
        account: "a@example.test",
        reason: "newsletters",
      });
      expect(rule.source).toBe("outlook");
      expect(rule.account).toBe("a@example.test");
      expect(rule.reason).toBe("newsletters");
    });

    it("listRules returns [] on an empty store", async () => {
      const store = await factory();
      expect(await store.listRules()).toEqual([]);
    });

    it("listRules returns enabled + disabled rules ordered by createdAt ASC", async () => {
      const store = await factory();
      const r1 = await store.addRule({
        ruleType: "sender_email",
        pattern: "a@x.com",
      });
      const r2 = await store.addRule({
        ruleType: "sender_email",
        pattern: "b@x.com",
      });
      await store.setEnabled(r1.id, false);
      const rules = await store.listRules();
      expect(rules.map((r) => r.id)).toEqual([r1.id, r2.id]);
      expect(rules[0]?.enabled).toBe(false);
      expect(rules[1]?.enabled).toBe(true);
    });

    it("setEnabled toggles the enabled flag and returns the updated rule", async () => {
      const store = await factory();
      const r = await store.addRule({
        ruleType: "sender_email",
        pattern: "a@x.com",
      });
      const disabled = await store.setEnabled(r.id, false);
      expect(disabled?.enabled).toBe(false);
      const enabled = await store.setEnabled(r.id, true);
      expect(enabled?.enabled).toBe(true);
    });

    it("setEnabled returns null for an unknown id", async () => {
      const store = await factory();
      expect(await store.setEnabled(99999, false)).toBeNull();
    });

    it("removeRule deletes and returns {removed: true}; unknown id returns {removed: false}", async () => {
      const store = await factory();
      const r = await store.addRule({
        ruleType: "sender_email",
        pattern: "a@x.com",
      });
      expect(await store.removeRule(r.id)).toEqual({ removed: true });
      expect(await store.removeRule(r.id)).toEqual({ removed: false });
      expect(await store.listRules()).toEqual([]);
    });
  });
}
