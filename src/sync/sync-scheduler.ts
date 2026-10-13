import type { AuthClient } from "../auth/auth-client.js";
import {
  CALENDAR_SCOPES,
  isConsentRequiredError,
  TEAMS_CHANNEL_SCOPES,
  TRANSCRIPT_SCOPES,
} from "../auth/msal-auth-client.js";
import type { Clock } from "../clock.js";
import type { CalendarAccountStore } from "../store/calendar-account-store.js";
import type { MessageStore } from "../store/message-store.js";
import type { TeamsChannelSubscriptionStore } from "../store/teams-channel-subscription-store.js";
import type { VivaSubscriptionStore } from "../store/viva-subscription-store.js";
import type { CalendarClient } from "../sources/calendar.js";
import type { GraphClient } from "../sources/graph.js";
import type { TeamsClient } from "../sources/teams.js";
import type { TeamsChannelClient } from "../sources/teams-channel.js";
import type { TranscriptClient } from "../sources/transcript.js";
import type { VivaClient } from "../sources/viva.js";
import { syncCalendarEvents } from "./sync-calendar.js";
import { syncInbox } from "./sync-inbox.js";
import { syncSent } from "./sync-sent.js";
import { syncTeams } from "./sync-teams.js";
import { syncTeamsChannels } from "./sync-teams-channels.js";
import { syncTranscripts } from "./sync-transcripts.js";
import { syncViva } from "./sync-viva.js";

export const DEFAULT_SYNC_INTERVAL_MS = 300_000;

/* v8 ignore next -- @preserve */
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
  readonly calendar?: CalendarClient;
  readonly calendarAccounts?: CalendarAccountStore;
  readonly transcripts?: TranscriptClient;
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
        if (
          this.deps.calendar !== undefined &&
          this.deps.calendarAccounts !== undefined
        ) {
          // Calendar is per-account opt-in (unlike every other source) —
          // skip entirely unless this account has been explicitly enabled
          // via --calendar-enable. Keeps non-opted-in accounts free of any
          // calendar Graph traffic or re-consent prompt.
          const enabled = await this.deps.calendarAccounts.isEnabled(
            account.username,
          );
          if (enabled) {
            try {
              const r = await syncCalendarEvents({
                account,
                store: this.deps.store,
                calendar: this.deps.calendar,
                clock: this.deps.clock,
              });
              await this.deps.store.appendSyncLog({
                ts: this.deps.clock.now(),
                account: account.username,
                source: "calendar",
                status: "ok",
                messagesAdded: r.added,
              });
              okCount += 1;
            } catch (err) {
              // Admin-consent rejection: one row per account per tick,
              // mirroring the Teams-channel hint pattern.
              const message = isConsentRequiredError(err)
                ? `Calendar scope not consented for tenant ${account.tenantId} — ask a tenant admin to grant: ${CALENDAR_SCOPES.join(", ")}`
                : errorToString(err);
              await this.deps.store.appendSyncLog({
                ts: this.deps.clock.now(),
                account: account.username,
                source: "calendar",
                status: "error",
                errorMessage: message,
              });
              errorCount += 1;
            }
          }
        }
        if (
          this.deps.transcripts !== undefined &&
          this.deps.calendarAccounts !== undefined
        ) {
          // Transcripts are gated on calendar being enabled too — a
          // transcripts_enabled=1 row with no calendar events synced would
          // just be dead weight, and syncTranscripts reads events off the
          // store that only calendar sync populates.
          const calendarEnabled = await this.deps.calendarAccounts.isEnabled(
            account.username,
          );
          const transcriptsEnabled =
            calendarEnabled &&
            (await this.deps.calendarAccounts.isTranscriptsEnabled(
              account.username,
            ));
          if (transcriptsEnabled) {
            try {
              const r = await syncTranscripts({
                account,
                store: this.deps.store,
                transcripts: this.deps.transcripts,
                clock: this.deps.clock,
              });
              await this.deps.store.appendSyncLog({
                ts: this.deps.clock.now(),
                account: account.username,
                source: "transcripts",
                status: "ok",
                messagesAdded: r.fetched,
              });
              okCount += 1;
            } catch (err) {
              const message = isConsentRequiredError(err)
                ? `Transcript scope not consented for tenant ${account.tenantId} — ask a tenant admin to grant: ${TRANSCRIPT_SCOPES.join(", ")}`
                : errorToString(err);
              await this.deps.store.appendSyncLog({
                ts: this.deps.clock.now(),
                account: account.username,
                source: "transcripts",
                status: "error",
                errorMessage: message,
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
