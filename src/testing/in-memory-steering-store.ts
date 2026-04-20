import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import {
  normalizePattern,
  validateAddInput,
  type SteeringStore,
} from "../store/steering-store.js";
import {
  StoreError,
  type AddSteeringRuleInput,
  type SteeringRule,
} from "../store/types.js";

function dedupeKey(
  ruleType: string,
  pattern: string,
  source: string | undefined,
  account: string | undefined,
): string {
  return [ruleType, pattern, source ?? "", account ?? ""].join("\u0000");
}

export class InMemorySteeringStore implements SteeringStore {
  private nextId = 1;
  private readonly rules = new Map<number, SteeringRule>();

  constructor(private readonly clock: Clock = systemClock) {}

  async addRule(input: AddSteeringRuleInput): Promise<SteeringRule> {
    validateAddInput(input);
    const pattern = normalizePattern(input.ruleType, input.pattern);
    const key = dedupeKey(input.ruleType, pattern, input.source, input.account);
    for (const existing of this.rules.values()) {
      const existingKey = dedupeKey(
        existing.ruleType,
        existing.pattern,
        existing.source,
        existing.account,
      );
      if (existingKey === key) {
        throw new StoreError("conflict", "duplicate steering rule");
      }
    }
    const id = this.nextId++;
    const rule: SteeringRule = {
      id,
      ruleType: input.ruleType,
      pattern,
      ...(input.source !== undefined && { source: input.source }),
      ...(input.account !== undefined && { account: input.account }),
      ...(input.reason !== undefined && { reason: input.reason }),
      enabled: true,
      createdAt: this.clock.now(),
    };
    this.rules.set(id, rule);
    return rule;
  }

  async listRules(): Promise<readonly SteeringRule[]> {
    return [...this.rules.values()].sort((a, b) => {
      const t = a.createdAt.getTime() - b.createdAt.getTime();
      return t !== 0 ? t : a.id - b.id;
    });
  }

  async setEnabled(
    id: number,
    enabled: boolean,
  ): Promise<SteeringRule | null> {
    const current = this.rules.get(id);
    if (current === undefined) return null;
    const updated: SteeringRule = { ...current, enabled };
    this.rules.set(id, updated);
    return updated;
  }

  async removeRule(id: number): Promise<{ removed: boolean }> {
    return { removed: this.rules.delete(id) };
  }
}
