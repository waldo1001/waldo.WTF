import type { AuthClient } from "../auth/auth-client.js";
import {
  isConsentRequiredError,
  TEAMS_CHANNEL_SCOPES,
} from "../auth/msal-auth-client.js";
import type { Clock } from "../clock.js";
import type { MessageStore } from "../store/message-store.js";
import type { TeamsChannelSubscriptionStore } from "../store/teams-channel-subscription-store.js";
import type { VivaSubscriptionStore } from "../store/viva-subscription-store.js";
import type { GraphClient } from "../sources/graph.js";
import type { TeamsClient } from "../sources/teams.js";
import type { TeamsChannelClient } from "../sources/teams-channel.js";
import type { VivaClient } from "../sources/viva.js";
import { syncInbox } from "./sync-inbox.js";
import { syncSent } from "./sync-sent.js";
import { syncTeams } from "./sync-teams.js";
import { syncTeamsChannels } from "./sync-teams-channels.js";
import { syncViva } from "./sync-viva.js";

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
  // Separate AuthClient for viva-engage token acquisition. Viva requires
  // the Azure CLI public clientId (YAMMER_PUBLIC_CLIENT_ID) because
  // --add-account --tenant records external-tenant refresh tokens there;
  // MSAL caches are partitioned by clientId, so reusing `auth` would
  // silent-fail on the authority override. Falls back to `auth` when
  // omitted — keeps tests that don't care about the partition green.
  readonly vivaAuth?: AuthClient;
  readonly graph: GraphClient;
  readonly teams?: TeamsClient;
  readonly teamsChannel?: TeamsChannelClient;
  readonly teamsChannelSubs?: TeamsChannelSubscriptionStore;
  readonly viva?: VivaClient;
  readonly vivaSubs?: VivaSubscriptionStore;
  readonly store: MessageStore;
  readonly clock: Clock;
  readonly setTimer: SetTimerFn;
  readonly intervalMs: number;
  readonly onSkip?: () => void;
  readonly onTickComplete?: (summary: TickSummary) => void;
  readonly backfillDays?: number;
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
        await this.deps.store.upsertAccount({
          username: account.username,
          tenantId: account.tenantId,
          addedAt: this.deps.clock.now(),
        });
        try {
          const r = await syncInbox({
            account,
            auth: this.deps.auth,
            graph: this.deps.graph,
            store: this.deps.store,
            clock: this.deps.clock,
            ...(this.deps.backfillDays !== undefined && {
              backfillDays: this.deps.backfillDays,
            }),
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
        try {
          const r = await syncSent({
            account,
            auth: this.deps.auth,
            graph: this.deps.graph,
            store: this.deps.store,
            clock: this.deps.clock,
            ...(this.deps.backfillDays !== undefined && {
              backfillDays: this.deps.backfillDays,
            }),
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
              ...(this.deps.backfillDays !== undefined && {
                backfillDays: this.deps.backfillDays,
              }),
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
        if (
          this.deps.teamsChannel !== undefined &&
          this.deps.teamsChannelSubs !== undefined
        ) {
          // Skip the per-account scope acquisition entirely if no enabled
          // subscriptions exist — keeps idle ticks free of Graph traffic.
          const enabled =
            await this.deps.teamsChannelSubs.listEnabledForAccount(
              account.username,
            );
          if (enabled.length > 0) {
            try {
              const r = await syncTeamsChannels({
                account,
                auth: this.deps.auth,
                client: this.deps.teamsChannel,
                store: this.deps.store,
                subs: this.deps.teamsChannelSubs,
                clock: this.deps.clock,
                ...(this.deps.backfillDays !== undefined && {
                  backfillDays: this.deps.backfillDays,
                }),
              });
              await this.deps.store.appendSyncLog({
                ts: this.deps.clock.now(),
                account: account.username,
                source: "teams-channel",
                status: "ok",
                messagesAdded: r.added,
              });
              okCount += 1;
            } catch (err) {
              // Admin-consent rejection: log a single row per account per
              // tick rather than spamming a row per subscription. The CLI
              // surfaces the same hint via realTeams discovery.
              const message = isConsentRequiredError(err)
                ? `Teams channel scopes not consented for tenant ${account.tenantId} — ask a tenant admin to grant: ${TEAMS_CHANNEL_SCOPES.join(", ")}`
                : errorToString(err);
              await this.deps.store.appendSyncLog({
                ts: this.deps.clock.now(),
                account: account.username,
                source: "teams-channel",
                status: "error",
                errorMessage: message,
              });
              errorCount += 1;
            }
          }
        }
        if (
          this.deps.viva !== undefined &&
          this.deps.vivaSubs !== undefined
        ) {
          // Skip the Graph call entirely if the account has no enabled
          // subscriptions — avoids burning rate-limit budget on idle ticks.
          const enabled =
            await this.deps.vivaSubs.listEnabledForAccount(account.username);
          if (enabled.length > 0) {
            try {
              const r = await syncViva({
                account,
                auth: this.deps.vivaAuth ?? this.deps.auth,
                viva: this.deps.viva,
                store: this.deps.store,
                subs: this.deps.vivaSubs,
                clock: this.deps.clock,
              });
              await this.deps.store.appendSyncLog({
                ts: this.deps.clock.now(),
                account: account.username,
                source: "viva-engage",
                status: "ok",
                messagesAdded: r.added,
              });
              okCount += 1;
            } catch (err) {
              await this.deps.store.appendSyncLog({
                ts: this.deps.clock.now(),
                account: account.username,
                source: "viva-engage",
                status: "error",
                errorMessage: errorToString(err),
              });
              errorCount += 1;
            }
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
