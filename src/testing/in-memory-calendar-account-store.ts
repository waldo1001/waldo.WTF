import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import {
  validateEnableInput,
  type CalendarAccountStore,
} from "../store/calendar-account-store.js";
import type {
  CalendarAccount,
  EnableCalendarAccountInput,
} from "../store/types.js";

export class InMemoryCalendarAccountStore implements CalendarAccountStore {
  private readonly accounts = new Map<string, CalendarAccount>();

  constructor(private readonly clock: Clock = systemClock) {}

  async enable(input: EnableCalendarAccountInput): Promise<CalendarAccount> {
    validateEnableInput(input);
    const existing = this.accounts.get(input.account);
    const row: CalendarAccount = {
      account: input.account,
      ...(input.tenantId !== undefined && { tenantId: input.tenantId }),
      transcriptsEnabled: existing?.transcriptsEnabled ?? false,
      enabledAt: existing?.enabledAt ?? this.clock.now(),
    };
    this.accounts.set(input.account, row);
    return row;
  }

  async disable(account: string): Promise<{ removed: boolean }> {
    return { removed: this.accounts.delete(account) };
  }

  async isEnabled(account: string): Promise<boolean> {
    return this.accounts.has(account);
  }

  async isTranscriptsEnabled(account: string): Promise<boolean> {
    return this.accounts.get(account)?.transcriptsEnabled === true;
  }

  async setTranscriptsEnabled(
    account: string,
    enabled: boolean,
  ): Promise<CalendarAccount | null> {
    const cur = this.accounts.get(account);
    if (cur === undefined) return null;
    const updated: CalendarAccount = { ...cur, transcriptsEnabled: enabled };
    this.accounts.set(account, updated);
    return updated;
  }

  async listEnabled(): Promise<readonly CalendarAccount[]> {
    return this.listAll();
  }

  async listAll(): Promise<readonly CalendarAccount[]> {
    return [...this.accounts.values()].sort((a, b) =>
      a.account.localeCompare(b.account),
    );
  }
}
