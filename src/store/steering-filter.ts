import { escapeLikePattern } from "./like-pattern.js";
import type { CalendarEvent, Message, SteeringRule, SteeringRuleType } from "./types.js";

export type SteeringTarget = "message" | "event";

export interface SteeringPredicate<T> {
  readonly sqlFragment: string | null;
  readonly params: readonly (string | number)[];
  matches(item: T): boolean;
}

interface ClauseBuild<T> {
  sql: string;
  params: (string | number)[];
  match(item: T): boolean;
}

// Which side of the schema a rule type filters. Exhaustive switch: adding a
// rule type to STEERING_RULE_TYPES without a case here is a compile error.
function ruleTarget(ruleType: SteeringRuleType): SteeringTarget {
  switch (ruleType) {
    case "sender_email":
    case "sender_domain":
    case "thread_id":
    case "thread_name_contains":
    case "body_contains":
      return "message";
    case "event_organizer_email":
    case "event_subject_contains":
      return "event";
  }
}

function scopeMatchesMessage(rule: SteeringRule, msg: Message): boolean {
  if (rule.source !== undefined && msg.source !== rule.source) return false;
  if (rule.account !== undefined && msg.account !== rule.account) return false;
  return true;
}

function buildMessageScopeSql(rule: SteeringRule): {
  sql: string;
  params: (string | number)[];
} {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (rule.source !== undefined) {
    parts.push("m.source = ?");
    params.push(rule.source);
  }
  if (rule.account !== undefined) {
    parts.push("m.account = ?");
    params.push(rule.account);
  }
  return { sql: parts.length === 0 ? "1" : parts.join(" AND "), params };
}

// Rules that target the correspondent or a topical body match must not mute
// the user's own outgoing replies — otherwise a user muting a sender would
// also hide their own answers to that sender, making "did I reply?" unusable.
// Thread-level rules (thread_id, thread_name_contains) keep muting fromMe
// rows, because muting a whole thread is a stronger, explicit intent.
const isFromMe = (msg: Message): boolean => msg.fromMe === true;

function buildMessageClause(rule: SteeringRule): ClauseBuild<Message> {
  const scope = buildMessageScopeSql(rule);
  switch (rule.ruleType) {
    case "sender_email": {
      const needle = rule.pattern;
      return {
        sql: `(${scope.sql} AND m.from_me = 0 AND LOWER(m.sender_email) = ?)`,
        params: [...scope.params, needle],
        match: (msg) =>
          scopeMatchesMessage(rule, msg) &&
          !isFromMe(msg) &&
          (msg.senderEmail ?? "").toLowerCase() === needle,
      };
    }
    case "sender_domain": {
      const needle = `%@${rule.pattern}`;
      return {
        sql: `(${scope.sql} AND m.from_me = 0 AND LOWER(m.sender_email) LIKE ?)`,
        params: [...scope.params, needle],
        match: (msg) =>
          scopeMatchesMessage(rule, msg) &&
          !isFromMe(msg) &&
          (msg.senderEmail ?? "").toLowerCase().endsWith(`@${rule.pattern}`),
      };
    }
    case "thread_id": {
      return {
        sql: `(${scope.sql} AND m.thread_id = ?)`,
        params: [...scope.params, rule.pattern],
        match: (msg) =>
          scopeMatchesMessage(rule, msg) && msg.threadId === rule.pattern,
      };
    }
    case "thread_name_contains": {
      const needle = `%${rule.pattern}%`;
      return {
        sql: `(${scope.sql} AND LOWER(m.thread_name) LIKE ?)`,
        params: [...scope.params, needle],
        match: (msg) =>
          scopeMatchesMessage(rule, msg) &&
          (msg.threadName ?? "").toLowerCase().includes(rule.pattern),
      };
    }
    case "body_contains": {
      const ftsPhrase = `"${rule.pattern.replace(/"/g, '""')}"`;
      return {
        sql: `(${scope.sql} AND m.from_me = 0 AND m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?))`,
        params: [...scope.params, ftsPhrase],
        match: (msg) =>
          scopeMatchesMessage(rule, msg) &&
          !isFromMe(msg) &&
          (msg.body ?? "").toLowerCase().includes(rule.pattern),
      };
    }
    /* c8 ignore next 3 -- unreachable: ruleTarget() filters event-targeted rules out before this is called */
    default:
      throw new Error(`not a message-targeted rule type: ${rule.ruleType}`);
  }
}

// Events have no MessageSource-comparable "source" dimension, so only
// `account` scopes an event-targeted rule; `source` (if ever set on such a
// rule) is simply not applicable and is ignored here.
function scopeMatchesEvent(rule: SteeringRule, event: CalendarEvent): boolean {
  if (rule.account !== undefined && event.account !== rule.account) return false;
  return true;
}

function buildEventScopeSql(rule: SteeringRule): {
  sql: string;
  params: (string | number)[];
} {
  if (rule.account !== undefined) {
    return { sql: "e.account = ?", params: [rule.account] };
  }
  return { sql: "1", params: [] };
}

function buildEventClause(rule: SteeringRule): ClauseBuild<CalendarEvent> {
  const scope = buildEventScopeSql(rule);
  switch (rule.ruleType) {
    case "event_organizer_email": {
      const needle = rule.pattern;
      return {
        sql: `(${scope.sql} AND LOWER(e.organizer_email) = ?)`,
        params: [...scope.params, needle],
        match: (event) =>
          scopeMatchesEvent(rule, event) &&
          (event.organizerEmail ?? "").toLowerCase() === needle,
      };
    }
    case "event_subject_contains": {
      const needle = `%${escapeLikePattern(rule.pattern)}%`;
      return {
        sql: `(${scope.sql} AND LOWER(e.subject) LIKE ? ESCAPE '\\')`,
        params: [...scope.params, needle],
        match: (event) =>
          scopeMatchesEvent(rule, event) &&
          (event.subject ?? "").toLowerCase().includes(rule.pattern),
      };
    }
    /* c8 ignore next 3 -- unreachable: ruleTarget() filters message-targeted rules out before this is called */
    default:
      throw new Error(`not an event-targeted rule type: ${rule.ruleType}`);
  }
}

// COALESCE guards against SQL three-valued logic: a clause like
// `LOWER(m.sender_email) = ?` yields NULL (not FALSE) when the column is
// NULL, which would make `NOT <fragment>` evaluate to NULL and silently
// drop rows with null columns (e.g. every whatsapp message under a
// sender_email rule, or every in-person event under an organizer rule).
// Forcing NULL → 0 keeps those rows in results.
function combine<T>(built: readonly ClauseBuild<T>[]): SteeringPredicate<T> {
  if (built.length === 0) {
    return { sqlFragment: null, params: [], matches: () => false };
  }
  const sqlFragment = `COALESCE((${built.map((c) => c.sql).join(" OR ")}), 0)`;
  const params: (string | number)[] = [];
  for (const c of built) params.push(...c.params);
  return {
    sqlFragment,
    params,
    matches: (item) => built.some((c) => c.match(item)),
  };
}

// `target` is required (no default) so a caller can never accidentally
// apply message-scoped filtering to events or vice versa — the two rule
// families share this one builder, but a wrong-target bug would otherwise
// be silent (both produce a same-shaped SteeringPredicate).
export function buildSteeringPredicate(
  rules: readonly SteeringRule[],
  target: "message",
): SteeringPredicate<Message>;
export function buildSteeringPredicate(
  rules: readonly SteeringRule[],
  target: "event",
): SteeringPredicate<CalendarEvent>;
export function buildSteeringPredicate(
  rules: readonly SteeringRule[],
  target: SteeringTarget,
): SteeringPredicate<Message> | SteeringPredicate<CalendarEvent> {
  const enabled = rules.filter(
    (r) => r.enabled && ruleTarget(r.ruleType) === target,
  );
  if (target === "message") {
    return combine(enabled.map(buildMessageClause));
  }
  return combine(enabled.map(buildEventClause));
}
