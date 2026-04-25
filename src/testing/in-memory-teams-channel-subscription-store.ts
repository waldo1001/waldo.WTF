import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import {
  validateSubscribeInput,
  type TeamsChannelSubscriptionStore,
} from "../store/teams-channel-subscription-store.js";
import {
  StoreError,
  type AddTeamsChannelSubscriptionInput,
  type TeamsChannelSubscription,
} from "../store/types.js";

function key(account: string, teamId: string, channelId: string): string {
  return `${account}\t${teamId}\t${channelId}`;
}

export class InMemoryTeamsChannelSubscriptionStore
  implements TeamsChannelSubscriptionStore
{
  private readonly subs = new Map<string, TeamsChannelSubscription>();

  constructor(private readonly clock: Clock = systemClock) {}

  async subscribe(
    input: AddTeamsChannelSubscriptionInput,
  ): Promise<TeamsChannelSubscription> {
    validateSubscribeInput(input);
    const k = key(input.account, input.teamId, input.channelId);
    if (this.subs.has(k)) {
      throw new StoreError(
        "conflict",
        `already subscribed: account=${input.account} team=${input.teamId} channel=${input.channelId}`,
      );
    }
    const sub: TeamsChannelSubscription = {
      account: input.account,
      ...(input.tenantId !== undefined && { tenantId: input.tenantId }),
      teamId: input.teamId,
      ...(input.teamName !== undefined && { teamName: input.teamName }),
      channelId: input.channelId,
      ...(input.channelName !== undefined && {
        channelName: input.channelName,
      }),
      enabled: true,
      subscribedAt: this.clock.now(),
    };
    this.subs.set(k, sub);
    return sub;
  }

  async unsubscribe(
    account: string,
    teamId: string,
    channelId: string,
  ): Promise<{ removed: boolean }> {
    return {
      removed: this.subs.delete(key(account, teamId, channelId)),
    };
  }

  async listForAccount(
    account: string,
  ): Promise<readonly TeamsChannelSubscription[]> {
    return [...this.subs.values()]
      .filter((s) => s.account === account)
      .sort((a, b) => {
        const t = a.subscribedAt.getTime() - b.subscribedAt.getTime();
        if (t !== 0) return t;
        const ti = a.teamId.localeCompare(b.teamId);
        if (ti !== 0) return ti;
        return a.channelId.localeCompare(b.channelId);
      });
  }

  async listEnabledForAccount(
    account: string,
  ): Promise<readonly TeamsChannelSubscription[]> {
    return (await this.listForAccount(account)).filter((s) => s.enabled);
  }

  async listAll(): Promise<readonly TeamsChannelSubscription[]> {
    return [...this.subs.values()].sort((a, b) => {
      const c = a.account.localeCompare(b.account);
      if (c !== 0) return c;
      const ti = a.teamId.localeCompare(b.teamId);
      if (ti !== 0) return ti;
      return a.channelId.localeCompare(b.channelId);
    });
  }

  async setCursor(
    account: string,
    teamId: string,
    channelId: string,
    at: Date,
  ): Promise<void> {
    const k = key(account, teamId, channelId);
    const cur = this.subs.get(k);
    if (cur === undefined) return;
    this.subs.set(k, { ...cur, lastCursorAt: at });
  }

  async toggleEnabled(
    account: string,
    teamId: string,
    channelId: string,
    enabled: boolean,
  ): Promise<TeamsChannelSubscription | null> {
    const k = key(account, teamId, channelId);
    const cur = this.subs.get(k);
    if (cur === undefined) return null;
    const updated: TeamsChannelSubscription = { ...cur, enabled };
    this.subs.set(k, updated);
    return updated;
  }
}
