import type { Clock } from "../../clock.js";
import type { SteeringStore } from "../../store/steering-store.js";
import type {
  MessageSource,
  SteeringRule,
  SteeringRuleType,
} from "../../store/types.js";

export interface ProjectedSteeringRule {
  readonly id: number;
  readonly ruleType: SteeringRuleType;
  readonly pattern: string;
  readonly source?: MessageSource;
  readonly account?: string;
  readonly reason?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
}

export interface GetSteeringResult {
  readonly count: number;
  readonly rules: readonly ProjectedSteeringRule[];
}

export const GET_STEERING_TOOL = {
  name: "get_steering",
  description: [
    "List every steering rule (enabled + disabled). Use this to self-explain why a message was hidden (e.g. \"because you muted sender_domain github.com on 2026-04-20\"), or to review before adding a new rule. Read-only.",
    "",
    "Steering rules filter messages out of `get_recent_activity` and `search` at query time — they never delete data. `get_thread`, `list_accounts`, and `list_threads` are unaffected.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
} as const;

export async function handleGetSteering(
  steering: SteeringStore,
  _clock: Clock,
): Promise<GetSteeringResult> {
  const rules = await steering.listRules();
  return {
    count: rules.length,
    rules: rules.map(project),
  };
}

export function project(r: SteeringRule): ProjectedSteeringRule {
  return {
    id: r.id,
    ruleType: r.ruleType,
    pattern: r.pattern,
    ...(r.source !== undefined && { source: r.source }),
    ...(r.account !== undefined && { account: r.account }),
    ...(r.reason !== undefined && { reason: r.reason }),
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
  };
}
