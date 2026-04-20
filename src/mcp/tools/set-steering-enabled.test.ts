import { describe, expect, it } from "vitest";
import { FakeClock } from "../../testing/fake-clock.js";
import { InMemorySteeringStore } from "../../testing/in-memory-steering-store.js";
import { InvalidParamsError } from "./get-recent-activity.js";
import {
  SET_STEERING_ENABLED_TOOL,
  handleSetSteeringEnabled,
} from "./set-steering-enabled.js";

const clockAt = (iso: string): FakeClock => new FakeClock(new Date(iso));

describe("handleSetSteeringEnabled", () => {
  it("toggles enabled=false and returns the updated rule", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    const rule = await steering.addRule({
      ruleType: "sender_email",
      pattern: "a@b.test",
    });
    const res = await handleSetSteeringEnabled(steering, clock, {
      id: rule.id,
      enabled: false,
    });
    expect(res.rule?.enabled).toBe(false);
    expect(res.rule?.id).toBe(rule.id);
  });

  it("toggles enabled back to true", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    const rule = await steering.addRule({
      ruleType: "sender_email",
      pattern: "a@b.test",
    });
    await handleSetSteeringEnabled(steering, clock, {
      id: rule.id,
      enabled: false,
    });
    const res = await handleSetSteeringEnabled(steering, clock, {
      id: rule.id,
      enabled: true,
    });
    expect(res.rule?.enabled).toBe(true);
  });

  it("returns { rule: null } for unknown id", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    const res = await handleSetSteeringEnabled(steering, clock, {
      id: 999,
      enabled: false,
    });
    expect(res).toEqual({ rule: null });
  });

  it("rejects non-positive-integer id", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    await expect(
      handleSetSteeringEnabled(steering, clock, { id: 0, enabled: true }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
    await expect(
      handleSetSteeringEnabled(steering, clock, { id: 1.5, enabled: true }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
    await expect(
      handleSetSteeringEnabled(steering, clock, {
        id: Number.NaN,
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("rejects non-boolean enabled", async () => {
    const steering = new InMemorySteeringStore();
    const clock = clockAt("2026-04-20T10:00:00Z");
    await expect(
      handleSetSteeringEnabled(steering, clock, {
        id: 1,
        enabled: "true" as unknown as boolean,
      }),
    ).rejects.toBeInstanceOf(InvalidParamsError);
  });

  it("exposes a tool descriptor with id + enabled required", () => {
    expect(SET_STEERING_ENABLED_TOOL.name).toBe("set_steering_enabled");
    expect(SET_STEERING_ENABLED_TOOL.inputSchema.required).toEqual([
      "id",
      "enabled",
    ]);
  });
});
