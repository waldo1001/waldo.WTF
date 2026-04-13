import type { AuthClient } from "../auth/auth-client.js";
import type { Clock } from "../clock.js";
import type { MessageStore } from "../store/message-store.js";
import type { GraphClient } from "../sources/graph.js";
import type { TeamsClient } from "../sources/teams.js";
import { syncInbox } from "./sync-inbox.js";
import { syncTeams } from "./sync-teams.js";

export const DEFAULT_SYNC_INTERVAL_MS = 300_000;

/* c8 ignore next 3 */
const errorToString = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export interface TimerHandle {
  clear(): void;
}

export type SetTimerFn = (fn: () => void, ms: number) => TimerHandle;

export interface TickSummary {
  readonly accounts: number;
  readonly okCount: number;
  readonly errorCount: number;
}

export interface SyncSchedulerDeps {
  readonly auth: AuthClient;
  readonly graph: GraphClient;
  readonly teams?: TeamsClient;
  readonly store: MessageStore;
  readonly clock: Clock;
  readonly setTimer: SetTimerFn;
  readonly intervalMs: number;
  readonly onSkip?: () => void;
  readonly onTickComplete?: (summary: TickSummary) => void;
}

export class SyncScheduler {
  private handle: TimerHandle | null = null;
  private isRunning = false;

  constructor(private readonly deps: SyncSchedulerDeps) {}

  async runOnce(): Promise<void> {
    if (this.isRunning) {
      this.deps.onSkip?.();
      return;
    }
    this.isRunning = true;
    let okCount = 0;
    let errorCount = 0;
    let accountsCount = 0;
    try {
      const accounts = await this.deps.auth.listAccounts();
      accountsCount = accounts.length;
      for (const account of accounts) {
        try {
          const r = await syncInbox({
            account,
            auth: this.deps.auth,
            graph: this.deps.graph,
            store: this.deps.store,
            clock: this.deps.clock,
          });
          await this.deps.store.appendSyncLog({
            ts: this.deps.clock.now(),
            account: account.username,
            source: "outlook",
            status: "ok",
            messagesAdded: r.added,
          });
          okCount += 1;
        } catch (err) {
          await this.deps.store.appendSyncLog({
            ts: this.deps.clock.now(),
            account: account.username,
            source: "outlook",
            status: "error",
            errorMessage: errorToString(err),
          });
          errorCount += 1;
        }
        if (this.deps.teams !== undefined) {
          try {
            const r = await syncTeams({
              account,
              auth: this.deps.auth,
              teams: this.deps.teams,
              store: this.deps.store,
              clock: this.deps.clock,
            });
            await this.deps.store.appendSyncLog({
              ts: this.deps.clock.now(),
              account: account.username,
              source: "teams",
              status: "ok",
              messagesAdded: r.added,
            });
            okCount += 1;
          } catch (err) {
            await this.deps.store.appendSyncLog({
              ts: this.deps.clock.now(),
              account: account.username,
              source: "teams",
              status: "error",
              errorMessage: errorToString(err),
            });
            errorCount += 1;
          }
        }
      }
    } finally {
      this.isRunning = false;
      this.deps.onTickComplete?.({
        accounts: accountsCount,
        okCount,
        errorCount,
      });
    }
  }

  async start(): Promise<void> {
    await this.runOnce();
    this.handle = this.deps.setTimer(() => {
      void this.runOnce();
    }, this.deps.intervalMs);
  }

  stop(): void {
    this.handle?.clear();
    this.handle = null;
  }
}
