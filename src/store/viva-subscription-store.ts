import type { Database, Statement } from "better-sqlite3";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import { applyMigrations } from "./schema.js";
import {
  StoreError,
  type AddVivaSubscriptionInput,
  type VivaSubscription,
} from "./types.js";

export interface VivaSubscriptionStore {
  subscribe(input: AddVivaSubscriptionInput): Promise<VivaSubscription>;
  unsubscribe(
    account: string,
    communityId: string,
  ): Promise<{ removed: boolean }>;
  listForAccount(account: string): Promise<readonly VivaSubscription[]>;
  listEnabledForAccount(
    account: string,
  ): Promise<readonly VivaSubscription[]>;
  setCursor(account: string, communityId: string, at: Date): Promise<void>;
  toggleEnabled(
    account: string,
    communityId: string,
    enabled: boolean,
  ): Promise<VivaSubscription | null>;
}

export function validateSubscribeInput(input: AddVivaSubscriptionInput): void {
  if (input.account.trim() === "") {
    throw new StoreError("conflict", "account must be a non-empty string");
  }
  if (input.networkId.trim() === "") {
    throw new StoreError("conflict", "networkId must be a non-empty string");
  }
  if (input.communityId.trim() === "") {
    throw new StoreError("conflict", "communityId must be a non-empty string");
  }
}

interface VivaSubscriptionRow {
  account: string;
  tenant_id: string | null;
  network_id: string;
  network_name: string | null;
  community_id: string;
  community_name: string | null;
  enabled: number;
  subscribed_at: number;
  last_cursor_at: number | null;
}

function rowToSub(r: VivaSubscriptionRow): VivaSubscription {
  return {
    account: r.account,
    ...(r.tenant_id !== null && { tenantId: r.tenant_id }),
    networkId: r.network_id,
    ...(r.network_name !== null && { networkName: r.network_name }),
    communityId: r.community_id,
    ...(r.community_name !== null && { communityName: r.community_name }),
    enabled: r.enabled === 1,
    subscribedAt: new Date(r.subscribed_at),
    ...(r.last_cursor_at !== null && {
      lastCursorAt: new Date(r.last_cursor_at),
    }),
  };
}

export class SqliteVivaSubscriptionStore implements VivaSubscriptionStore {
  private readonly insertStmt: Statement<
    [
      string,
      string | null,
      string,
      string | null,
      string,
      string | null,
      number,
    ]
  >;
  private readonly getStmt: Statement<[string, string]>;
  private readonly listAccountStmt: Statement<[string]>;
  private readonly listEnabledStmt: Statement<[string]>;
  private readonly deleteStmt: Statement<[string, string]>;
  private readonly setCursorStmt: Statement<[number, string, string]>;
  private readonly setEnabledStmt: Statement<[number, string, string]>;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {
    applyMigrations(db);
    this.insertStmt = db.prepare(`
      INSERT INTO viva_subscriptions
        (account, tenant_id, network_id, network_name, community_id, community_name, enabled, subscribed_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `);
    this.getStmt = db.prepare(`
      SELECT account, tenant_id, network_id, network_name, community_id, community_name,
             enabled, subscribed_at, last_cursor_at
      FROM viva_subscriptions
      WHERE account = ? AND community_id = ?
    `);
    this.listAccountStmt = db.prepare(`
      SELECT account, tenant_id, network_id, network_name, community_id, community_name,
             enabled, subscribed_at, last_cursor_at
      FROM viva_subscriptions
      WHERE account = ?
      ORDER BY subscribed_at ASC, community_id ASC
    `);
    this.listEnabledStmt = db.prepare(`
      SELECT account, tenant_id, network_id, network_name, community_id, community_name,
             enabled, subscribed_at, last_cursor_at
      FROM viva_subscriptions
      WHERE account = ? AND enabled = 1
      ORDER BY subscribed_at ASC, community_id ASC
    `);
    this.deleteStmt = db.prepare(
      "DELETE FROM viva_subscriptions WHERE account = ? AND community_id = ?",
    );
    this.setCursorStmt = db.prepare(
      "UPDATE viva_subscriptions SET last_cursor_at = ? WHERE account = ? AND community_id = ?",
    );
    this.setEnabledStmt = db.prepare(
      "UPDATE viva_subscriptions SET enabled = ? WHERE account = ? AND community_id = ?",
    );
  }

  async subscribe(
    input: AddVivaSubscriptionInput,
  ): Promise<VivaSubscription> {
    validateSubscribeInput(input);
    const subscribedAt = this.clock.now().getTime();
    try {
      this.insertStmt.run(
        input.account,
        input.tenantId ?? null,
        input.networkId,
        input.networkName ?? null,
        input.communityId,
        input.communityName ?? null,
        subscribedAt,
      );
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("UNIQUE")) {
        throw new StoreError(
          "conflict",
          `already subscribed: account=${input.account} community=${input.communityId}`,
          { cause: err },
        );
      }
      /* c8 ignore next -- defensive: any non-conflict sqlite error bubbles up */
      throw err;
    }
    const row = this.getStmt.get(input.account, input.communityId) as
      | VivaSubscriptionRow
      | undefined;
    /* c8 ignore next 3 -- defensive: row was just inserted */
    if (row === undefined) {
      throw new StoreError("corrupt", "inserted subscription vanished");
    }
    return rowToSub(row);
  }

  async unsubscribe(
    account: string,
    communityId: string,
  ): Promise<{ removed: boolean }> {
    const r = this.deleteStmt.run(account, communityId);
    return { removed: r.changes > 0 };
  }

  async listForAccount(
    account: string,
  ): Promise<readonly VivaSubscription[]> {
    const rows = this.listAccountStmt.all(account) as VivaSubscriptionRow[];
    return rows.map(rowToSub);
  }

  async listEnabledForAccount(
    account: string,
  ): Promise<readonly VivaSubscription[]> {
    const rows = this.listEnabledStmt.all(account) as VivaSubscriptionRow[];
    return rows.map(rowToSub);
  }

  async setCursor(
    account: string,
    communityId: string,
    at: Date,
  ): Promise<void> {
    this.setCursorStmt.run(at.getTime(), account, communityId);
  }

  async toggleEnabled(
    account: string,
    communityId: string,
    enabled: boolean,
  ): Promise<VivaSubscription | null> {
    const r = this.setEnabledStmt.run(enabled ? 1 : 0, account, communityId);
    if (r.changes === 0) return null;
    const row = this.getStmt.get(account, communityId) as
      | VivaSubscriptionRow
      | undefined;
    return row === undefined ? null : rowToSub(row);
  }
}
