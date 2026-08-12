import { describe, expect, it } from "vitest";
import { buildSteeringPredicate } from "./steering-filter.js";
import type { CalendarEvent, Message, SteeringRule } from "./types.js";

const baseMsg = (overrides: Partial<Message> & Pick<Message, "id">): Message => ({
  source: "outlook",
  account: "a@example.test",
  nativeId: `native-${overrides.id}`,
  sentAt: new Date("2026-04-13T10:00:00Z"),
  importedAt: new Date("2026-04-13T10:05:00Z"),
  ...overrides,
});

const baseEvent = (
  overrides: Partial<CalendarEvent> & { eventId: string },
): CalendarEvent => ({
  account: "a@example.test",
  startAt: new Date("2026-04-13T10:00:00Z"),
  endAt: new Date("2026-04-13T11:00:00Z"),
  isAllDay: false,
  isCancelled: false,
  attendees: [],
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
    const p = buildSteeringPredicate([], "message");
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
    ], "message");
    expect(p.sqlFragment).toBeNull();
    expect(p.matches(baseMsg({ id: "1", senderEmail: "foo@bar.com" }))).toBe(false);
  });

  it("sender_email matches case-insensitively", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "sender_email", pattern: "foo@bar.com" }),
    ], "message");
    expect(p.matches(baseMsg({ id: "1", senderEmail: "Foo@Bar.COM" }))).toBe(true);
    expect(p.matches(baseMsg({ id: "2", senderEmail: "other@bar.com" }))).toBe(false);
  });

  it("sender_domain matches only exact domain (not subdomains)", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "sender_domain", pattern: "bar.com" }),
    ], "message");
    expect(p.matches(baseMsg({ id: "1", senderEmail: "foo@bar.com" }))).toBe(true);
    expect(p.matches(baseMsg({ id: "2", senderEmail: "foo@sub.bar.com" }))).toBe(
      false,
    );
    expect(p.matches(baseMsg({ id: "3", senderEmail: "foo@other.com" }))).toBe(false);
  });

  it("thread_id matches exactly", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "thread_id", pattern: "chat-xyz" }),
    ], "message");
    expect(p.matches(baseMsg({ id: "1", threadId: "chat-xyz" }))).toBe(true);
    expect(p.matches(baseMsg({ id: "2", threadId: "chat-abc" }))).toBe(false);
  });

  it("thread_name_contains matches case-insensitive substring", () => {
    const p = buildSteeringPredicate([
      rule({ id: 1, ruleType: "thread_name_contains", pattern: "jira" }),
    ], "message");
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
    ], "message");
    expect(p.matches(baseMsg({ id: "1", body: "the sync fail loop again" }))).toBe(
      true,
    );
    expect(p.matches(baseMsg({ id: "2", body: "everything healthy" }))).toBe(false);
  });

  it("body_contains doubles embedded double-quotes in the FTS5 MATCH phrase", () => {
    const p = buildSteeringPredicate(
      [rule({ id: 1, ruleType: "body_contains", pattern: 'say "hi" now' })],
      "message",
    );
    expect(p.params).toContain('"say ""hi"" now"');
  });

  it("a message rule scoped to both source and account joins the SQL clauses with AND", () => {
    const p = buildSteeringPredicate(
      [
        rule({
          id: 1,
          ruleType: "sender_email",
          pattern: "foo@bar.com",
          source: "outlook",
          account: "a@example.test",
        }),
      ],
      "message",
    );
    expect(p.sqlFragment).toContain("m.source = ? AND m.account = ?");
  });

  it("a sender_email pattern equal to the mutation-testing sentinel string still requires an exact senderEmail match", () => {
    const p = buildSteeringPredicate(
      [
        rule({
          id: 1,
          ruleType: "sender_email",
          pattern: "stryker was here!",
        }),
      ],
      "message",
    );
    expect(p.matches(baseMsg({ id: "1", senderEmail: undefined }))).toBe(
      false,
    );
  });

  it("rule source scope narrows the match", () => {
    const p = buildSteeringPredicate([
      rule({
        id: 1,
        ruleType: "sender_email",
        pattern: "foo@bar.com",
        source: "outlook",
      }),
    ], "message");
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
    ], "message");
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
    ], "message");
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
    ], "message");
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
    ], "message");
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
    ], "message");
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
    ], "message");
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
    ], "message");
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
    ], "message");
    expect(p.sqlFragment).toContain("LOWER(m.sender_email) = ?");
    expect(p.sqlFragment).toContain("LIKE");
    expect(p.params).toEqual(["foo@bar.com", "outlook", "%@baz.com"]);
  });

  it("AC3: event-targeted predicate excludes events from muted organizers", () => {
    const disabled = buildSteeringPredicate(
      [
        rule({
          id: 1,
          ruleType: "event_organizer_email",
          pattern: "noisy@example.test",
          enabled: false,
        }),
      ],
      "event",
    );
    expect(disabled.matches(baseEvent({ eventId: "1", organizerEmail: "noisy@example.test" }))).toBe(false);

    const enabled = buildSteeringPredicate(
      [rule({ id: 1, ruleType: "event_organizer_email", pattern: "noisy@example.test" })],
      "event",
    );
    // case-insensitive
    expect(
      enabled.matches(baseEvent({ eventId: "1", organizerEmail: "Noisy@Example.TEST" })),
    ).toBe(true);
    expect(
      enabled.matches(baseEvent({ eventId: "2", organizerEmail: "other@example.test" })),
    ).toBe(false);
  });

  it("AC4: event-targeted predicate filters by event_subject_contains, case-insensitive", () => {
    const p = buildSteeringPredicate(
      [rule({ id: 1, ruleType: "event_subject_contains", pattern: "standup" })],
      "event",
    );
    expect(p.matches(baseEvent({ eventId: "start", subject: "Standup daily" }))).toBe(true);
    expect(p.matches(baseEvent({ eventId: "mid", subject: "Daily STANDUP call" }))).toBe(true);
    expect(p.matches(baseEvent({ eventId: "end", subject: "Team standup" }))).toBe(true);
    expect(p.matches(baseEvent({ eventId: "none", subject: "1:1 with Kristof" }))).toBe(false);
    // unicode subject
    expect(p.matches(baseEvent({ eventId: "unicode", subject: "Café standup ☕" }))).toBe(true);
  });

  it("AC5: message-targeted rules do not filter events", () => {
    const p = buildSteeringPredicate(
      [rule({ id: 1, ruleType: "sender_email", pattern: "noisy@example.test" })],
      "event",
    );
    expect(p.sqlFragment).toBeNull();
    // A sender_email rule muting an organizer's address does NOT drop their meetings.
    expect(p.matches(baseEvent({ eventId: "1", organizerEmail: "noisy@example.test" }))).toBe(false);
  });

  it("AC6: event-targeted rules do not filter messages", () => {
    const p = buildSteeringPredicate(
      [rule({ id: 1, ruleType: "event_organizer_email", pattern: "noisy@example.test" })],
      "message",
    );
    expect(p.sqlFragment).toBeNull();
    // An event_organizer_email rule does NOT mute that person's emails.
    expect(p.matches(baseMsg({ id: "1", senderEmail: "noisy@example.test" }))).toBe(false);
  });

  it("event rule account scope narrows the match", () => {
    const p = buildSteeringPredicate(
      [
        rule({
          id: 1,
          ruleType: "event_organizer_email",
          pattern: "noisy@example.test",
          account: "a@example.test",
        }),
      ],
      "event",
    );
    expect(
      p.matches(
        baseEvent({ eventId: "1", account: "a@example.test", organizerEmail: "noisy@example.test" }),
      ),
    ).toBe(true);
    expect(
      p.matches(
        baseEvent({ eventId: "2", account: "b@example.test", organizerEmail: "noisy@example.test" }),
      ),
    ).toBe(false);
    // The account scope must also reach the SQL side, not just the JS
    // fallback matcher — a bug here would silently apply the rule to
    // every account when reading from SQLite.
    expect(p.sqlFragment).toContain("e.account = ?");
    expect(p.params).toEqual(["a@example.test", "noisy@example.test"]);
  });

  it("event rule with no account scope produces an unscoped SQL clause", () => {
    const p = buildSteeringPredicate(
      [rule({ id: 1, ruleType: "event_organizer_email", pattern: "noisy@example.test" })],
      "event",
    );
    expect(p.sqlFragment).not.toContain("e.account");
    expect(p.params).toEqual(["noisy@example.test"]);
  });

  it("event predicate sqlFragment uses the e. alias and escapes LIKE metacharacters", () => {
    const p = buildSteeringPredicate(
      [rule({ id: 1, ruleType: "event_subject_contains", pattern: "50%_off" })],
      "event",
    );
    expect(p.sqlFragment).toContain("LOWER(e.subject) LIKE ?");
    expect(p.params).toEqual(["%50\\%\\_off%"]);
  });

  it("event predicate treats a null organizer/subject as non-matching, not a SQL-null crash", () => {
    const organizerRule = buildSteeringPredicate(
      [rule({ id: 1, ruleType: "event_organizer_email", pattern: "noisy@example.test" })],
      "event",
    );
    expect(organizerRule.matches(baseEvent({ eventId: "1" }))).toBe(false);

    const subjectRule = buildSteeringPredicate(
      [rule({ id: 1, ruleType: "event_subject_contains", pattern: "standup" })],
      "event",
    );
    expect(subjectRule.matches(baseEvent({ eventId: "2" }))).toBe(false);

    // A missing organizerEmail/subject must fall back to "" for the match,
    // not any other placeholder string — pin against a substring of a
    // well-known mutation-testing default-value sentinel ("Stryker was
    // here!") so a wrong fallback string would flip these to true.
    const sentinelSubstringRule = buildSteeringPredicate(
      [rule({ id: 1, ruleType: "event_subject_contains", pattern: "here" })],
      "event",
    );
    expect(sentinelSubstringRule.matches(baseEvent({ eventId: "3" }))).toBe(
      false,
    );
    const sentinelExactRule = buildSteeringPredicate(
      [
        rule({
          id: 1,
          ruleType: "event_organizer_email",
          pattern: "stryker was here!",
        }),
      ],
      "event",
    );
    expect(sentinelExactRule.matches(baseEvent({ eventId: "4" }))).toBe(
      false,
    );
  });
});
