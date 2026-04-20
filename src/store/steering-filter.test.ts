import { describe, expect, it } from "vitest";
import { buildSteeringPredicate } from "./steering-filter.js";
import type { Message, SteeringRule } from "./types.js";

const baseMsg = (overrides: Partial<Message> & Pick<Message, "id">): Message => ({
  source: "outlook",
  account: "a@example.test",
  nativeId: `native-${overrides.id}`,
  sentAt: new Date("2026-04-13T10:00:00Z"),
  importedAt: new Date("2026-04-13T10:05:00Z"),
  ...overrides,
});

const rule = (
  overrides: Partial<SteeringRule> & Pick<SteeringRule, "id" | "ruleType" | "pattern">,
): SteeringRule => ({
  enabled: true,
  createdAt: new Date("2026-04-20T00:00:00Z"),
  ...overrides,
});

describe("buildSteeringPredicate", () => {
  it("returns an empty predicate for no rules", () => {
    const p = buildSteeringPredicate([]);
    expect(p.sqlFragment).toBeNull();
    expect(p.params).toEqual([]);
    expect(p.matches(baseMsg({ id: "1", senderEmail: "any@x.com" }))).toBe(false);
  });

  it("ignores disabled rules", () => {
    const p = buildSteeringPredicate([
      rule({
        id: 1,
        ruleType: "sender_email",
        pattern: "foo@bar.com",
        enabled: false,
      }),
    ]);
    expect(p.sqlFragment).toBeNull();
    expect(p.matches(baseMsg({ id: "1", senderEmail: "foo@bar.com" }))).toBe(false);
  });

  it("sender_email matches case-insensitively", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "sender_email", pattern: "foo@bar.com" }),
    ]);
    expect(p.matches(baseMsg({ id: "1", senderEmail: "Foo@Bar.COM" }))).toBe(true);
    expect(p.matches(baseMsg({ id: "2", senderEmail: "other@bar.com" }))).toBe(false);
  });

  it("sender_domain matches only exact domain (not subdomains)", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "sender_domain", pattern: "bar.com" }),
    ]);
    expect(p.matches(baseMsg({ id: "1", senderEmail: "foo@bar.com" }))).toBe(true);
    expect(p.matches(baseMsg({ id: "2", senderEmail: "foo@sub.bar.com" }))).toBe(
      false,
    );
    expect(p.matches(baseMsg({ id: "3", senderEmail: "foo@other.com" }))).toBe(false);
  });

  it("thread_id matches exactly", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "thread_id", pattern: "chat-xyz" }),
    ]);
    expect(p.matches(baseMsg({ id: "1", threadId: "chat-xyz" }))).toBe(true);
    expect(p.matches(baseMsg({ id: "2", threadId: "chat-abc" }))).toBe(false);
  });

  it("thread_name_contains matches case-insensitive substring", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "thread_name_contains", pattern: "jira" }),
    ]);
    expect(p.matches(baseMsg({ id: "1", threadName: "[JIRA] bug 42" }))).toBe(
      true,
    );
    expect(p.matches(baseMsg({ id: "2", threadName: "release notes" }))).toBe(
      false,
    );
  });

  it("body_contains matches substring (JS fallback)", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "body_contains", pattern: "sync fail" }),
    ]);
    expect(p.matches(baseMsg({ id: "1", body: "the sync fail loop again" }))).toBe(
      true,
    );
    expect(p.matches(baseMsg({ id: "2", body: "everything healthy" }))).toBe(false);
  });

  it("rule source scope narrows the match", () => {
    const p = buildSteeringPredicate([
      rule({
        id: 1,
        ruleType: "sender_email",
        pattern: "foo@bar.com",
        source: "outlook",
      }),
    ]);
    expect(
      p.matches(baseMsg({ id: "1", source: "outlook", senderEmail: "foo@bar.com" })),
    ).toBe(true);
    expect(
      p.matches(baseMsg({ id: "2", source: "teams", senderEmail: "foo@bar.com" })),
    ).toBe(false);
  });

  it("rule account scope narrows the match", () => {
    const p = buildSteeringPredicate([
      rule({
        id: 1,
        ruleType: "sender_email",
        pattern: "foo@bar.com",
        account: "a@example.test",
      }),
    ]);
    expect(
      p.matches(
        baseMsg({
          id: "1",
          account: "a@example.test",
          senderEmail: "foo@bar.com",
        }),
      ),
    ).toBe(true);
    expect(
      p.matches(
        baseMsg({
          id: "2",
          account: "b@example.test",
          senderEmail: "foo@bar.com",
        }),
      ),
    ).toBe(false);
  });

  it("combines multiple rules with OR", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "sender_email", pattern: "foo@bar.com" }),
      rule({ id: 2, ruleType: "thread_id", pattern: "chat-xyz" }),
    ]);
    expect(p.matches(baseMsg({ id: "1", senderEmail: "foo@bar.com" }))).toBe(true);
    expect(p.matches(baseMsg({ id: "2", threadId: "chat-xyz" }))).toBe(true);
    expect(
      p.matches(
        baseMsg({ id: "3", senderEmail: "other@x.com", threadId: "chat-abc" }),
      ),
    ).toBe(false);
  });

  it("produces a sqlFragment and params for each enabled rule", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "sender_email", pattern: "foo@bar.com" }),
      rule({
        id: 2,
        ruleType: "sender_domain",
        pattern: "baz.com",
        source: "outlook",
      }),
    ]);
    expect(p.sqlFragment).toContain("LOWER(m.sender_email) = ?");
    expect(p.sqlFragment).toContain("LIKE");
    expect(p.params).toEqual(["foo@bar.com", "outlook", "%@baz.com"]);
  });
});
