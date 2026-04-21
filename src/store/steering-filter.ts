import type { Message, SteeringRule } from "./types.js";

export interface SteeringPredicate {
  readonly sqlFragment: string | null;
  readonly params: readonly (string | number)[];
  matches(msg: Message): boolean;
}

interface ClauseBuild {
  sql: string;
  params: (string | number)[];
  match(msg: Message): boolean;
}

function scopeMatchesMessage(rule: SteeringRule, msg: Message): boolean {
  if (rule.source !== undefined && msg.source !== rule.source) return false;
  if (rule.account !== undefined && msg.account !== rule.account) return false;
  return true;
}

function buildScopeSql(rule: SteeringRule): {
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

function buildClause(rule: SteeringRule): ClauseBuild {
  const scope = buildScopeSql(rule);
  switch (rule.ruleType) {
    case "sender_email": {
      const needle = rule.pattern;
      return {
        sql: `(${scope.sql} AND LOWER(m.sender_email) = ?)`,
        params: [...scope.params, needle],
        match: (msg) =>
          scopeMatchesMessage(rule, msg) &&
          (msg.senderEmail ?? "").toLowerCase() === needle,
      };
    }
    case "sender_domain": {
      const needle = `%@${rule.pattern}`;
      return {
        sql: `(${scope.sql} AND LOWER(m.sender_email) LIKE ?)`,
        params: [...scope.params, needle],
        match: (msg) =>
          scopeMatchesMessage(rule, msg) &&
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
        sql: `(${scope.sql} AND m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?))`,
        params: [...scope.params, ftsPhrase],
        match: (msg) =>
          scopeMatchesMessage(rule, msg) &&
          (msg.body ?? "").toLowerCase().includes(rule.pattern),
      };
    }
  }
}

export function buildSteeringPredicate(
  rules: readonly SteeringRule[],
): SteeringPredicate {
  const enabled = rules.filter((r) => r.enabled);
  if (enabled.length === 0) {
    return { sqlFragment: null, params: [], matches: () => false };
  }
  const built = enabled.map(buildClause);
  // COALESCE guards against SQL three-valued logic: a clause like
  // `LOWER(m.sender_email) = ?` yields NULL (not FALSE) when the column is
  // NULL, which would make `NOT <fragment>` evaluate to NULL and silently
  // drop rows with null columns (e.g. every whatsapp message under a
  // sender_email rule). Forcing NULL → 0 keeps those rows in results.
  const sqlFragment = `COALESCE((${built.map((c) => c.sql).join(" OR ")}), 0)`;
  const params: (string | number)[] = [];
  for (const c of built) params.push(...c.params);
  return {
    sqlFragment,
    params,
    matches: (msg) => built.some((c) => c.match(msg)),
  };
}
