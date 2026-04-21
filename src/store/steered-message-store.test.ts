import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { InMemorySteeringStore } from "../testing/in-memory-steering-store.js";
import type { MessageStore } from "./message-store.js";
import { SqliteMessageStore } from "./sqlite-message-store.js";
import { SqliteSteeringStore, type SteeringStore } from "./steering-store.js";
import type { Message } from "./types.js";

function msg(overrides: Partial<Message> & Pick<Message, "id">): Message {
  return {
    source: "outlook",
    account: "a@example.test",
    nativeId: `native-${overrides.id}`,
    sentAt: new Date("2026-04-20T10:00:00Z"),
    importedAt: new Date("2026-04-20T10:05:00Z"),
    ...overrides,
  };
}

interface Harness {
  store: MessageStore;
  steering: SteeringStore;
}

type Factory = (label: string) => Harness;

const sqliteFactory: Factory = () => {
  const db = new Database(":memory:");
  const steering = new SqliteSteeringStore(db);
  const store = new SqliteMessageStore(db, steering);
  return { store, steering };
};

const inMemoryFactory: Factory = () => {
  const steering = new InMemorySteeringStore();
  const store = new InMemoryMessageStore({ steeringStore: steering });
  return { store, steering };
};

for (const [label, factory] of [
  ["Sqlite", sqliteFactory] as const,
  ["InMemory", inMemoryFactory] as const,
]) {
  describe(`${label}MessageStore — steering filter`, () => {
    const since = new Date("2026-04-01T00:00:00Z");

    it("excludes messages matching a sender_email rule by default", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({ id: "muted", senderEmail: "noisy@bar.com", body: "hi" }),
        msg({ id: "keep", senderEmail: "alice@ex.test", body: "hi" }),
      ]);
      await steering.addRule({
        ruleType: "sender_email",
        pattern: "noisy@bar.com",
      });
      const got = await store.getRecentMessages({ since, limit: 50 });
      expect(got.messages.map((m) => m.id).sort()).toEqual(["keep"]);
      expect(got.mutedCount).toBe(1);
    });

    it("excludes messages matching a sender_domain rule (exact-domain match only)", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({ id: "m1", senderEmail: "a@bar.com", body: "x" }),
        msg({ id: "m2", senderEmail: "a@sub.bar.com", body: "x" }),
        msg({ id: "m3", senderEmail: "a@other.com", body: "x" }),
      ]);
      await steering.addRule({ ruleType: "sender_domain", pattern: "bar.com" });
      const got = await store.getRecentMessages({ since, limit: 50 });
      expect(got.messages.map((m) => m.id).sort()).toEqual(["m2", "m3"]);
      expect(got.mutedCount).toBe(1);
    });

    it("excludes messages matching a thread_id rule", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({ id: "m1", threadId: "chat-xyz", body: "x" }),
        msg({ id: "m2", threadId: "chat-abc", body: "x" }),
      ]);
      await steering.addRule({ ruleType: "thread_id", pattern: "chat-xyz" });
      const got = await store.getRecentMessages({ since, limit: 50 });
      expect(got.messages.map((m) => m.id)).toEqual(["m2"]);
      expect(got.mutedCount).toBe(1);
    });

    it("excludes thread_name_contains case-insensitively", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({ id: "m1", threadName: "[JIRA] bug 42", body: "x" }),
        msg({ id: "m2", threadName: "Release notes", body: "x" }),
      ]);
      await steering.addRule({
        ruleType: "thread_name_contains",
        pattern: "jira",
      });
      const got = await store.getRecentMessages({ since, limit: 50 });
      expect(got.messages.map((m) => m.id)).toEqual(["m2"]);
      expect(got.mutedCount).toBe(1);
    });

    it("excludes body_contains matches (single word and two-word phrase)", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({ id: "m1", body: "the sync fail loop again" }),
        msg({ id: "m2", body: "everything healthy" }),
        msg({ id: "m3", body: "kangaroo plain" }),
      ]);
      await steering.addRule({ ruleType: "body_contains", pattern: "sync fail" });
      await steering.addRule({ ruleType: "body_contains", pattern: "kangaroo" });
      const got = await store.getRecentMessages({ since, limit: 50 });
      expect(got.messages.map((m) => m.id)).toEqual(["m2"]);
      expect(got.mutedCount).toBe(2);
    });

    it("honours per-rule source scope", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({ id: "m1", source: "outlook", senderEmail: "n@x.com" }),
        msg({ id: "m2", source: "teams", senderEmail: "n@x.com" }),
      ]);
      await steering.addRule({
        ruleType: "sender_email",
        pattern: "n@x.com",
        source: "outlook",
      });
      const got = await store.getRecentMessages({ since, limit: 50 });
      expect(got.messages.map((m) => m.id)).toEqual(["m2"]);
      expect(got.mutedCount).toBe(1);
    });

    it("honours per-rule account scope", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({ id: "m1", account: "a@example.test", senderEmail: "n@x.com" }),
        msg({ id: "m2", account: "b@example.test", senderEmail: "n@x.com" }),
      ]);
      await steering.addRule({
        ruleType: "sender_email",
        pattern: "n@x.com",
        account: "a@example.test",
      });
      const got = await store.getRecentMessages({ since, limit: 50 });
      expect(got.messages.map((m) => m.id)).toEqual(["m2"]);
      expect(got.mutedCount).toBe(1);
    });

    it("includeMuted=true returns all and mutedCount=0", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({ id: "m1", senderEmail: "noisy@bar.com" }),
        msg({ id: "m2", senderEmail: "alice@ex.test" }),
      ]);
      await steering.addRule({
        ruleType: "sender_email",
        pattern: "noisy@bar.com",
      });
      const got = await store.getRecentMessages({
        since,
        limit: 50,
        includeMuted: true,
      });
      expect(got.messages.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
      expect(got.mutedCount).toBe(0);
    });

    it("ignores disabled rules", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({ id: "m1", senderEmail: "noisy@bar.com" }),
      ]);
      const rule = await steering.addRule({
        ruleType: "sender_email",
        pattern: "noisy@bar.com",
      });
      await steering.setEnabled(rule.id, false);
      const got = await store.getRecentMessages({ since, limit: 50 });
      expect(got.messages.map((m) => m.id)).toEqual(["m1"]);
      expect(got.mutedCount).toBe(0);
    });

    it("searchMessages excludes muted hits and reports mutedCount", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({ id: "m1", body: "kangaroo one", senderEmail: "noisy@bar.com" }),
        msg({ id: "m2", body: "kangaroo two", senderEmail: "alice@ex.test" }),
      ]);
      await steering.addRule({
        ruleType: "sender_email",
        pattern: "noisy@bar.com",
      });
      const res = await store.searchMessages("kangaroo", 10);
      expect(res.hits.map((h) => h.message.id)).toEqual(["m2"]);
      expect(res.mutedCount).toBe(1);
    });

    it("searchMessages with includeMuted=true returns all", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({ id: "m1", body: "kangaroo one", senderEmail: "noisy@bar.com" }),
        msg({ id: "m2", body: "kangaroo two", senderEmail: "alice@ex.test" }),
      ]);
      await steering.addRule({
        ruleType: "sender_email",
        pattern: "noisy@bar.com",
      });
      const res = await store.searchMessages("kangaroo", 10, {
        includeMuted: true,
      });
      expect(res.hits.map((h) => h.message.id).sort()).toEqual(["m1", "m2"]);
      expect(res.mutedCount).toBe(0);
    });

    it("keeps messages with null sender_email when a sender_email rule is active", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({
          id: "wa1",
          source: "whatsapp",
          account: "whatsapp-local",
          senderName: "~ Someone",
          body: "hello from whatsapp",
        }),
        msg({
          id: "ol1",
          source: "outlook",
          senderEmail: "alice@ex.test",
          body: "hello from outlook",
        }),
      ]);
      await steering.addRule({
        ruleType: "sender_email",
        pattern: "noisy@bar.com",
      });
      const got = await store.getRecentMessages({ since, limit: 50 });
      expect(got.messages.map((m) => m.id).sort()).toEqual(["ol1", "wa1"]);
    });

    it("reports mutedCount 0 when no messages match an active sender_email rule", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({
          id: "wa1",
          source: "whatsapp",
          account: "whatsapp-local",
          senderName: "~ Someone",
          body: "hello from whatsapp",
        }),
      ]);
      await steering.addRule({
        ruleType: "sender_email",
        pattern: "noisy@bar.com",
      });
      const got = await store.getRecentMessages({ since, limit: 50 });
      expect(got.mutedCount).toBe(0);
    });

    it("searchMessages keeps null-sender_email hits when a sender_email rule is active", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({
          id: "wa1",
          source: "whatsapp",
          account: "whatsapp-local",
          senderName: "~ Someone",
          body: "kangaroo on the beach",
        }),
      ]);
      await steering.addRule({
        ruleType: "sender_email",
        pattern: "noisy@bar.com",
      });
      const res = await store.searchMessages("kangaroo", 10);
      expect(res.hits.map((h) => h.message.id)).toEqual(["wa1"]);
      expect(res.mutedCount).toBe(0);
    });

    it("getThread is unaffected by steering rules", async () => {
      const { store, steering } = factory(label);
      await store.upsertMessages([
        msg({
          id: "m1",
          threadId: "chat-1",
          senderEmail: "noisy@bar.com",
          body: "one",
        }),
        msg({
          id: "m2",
          threadId: "chat-1",
          senderEmail: "alice@ex.test",
          body: "two",
        }),
      ]);
      await steering.addRule({
        ruleType: "sender_email",
        pattern: "noisy@bar.com",
      });
      const rows = await store.getThread({ threadId: "chat-1" });
      expect(rows.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
    });
  });
}
