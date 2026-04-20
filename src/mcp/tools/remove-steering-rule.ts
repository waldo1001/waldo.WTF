import type { Clock } from "../../clock.js";
import type { SteeringStore } from "../../store/steering-store.js";
import { InvalidParamsError } from "./get-recent-activity.js";

export interface RemoveSteeringRuleParams {
  readonly id: number;
}

export interface RemoveSteeringRuleResult {
  readonly removed: boolean;
}

export const REMOVE_STEERING_RULE_TOOL = {
  name: "remove_steering_rule",
  description: [
    "Delete a steering rule by id. The hidden messages (if any) reappear in `get_recent_activity` and `search` immediately. Use `get_steering` first to find the id.",
    "",
    "Prefer `set_steering_enabled(id, false)` over removal when the user says \"temporarily show me those again\" — disabling preserves the rule so it can be re-enabled later.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "number",
        exclusiveMinimum: 0,
        description: "The rule id from `get_steering`.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
} as const;

export async function handleRemoveSteeringRule(
  steering: SteeringStore,
  _clock: Clock,
  params: RemoveSteeringRuleParams,
): Promise<RemoveSteeringRuleResult> {
  validateId(params.id);
  return steering.removeRule(params.id);
}

function validateId(id: unknown): asserts id is number {
  if (
    typeof id !== "number" ||
    !Number.isFinite(id) ||
    !Number.isInteger(id) ||
    id <= 0
  ) {
    throw new InvalidParamsError("id must be a positive integer");
  }
}
