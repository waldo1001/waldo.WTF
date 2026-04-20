import { describe, expect, it } from "vitest";
import { FakeClock } from "../../testing/fake-clock.js";
import { InMemorySteeringStore } from "../../testing/in-memory-steering-store.js";
import { InvalidParamsError } from "./get-recent-activity.js";
import {
  REMOVE_STEERING_RULE_TOOL,
  handleRemoveSteeringRule,
} from "./remove-steering-rule.js";

const clockAt = (iso: string): FakeClock => new FakeClock(new Date(iso));

describe("handleRemoveSteeringRule", () => {
  it("returns { removed: true } for a known id", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    const rule = await steering.addRule({
      ruleType: "sender_email",
      pattern: "a@b.test",
    });
    const res = await handleRemoveSteeringRule(steering, clock, {
      id: rule.id,
    });
    expect(res).toEqual({ removed: true });
    expect(await steering.listRules()).toHaveLength(0);
  });

  it("returns { removed: false } for an unknown id", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    const res = await handleRemoveSteeringRule(steering, clock, { id: 999 });
    expect(res).toEqual({ removed: false });
  });

  it("rejects id <= 0", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    await expect(
      handleRemoveSteeringRule(steering, clock, { id: 0 }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
    await expect(
      handleRemoveSteeringRule(steering, clock, { id: -1 }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects non-integer / non-finite id", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    await expect(
      handleRemoveSteeringRule(steering, clock, { id: 1.5 }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
    await expect(
      handleRemoveSteeringRule(steering, clock, { id: Number.NaN }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
    await expect(
      handleRemoveSteeringRule(steering, clock, {
        id: "7" as unknown as number,
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("exposes a tool descriptor with id required", () => {
    expect(REMOVE_STEERING_RULE_TOOL.name).toBe("remove_steering_rule");
    expect(REMOVE_STEERING_RULE_TOOL.inputSchema.required).toEqual(["id"]);
  });
});
