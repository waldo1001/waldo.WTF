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

  it("AC-T1: sender_email rule does NOT mute a fromMe row", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "sender_email", pattern: "gunter@example.test" }),
    ]);
    // Inbound row from gunter: muted.
    expect(
      p.matches(
        baseMsg({ id: "inbound", senderEmail: "gunter@example.test" }),
      ),
    ).toBe(true);
    // User's own reply in the same thread, stored with sender=account: not muted.
    expect(
      p.matches(
        baseMsg({
          id: "reply",
          senderEmail: "a@example.test",
          fromMe: true,
        }),
      ),
    ).toBe(false);
    // And the SQL fragment constrains the clause to from_me = 0 so SQLite
    // filtering stays in lockstep with the in-memory predicate.
    expect(p.sqlFragment).toContain("m.from_me = 0");
  });

  it("AC-T2: sender_domain rule does NOT mute a fromMe row", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "sender_domain", pattern: "example.test" }),
    ]);
    expect(
      p.matches(baseMsg({ id: "in", senderEmail: "x@example.test" })),
    ).toBe(true);
    expect(
      p.matches(
        baseMsg({ id: "mine", senderEmail: "x@example.test", fromMe: true }),
      ),
    ).toBe(false);
  });

  it("AC-T3: body_contains rule does NOT mute a fromMe row", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "body_contains", pattern: "status update" }),
    ]);
    expect(
      p.matches(baseMsg({ id: "in", body: "here is your status update now" })),
    ).toBe(true);
    expect(
      p.matches(
        baseMsg({
          id: "mine",
          body: "sending the status update shortly",
          fromMe: true,
        }),
      ),
    ).toBe(false);
  });

  it("AC-T4: thread_id rule DOES mute a fromMe row (whole-thread intent)", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "thread_id", pattern: "conv-1" }),
    ]);
    expect(
      p.matches(baseMsg({ id: "in", threadId: "conv-1" })),
    ).toBe(true);
    expect(
      p.matches(baseMsg({ id: "mine", threadId: "conv-1", fromMe: true })),
    ).toBe(true);
    // thread_id clause has no from_me guard.
    expect(p.sqlFragment).not.toMatch(
      /m\.thread_id = \? AND m\.from_me = 0/,
    );
  });

  it("thread_name_contains still mutes fromMe rows (thread-level intent)", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "thread_name_contains", pattern: "jira" }),
    ]);
    expect(
      p.matches(baseMsg({ id: "in", threadName: "[JIRA] ticket" })),
    ).toBe(true);
    expect(
      p.matches(
        baseMsg({ id: "mine", threadName: "[JIRA] ticket", fromMe: true }),
      ),
    ).toBe(true);
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
