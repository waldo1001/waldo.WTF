import type { Database, Statement } from "better-sqlite3";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import { applyMigrations } from "./schema.js";
import {
  STEERING_RULE_TYPES,
  StoreError,
  type AddSteeringRuleInput,
  type MessageSource,
  type SteeringRule,
  type SteeringRuleType,
} from "./types.js";

export interface SteeringStore {
  addRule(input: AddSteeringRuleInput): Promise<SteeringRule>;
  listRules(): Promise<readonly SteeringRule[]>;
  setEnabled(id: number, enabled: boolean): Promise<SteeringRule | null>;
  removeRule(id: number): Promise<{ removed: boolean }>;
}

export function normalizePattern(
  ruleType: SteeringRuleType,
  pattern: string,
): string {
  const trimmed = pattern.trim();
  switch (ruleType) {
    case "sender_email":
    case "sender_domain":
    case "thread_name_contains":
    case "body_contains":
      return trimmed.toLowerCase();
    case "thread_id":
      return trimmed;
  }
}

export function validateAddInput(input: AddSteeringRuleInput): void {
  if (!STEERING_RULE_TYPES.includes(input.ruleType)) {
    throw new StoreError(
      "conflict",
      `unknown rule_type: ${String(input.ruleType)}`,
    );
  }
  if (input.pattern.trim() === "") {
    throw new StoreError("conflict", "pattern must not be empty");
  }
  if (input.ruleType === "sender_domain" && input.pattern.includes("@")) {
    throw new StoreError(
      "conflict",
      "sender_domain pattern must not contain '@'",
    );
  }
}

interface SteeringRuleRow {
  id: number;
  rule_type: string;
  pattern: string;
  source: string | null;
  account: string | null;
  reason: string | null;
  enabled: number;
  created_at: number;
}

function rowToRule(r: SteeringRuleRow): SteeringRule {
  return {
    id: r.id,
    ruleType: r.rule_type as SteeringRuleType,
    pattern: r.pattern,
    ...(r.source !== null && { source: r.source as MessageSource }),
    ...(r.account !== null && { account: r.account }),
    ...(r.reason !== null && { reason: r.reason }),
    enabled: r.enabled === 1,
    createdAt: new Date(r.created_at),
  };
}

export class SqliteSteeringStore implements SteeringStore {
  private readonly insertStmt: Statement<
    [string, string, string | null, string | null, string | null, number, number]
  >;
  private readonly listStmt: Statement<[]>;
  private readonly getStmt: Statement<[number]>;
  private readonly setEnabledStmt: Statement<[number, number]>;
  private readonly deleteStmt: Statement<[number]>;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {
    applyMigrations(db);
    this.insertStmt = db.prepare(`
      INSERT INTO steering_rules
        (rule_type, pattern, source, account, reason, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.listStmt = db.prepare(`
      SELECT id, rule_type, pattern, source, account, reason, enabled, created_at
      FROM steering_rules
      ORDER BY created_at ASC, id ASC
    `);
    this.getStmt = db.prepare(`
      SELECT id, rule_type, pattern, source, account, reason, enabled, created_at
      FROM steering_rules
      WHERE id = ?
    `);
    this.setEnabledStmt = db.prepare(
      "UPDATE steering_rules SET enabled = ? WHERE id = ?",
    );
    this.deleteStmt = db.prepare("DELETE FROM steering_rules WHERE id = ?");
  }

  async addRule(input: AddSteeringRuleInput): Promise<SteeringRule> {
    validateAddInput(input);
    const pattern = normalizePattern(input.ruleType, input.pattern);
    const createdAt = this.clock.now().getTime();
    try {
      const result = this.insertStmt.run(
        input.ruleType,
        pattern,
        input.source ?? null,
        input.account ?? null,
        input.reason ?? null,
        1,
        createdAt,
      );
      const row = this.getStmt.get(Number(result.lastInsertRowid)) as
        | SteeringRuleRow
        | undefined;
      /* c8 ignore next 3 -- defensive: sqlite just returned this rowid */
      if (row === undefined) {
        throw new StoreError("corrupt", "inserted rule vanished");
      }
      return rowToRule(row);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("UNIQUE")) {
        throw new StoreError("conflict", "duplicate steering rule", {
          cause: err,
        });
      }
      /* c8 ignore next -- defensive: any non-UNIQUE sqlite error bubbles up */
      throw err;
    }
  }

  async listRules(): Promise<readonly SteeringRule[]> {
    const rows = this.listStmt.all() as SteeringRuleRow[];
    return rows.map(rowToRule);
  }

  async setEnabled(
    id: number,
    enabled: boolean,
  ): Promise<SteeringRule | null> {
    const result = this.setEnabledStmt.run(enabled ? 1 : 0, id);
    if (result.changes === 0) return null;
    const row = this.getStmt.get(id) as SteeringRuleRow | undefined;
    return row === undefined ? null : rowToRule(row);
  }

  async removeRule(id: number): Promise<{ removed: boolean }> {
    const result = this.deleteStmt.run(id);
    return { removed: result.changes > 0 };
  }
}
