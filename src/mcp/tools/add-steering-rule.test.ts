import { describe, expect, it } from "vitest";
import { FakeClock } from "../../testing/fake-clock.js";
import { InMemorySteeringStore } from "../../testing/in-memory-steering-store.js";
import {
  ADD_STEERING_RULE_TOOL,
  handleAddSteeringRule,
} from "./add-steering-rule.js";
import { InvalidParamsError } from "./get-recent-activity.js";

const clockAt = (iso: string): FakeClock => new FakeClock(new Date(iso));

describe("handleAddSteeringRule", () => {
  it("validates rule_type against the 5 allowed values", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    await expect(
      handleAddSteeringRule(steering, clock, {
        rule_type: "bogus",
        pattern: "x",
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects missing rule_type as non-string", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    await expect(
      handleAddSteeringRule(steering, clock, {
        rule_type: 42 as unknown as string,
        pattern: "x",
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects empty or whitespace pattern", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    await expect(
      handleAddSteeringRule(steering, clock, {
        rule_type: "sender_email",
        pattern: "",
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
    await expect(
      handleAddSteeringRule(steering, clock, {
        rule_type: "sender_email",
        pattern: "   ",
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects sender_domain pattern containing '@'", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    await expect(
      handleAddSteeringRule(steering, clock, {
        rule_type: "sender_domain",
        pattern: "foo@bar.com",
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects unknown source", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    await expect(
      handleAddSteeringRule(steering, clock, {
        rule_type: "sender_email",
        pattern: "a@b.test",
        source: "bogus",
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects empty account", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    await expect(
      handleAddSteeringRule(steering, clock, {
        rule_type: "sender_email",
        pattern: "a@b.test",
        account: "",
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects non-string reason", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    await expect(
      handleAddSteeringRule(steering, clock, {
        rule_type: "sender_email",
        pattern: "a@b.test",
        reason: 5 as unknown as string,
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("normalizes pattern to lowercase for email/domain/name/body", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    const email = await handleAddSteeringRule(steering, clock, {
      rule_type: "sender_email",
      pattern: "Noisy@BAR.com",
    });
    expect(email.rule.pattern).toBe("noisy@bar.com");
    const domain = await handleAddSteeringRule(steering, clock, {
      rule_type: "sender_domain",
      pattern: "NEWSLETTER.TEST",
    });
    expect(domain.rule.pattern).toBe("newsletter.test");
    const name = await handleAddSteeringRule(steering, clock, {
      rule_type: "thread_name_contains",
      pattern: "JIRA",
    });
    expect(name.rule.pattern).toBe("jira");
    const body = await handleAddSteeringRule(steering, clock, {
      rule_type: "body_contains",
      pattern: "Sync Fail",
    });
    expect(body.rule.pattern).toBe("sync fail");
  });

  it("preserves case for thread_id", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    const res = await handleAddSteeringRule(steering, clock, {
      rule_type: "thread_id",
      pattern: "Chat-XYZ-Preserved",
    });
    expect(res.rule.pattern).toBe("Chat-XYZ-Preserved");
  });

  it("returns the stored rule shape including scope and reason", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    const res = await handleAddSteeringRule(steering, clock, {
      rule_type: "sender_email",
      pattern: "alice@example.test",
      source: "outlook",
      account: "waldo@example.test",
      reason: "test account",
    });
    expect(res.rule).toMatchObject({
      ruleType: "sender_email",
      pattern: "alice@example.test",
      source: "outlook",
      account: "waldo@example.test",
      reason: "test account",
      enabled: true,
    });
    expect(typeof res.rule.id).toBe("number");
    expect(res.rule.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("surfaces dedupe as InvalidParamsError", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    await handleAddSteeringRule(steering, clock, {
      rule_type: "sender_email",
      pattern: "a@b.test",
    });
    await expect(
      handleAddSteeringRule(steering, clock, {
        rule_type: "sender_email",
        pattern: "a@b.test",
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("exposes a tool descriptor with the expected required fields", () => {
    expect(ADD_STEERING_RULE_TOOL.name).toBe("add_steering_rule");
    expect(ADD_STEERING_RULE_TOOL.inputSchema.required).toEqual([
      "rule_type",
      "pattern",
    ]);
  });
});
