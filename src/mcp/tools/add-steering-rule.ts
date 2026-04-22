import type { Clock } from "../../clock.js";
import type { SteeringStore } from "../../store/steering-store.js";
import {
  STEERING_RULE_TYPES,
  StoreError,
  type MessageSource,
  type SteeringRuleType,
} from "../../store/types.js";
import { InvalidParamsError } from "./get-recent-activity.js";
import { project, type ProjectedSteeringRule } from "./get-steering.js";

const KNOWN_SOURCES: ReadonlySet<MessageSource> = new Set([
  "outlook",
  "teams",
  "whatsapp",
  "viva-engage",
]);

export interface AddSteeringRuleParams {
  readonly rule_type: string;
  readonly pattern: string;
  readonly source?: string;
  readonly account?: string;
  readonly reason?: string;
}

export interface AddSteeringRuleResult {
  readonly rule: ProjectedSteeringRule;
}

export const ADD_STEERING_RULE_TOOL = {
  name: "add_steering_rule",
  description: [
    "Add a steering rule that hides matching messages from `get_recent_activity` and `search`. Rules never delete data — they are a query-time filter; removing the rule brings the messages back.",
    "",
    "Use this when the user asks to stop seeing a sender, domain, thread, or keyword (e.g. \"not interested in mails from DevOps\", \"mute Barbara\", \"don't show me that sync-fail noise\"). Confirm the intended rule in chat before calling: rules are trivially reversible but explicit confirmation avoids accidental mutes.",
    "",
    "Rule types:",
    "- `sender_email` — exact match on sender address (case-insensitive).",
    "- `sender_domain` — match when sender email ends with `@<pattern>` (mute a whole domain). Must not contain `@`.",
    "- `thread_id` — exact match on thread id (mute one conversation; take the id from a prior tool result).",
    "- `thread_name_contains` — case-insensitive substring on thread name (e.g. `[Jira]`, `out of office`).",
    "- `body_contains` — keyword / phrase search in the message body (FTS5-backed).",
    "",
    "Optional `source` and `account` scope the rule to one source and/or one mailbox; omit for all. Optional `reason` is a free-text note shown on `get_steering` so future-you remembers why the rule exists.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      rule_type: {
        type: "string",
        enum: [...STEERING_RULE_TYPES],
        description: "One of: sender_email, sender_domain, thread_id, thread_name_contains, body_contains.",
      },
      pattern: {
        type: "string",
        minLength: 1,
        description:
          "The match pattern. Lowercased automatically for sender/domain/name/body; stored verbatim for thread_id.",
      },
      source: {
        type: "string",
        enum: ["outlook", "teams", "whatsapp", "viva-engage"],
        description: "Optional source scope.",
      },
      account: {
        type: "string",
        minLength: 1,
        description: "Optional account (mailbox) scope.",
      },
      reason: {
        type: "string",
        description: "Optional free-text note explaining why the rule exists.",
      },
    },
    required: ["rule_type", "pattern"],
    additionalProperties: false,
  },
} as const;

export async function handleAddSteeringRule(
  steering: SteeringStore,
  _clock: Clock,
  params: AddSteeringRuleParams,
): Promise<AddSteeringRuleResult> {
  if (
    typeof params.rule_type !== "string" ||
    !STEERING_RULE_TYPES.includes(params.rule_type as SteeringRuleType)
  ) {
    throw new InvalidParamsError(
      `rule_type must be one of: ${STEERING_RULE_TYPES.join(", ")}`,
    );
  }
  if (typeof params.pattern !== "string" || params.pattern.trim() === "") {
    throw new InvalidParamsError("pattern must be a non-empty string");
  }
  if (params.source !== undefined) {
    if (!KNOWN_SOURCES.has(params.source as MessageSource)) {
      throw new InvalidParamsError(`unknown source: ${params.source}`);
    }
  }
  if (
    params.account !== undefined &&
    (typeof params.account !== "string" || params.account.length === 0)
  ) {
    throw new InvalidParamsError("account must be a non-empty string");
  }
  if (params.reason !== undefined && typeof params.reason !== "string") {
    throw new InvalidParamsError("reason must be a string");
  }
  try {
    const rule = await steering.addRule({
      ruleType: params.rule_type as SteeringRuleType,
      pattern: params.pattern,
      ...(params.source !== undefined && {
        source: params.source as MessageSource,
      }),
      ...(params.account !== undefined && { account: params.account }),
      ...(params.reason !== undefined && { reason: params.reason }),
    });
    return { rule: project(rule) };
  } catch (err) {
    if (err instanceof StoreError) {
      throw new InvalidParamsError(err.message);
    }
    throw err;
  }
}
