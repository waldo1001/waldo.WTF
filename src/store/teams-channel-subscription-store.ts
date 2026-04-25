import type { Database, Statement } from "better-sqlite3";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import { applyMigrations } from "./schema.js";
import {
  StoreError,
  type AddTeamsChannelSubscriptionInput,
  type TeamsChannelSubscription,
} from "./types.js";

export interface TeamsChannelSubscriptionStore {
  subscribe(
    input: AddTeamsChannelSubscriptionInput,
  ): Promise<TeamsChannelSubscription>;
  unsubscribe(
    account: string,
    teamId: string,
    channelId: string,
  ): Promise<{ removed: boolean }>;
  listForAccount(
    account: string,
  ): Promise<readonly TeamsChannelSubscription[]>;
  listEnabledForAccount(
    account: string,
  ): Promise<readonly TeamsChannelSubscription[]>;
  listAll(): Promise<readonly TeamsChannelSubscription[]>;
  setCursor(
    account: string,
    teamId: string,
    channelId: string,
    at: Date,
  ): Promise<void>;
  toggleEnabled(
    account: string,
    teamId: string,
    channelId: string,
    enabled: boolean,
  ): Promise<TeamsChannelSubscription | null>;
}

export function validateSubscribeInput(
  input: AddTeamsChannelSubscriptionInput,
): void {
  if (input.account.trim() === "") {
    throw new StoreError("conflict", "account must be a non-empty string");
  }
  if (input.teamId.trim() === "") {
    throw new StoreError("conflict", "teamId must be a non-empty string");
  }
  if (input.channelId.trim() === "") {
    throw new StoreError("conflict", "channelId must be a non-empty string");
  }
}

interface TeamsChannelSubscriptionRow {
  account: string;
  team_id: string;
  team_name: string | null;
  channel_id: string;
  channel_name: string | null;
  enabled: number;
  subscribed_at: number;
  last_cursor_at: number | null;
}

function rowToSub(r: TeamsChannelSubscriptionRow): TeamsChannelSubscription {
  return {
    account: r.account,
    teamId: r.team_id,
    ...(r.team_name !== null && { teamName: r.team_name }),
    channelId: r.channel_id,
    ...(r.channel_name !== null && { channelName: r.channel_name }),
    enabled: r.enabled === 1,
    subscribedAt: new Date(r.subscribed_at),
    ...(r.last_cursor_at !== null && {
      lastCursorAt: new Date(r.last_cursor_at),
    }),
  };
}

export class SqliteTeamsChannelSubscriptionStore
  implements TeamsChannelSubscriptionStore
{
  private readonly insertStmt: Statement<
    [string, string, string | null, string, string | null, number]
  >;
  private readonly getStmt: Statement<[string, string, string]>;
  private readonly listAccountStmt: Statement<[string]>;
  private readonly listEnabledStmt: Statement<[string]>;
  private readonly listAllStmt: Statement<[]>;
  private readonly deleteStmt: Statement<[string, string, string]>;
  private readonly setCursorStmt: Statement<[number, string, string, string]>;
  private readonly setEnabledStmt: Statement<[number, string, string, string]>;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {
    applyMigrations(db);
    this.insertStmt = db.prepare(`
      INSERT INTO teams_channel_subscriptions
        (account, team_id, team_name, channel_id, channel_name, enabled, subscribed_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `);
    this.getStmt = db.prepare(`
      SELECT account, team_id, team_name, channel_id, channel_name,
             enabled, subscribed_at, last_cursor_at
      FROM teams_channel_subscriptions
      WHERE account = ? AND team_id = ? AND channel_id = ?
    `);
    this.listAccountStmt = db.prepare(`
      SELECT account, team_id, team_name, channel_id, channel_name,
             enabled, subscribed_at, last_cursor_at
      FROM teams_channel_subscriptions
      WHERE account = ?
      ORDER BY subscribed_at ASC, team_id ASC, channel_id ASC
    `);
    this.listEnabledStmt = db.prepare(`
      SELECT account, team_id, team_name, channel_id, channel_name,
             enabled, subscribed_at, last_cursor_at
      FROM teams_channel_subscriptions
      WHERE account = ? AND enabled = 1
      ORDER BY subscribed_at ASC, team_id ASC, channel_id ASC
    `);
    this.listAllStmt = db.prepare(`
      SELECT account, team_id, team_name, channel_id, channel_name,
             enabled, subscribed_at, last_cursor_at
      FROM teams_channel_subscriptions
      ORDER BY account ASC, team_id ASC, channel_id ASC
    `);
    this.deleteStmt = db.prepare(
      "DELETE FROM teams_channel_subscriptions WHERE account = ? AND team_id = ? AND channel_id = ?",
    );
    this.setCursorStmt = db.prepare(
      "UPDATE teams_channel_subscriptions SET last_cursor_at = ? WHERE account = ? AND team_id = ? AND channel_id = ?",
    );
    this.setEnabledStmt = db.prepare(
      "UPDATE teams_channel_subscriptions SET enabled = ? WHERE account = ? AND team_id = ? AND channel_id = ?",
    );
  }

  async subscribe(
    input: AddTeamsChannelSubscriptionInput,
  ): Promise<TeamsChannelSubscription> {
    validateSubscribeInput(input);
    const subscribedAt = this.clock.now().getTime();
    try {
      this.insertStmt.run(
        input.account,
        input.teamId,
        input.teamName ?? null,
        input.channelId,
        input.channelName ?? null,
        subscribedAt,
      );
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("UNIQUE")) {
        throw new StoreError(
          "conflict",
          `already subscribed: account=${input.account} team=${input.teamId} channel=${input.channelId}`,
          { cause: err },
        );
      }
      /* c8 ignore next -- defensive: any non-conflict sqlite error bubbles up */
      throw err;
    }
    const row = this.getStmt.get(
      input.account,
      input.teamId,
      input.channelId,
    ) as TeamsChannelSubscriptionRow | undefined;
    /* c8 ignore next 3 -- defensive: row was just inserted */
    if (row === undefined) {
      throw new StoreError("corrupt", "inserted subscription vanished");
    }
    return rowToSub(row);
  }

  async unsubscribe(
    account: string,
    teamId: string,
    channelId: string,
  ): Promise<{ removed: boolean }> {
    const r = this.deleteStmt.run(account, teamId, channelId);
    return { removed: r.changes > 0 };
  }

  async listForAccount(
    account: string,
  ): Promise<readonly TeamsChannelSubscription[]> {
    const rows = this.listAccountStmt.all(
      account,
    ) as TeamsChannelSubscriptionRow[];
    return rows.map(rowToSub);
  }

  async listEnabledForAccount(
    account: string,
  ): Promise<readonly TeamsChannelSubscription[]> {
    const rows = this.listEnabledStmt.all(
      account,
    ) as TeamsChannelSubscriptionRow[];
    return rows.map(rowToSub);
  }

  async listAll(): Promise<readonly TeamsChannelSubscription[]> {
    const rows = this.listAllStmt.all() as TeamsChannelSubscriptionRow[];
    return rows.map(rowToSub);
  }

  async setCursor(
    account: string,
    teamId: string,
    channelId: string,
    at: Date,
  ): Promise<void> {
    this.setCursorStmt.run(at.getTime(), account, teamId, channelId);
  }

  async toggleEnabled(
    account: string,
    teamId: string,
    channelId: string,
    enabled: boolean,
  ): Promise<TeamsChannelSubscription | null> {
    const r = this.setEnabledStmt.run(
      enabled ? 1 : 0,
      account,
      teamId,
      channelId,
    );
    if (r.changes === 0) return null;
    const row = this.getStmt.get(account, teamId, channelId) as
      | TeamsChannelSubscriptionRow
      | undefined;
    return row === undefined ? null : rowToSub(row);
  }
}
