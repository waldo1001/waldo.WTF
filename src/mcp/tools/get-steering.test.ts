import { describe, expect, it } from "vitest";
import { FakeClock } from "../../testing/fake-clock.js";
import { InMemorySteeringStore } from "../../testing/in-memory-steering-store.js";
import { GET_STEERING_TOOL, handleGetSteering } from "./get-steering.js";

const clockAt = (iso: string): FakeClock => new FakeClock(new Date(iso));

describe("handleGetSteering", () => {
  it("returns empty when no rules exist", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    const res = await handleGetSteering(steering, clock);
    expect(res).toEqual({ count: 0, rules: [] });
  });

  it("returns enabled + disabled rules in insertion order with projected shape", async () => {
    let ms = 1000;
    const steering = new InMemorySteeringStore({
      now: () => new Date(ms++),
    });
    const clock = clockAt("2026-04-20T10:00:00Z");

    const first = await steering.addRule({
      ruleType: "sender_email",
      pattern: "Noisy@Bar.com",
    });
    const second = await steering.addRule({
      ruleType: "sender_domain",
      pattern: "newsletter.test",
      source: "outlook",
      reason: "ads",
    });
    await steering.setEnabled(second.id, false);

    const res = await handleGetSteering(steering, clock);
    expect(res.count).toBe(2);
    expect(res.rules).toEqual([
      {
        id: first.id,
        ruleType: "sender_email",
        pattern: "noisy@bar.com",
        enabled: true,
        createdAt: first.createdAt.toISOString(),
      },
      {
        id: second.id,
        ruleType: "sender_domain",
        pattern: "newsletter.test",
        source: "outlook",
        reason: "ads",
        enabled: false,
        createdAt: second.createdAt.toISOString(),
      },
    ]);
  });

  it("exposes a tool descriptor with an empty-object input schema", () => {
    expect(GET_STEERING_TOOL.name).toBe("get_steering");
    expect(GET_STEERING_TOOL.inputSchema.type).toBe("object");
    expect(GET_STEERING_TOOL.inputSchema.additionalProperties).toBe(false);
  });
});
