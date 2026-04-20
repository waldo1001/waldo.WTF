import type { Clock } from "../../clock.js";
import type { SteeringStore } from "../../store/steering-store.js";
import { InvalidParamsError } from "./get-recent-activity.js";
import { project, type ProjectedSteeringRule } from "./get-steering.js";

export interface SetSteeringEnabledParams {
  readonly id: number;
  readonly enabled: boolean;
}

export interface SetSteeringEnabledResult {
  readonly rule: ProjectedSteeringRule | null;
}

export const SET_STEERING_ENABLED_TOOL = {
  name: "set_steering_enabled",
  description: [
    "Toggle a steering rule on or off without deleting it. Use `enabled: false` when the user asks to temporarily see muted items again (\"let me see Barbara's mails for now\"); `enabled: true` to restore the mute.",
    "",
    "Returns `{ rule: null }` if the id does not exist.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "number",
        exclusiveMinimum: 0,
        description: "The rule id from `get_steering`.",
      },
      enabled: {
        type: "boolean",
        description: "True to enable (hide matching messages); false to disable.",
      },
    },
    required: ["id", "enabled"],
    additionalProperties: false,
  },
} as const;

export async function handleSetSteeringEnabled(
  steering: SteeringStore,
  _clock: Clock,
  params: SetSteeringEnabledParams,
): Promise<SetSteeringEnabledResult> {
  if (
    typeof params.id !== "number" ||
    !Number.isFinite(params.id) ||
    !Number.isInteger(params.id) ||
    params.id <= 0
  ) {
    throw new InvalidParamsError("id must be a positive integer");
  }
  if (typeof params.enabled !== "boolean") {
    throw new InvalidParamsError("enabled must be a boolean");
  }
  const rule = await steering.setEnabled(params.id, params.enabled);
  return { rule: rule === null ? null : project(rule) };
}
