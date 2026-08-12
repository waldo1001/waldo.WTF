import type { Database, Statement } from "better-sqlite3";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import { applyMigrations } from "./schema.js";
import {
  StoreError,
  type CalendarAccount,
  type EnableCalendarAccountInput,
} from "./types.js";

export interface CalendarAccountStore {
  // Idempotent: an already-enabled account returns the existing row
  // (updating tenantId if a different one was passed), never a conflict
  // error — re-running --calendar-enable is an expected operator action.
  enable(input: EnableCalendarAccountInput): Promise<CalendarAccount>;
  // Deletes the opt-in row. Already-synced events/attendees are untouched
  // — disabling stops future sync, it does not erase history.
  disable(account: string): Promise<{ removed: boolean }>;
  isEnabled(account: string): Promise<boolean>;
  isTranscriptsEnabled(account: string): Promise<boolean>;
  setTranscriptsEnabled(
    account: string,
    enabled: boolean,
  ): Promise<CalendarAccount | null>;
  listEnabled(): Promise<readonly CalendarAccount[]>;
  listAll(): Promise<readonly CalendarAccount[]>;
}

export function validateEnableInput(input: EnableCalendarAccountInput): void {
  if (input.account.trim() === "") {
    throw new StoreError("conflict", "account must be a non-empty string");
  }
}

interface CalendarAccountRow {
  account: string;
  tenant_id: string | null;
  transcripts_enabled: number;
  enabled_at: number;
}

function rowToAccount(r: CalendarAccountRow): CalendarAccount {
  return {
    account: r.account,
    ...(r.tenant_id !== null && { tenantId: r.tenant_id }),
    transcriptsEnabled: r.transcripts_enabled === 1,
    enabledAt: new Date(r.enabled_at),
  };
}

export class SqliteCalendarAccountStore implements CalendarAccountStore {
  private readonly upsertStmt: Statement<[string, string | null, number]>;
  private readonly getStmt: Statement<[string]>;
  private readonly deleteStmt: Statement<[string]>;
  private readonly setTranscriptsStmt: Statement<[number, string]>;
  private readonly listEnabledStmt: Statement<[]>;
  private readonly listAllStmt: Statement<[]>;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {
    applyMigrations(db);
    this.upsertStmt = db.prepare(`
      INSERT INTO calendar_accounts (account, tenant_id, enabled, transcripts_enabled, enabled_at)
      VALUES (?, ?, 1, 0, ?)
      ON CONFLICT(account) DO UPDATE SET
        tenant_id = excluded.tenant_id
    `);
    this.getStmt = db.prepare(
      "SELECT account, tenant_id, transcripts_enabled, enabled_at FROM calendar_accounts WHERE account = ?",
    );
    this.deleteStmt = db.prepare(
      "DELETE FROM calendar_accounts WHERE account = ?",
    );
    this.setTranscriptsStmt = db.prepare(
      "UPDATE calendar_accounts SET transcripts_enabled = ? WHERE account = ?",
    );
    this.listEnabledStmt = db.prepare(
      "SELECT account, tenant_id, transcripts_enabled, enabled_at FROM calendar_accounts WHERE enabled = 1 ORDER BY account ASC",
    );
    this.listAllStmt = db.prepare(
      "SELECT account, tenant_id, transcripts_enabled, enabled_at FROM calendar_accounts ORDER BY account ASC",
    );
  }

  async enable(input: EnableCalendarAccountInput): Promise<CalendarAccount> {
    validateEnableInput(input);
    this.upsertStmt.run(
      input.account,
      input.tenantId ?? null,
      this.clock.now().getTime(),
    );
    const row = this.getStmt.get(input.account) as
      | CalendarAccountRow
      | undefined;
    /* c8 ignore next 3 -- defensive: row was just inserted/updated */
    if (row === undefined) {
      throw new StoreError("corrupt", "enabled calendar account vanished");
    }
    return rowToAccount(row);
  }

  async disable(account: string): Promise<{ removed: boolean }> {
    const r = this.deleteStmt.run(account);
    return { removed: r.changes > 0 };
  }

  async isEnabled(account: string): Promise<boolean> {
    return this.getStmt.get(account) !== undefined;
  }

  async isTranscriptsEnabled(account: string): Promise<boolean> {
    const row = this.getStmt.get(account) as CalendarAccountRow | undefined;
    return row !== undefined && row.transcripts_enabled === 1;
  }

  async setTranscriptsEnabled(
    account: string,
    enabled: boolean,
  ): Promise<CalendarAccount | null> {
    const r = this.setTranscriptsStmt.run(enabled ? 1 : 0, account);
    if (r.changes === 0) return null;
    const row = this.getStmt.get(account) as CalendarAccountRow | undefined;
    return row === undefined ? null : rowToAccount(row);
  }

  async listEnabled(): Promise<readonly CalendarAccount[]> {
    const rows = this.listEnabledStmt.all() as CalendarAccountRow[];
    return rows.map(rowToAccount);
  }

  async listAll(): Promise<readonly CalendarAccount[]> {
    const rows = this.listAllStmt.all() as CalendarAccountRow[];
    return rows.map(rowToAccount);
  }
}
