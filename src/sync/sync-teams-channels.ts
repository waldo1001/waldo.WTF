import type { Account } from "../auth/types.js";
import type { Clock } from "../clock.js";
import type { Logger } from "../logger.js";
import type { MessageStore } from "../store/message-store.js";
import type { TeamsChannelSubscriptionStore } from "../store/teams-channel-subscription-store.js";
import type {
  ChatType,
  Message,
  TeamsChannelSubscription,
} from "../store/types.js";
import type { TeamsMention } from "../sources/teams.js";
import {
  GraphRateLimitedError,
  TokenExpiredError,
  type TeamsChannelClient,
  type TeamsChannelMessage,
} from "../sources/teams-channel.js";

export interface SyncTeamsChannelsDeps {
  readonly account: Account;
  readonly token: string;
  readonly client: TeamsChannelClient;
  readonly store: MessageStore;
  readonly subs: TeamsChannelSubscriptionStore;
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly backfillDays?: number;
}

export interface SyncTeamsChannelsSubResult {
  readonly teamId: string;
  readonly channelId: string;
  readonly added: number;
  readonly error?: string;
}

export interface SyncTeamsChannelsResult {
  readonly added: number;
  readonly removed: number;
  readonly perSubscription: readonly SyncTeamsChannelsSubResult[];
}

const isHardStop = (err: unknown): boolean =>
  err instanceof TokenExpiredError || err instanceof GraphRateLimitedError;

const truncateThreadName = (raw: string, max = 200): string =>
  raw.length > max ? raw.slice(0, max) : raw;

const stripHtml = (raw: string): string =>
  raw
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const snippetFromBody = (body: TeamsChannelMessage["body"]): string => {
  if (body === undefined || body.content === undefined) return "";
  const raw = body.contentType === "html" ? stripHtml(body.content) : body.content;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? oneLine.slice(0, 40) : oneLine;
};

const mentionToString = (m: TeamsMention): string | undefined => {
  const upn = m.mentioned?.user?.userPrincipalName;
  if (upn !== undefined && upn !== "") return upn;
  const name = m.mentioned?.user?.displayName;
  if (name !== undefined && name !== "") return name;
  if (m.mentionText !== undefined && m.mentionText !== "") return m.mentionText;
  return undefined;
};

const extractMentions = (
  mentions: readonly TeamsMention[] | undefined,
): readonly string[] | undefined => {
  if (mentions === undefined) return undefined;
  const out: string[] = [];
  for (const m of mentions) {
    const s = mentionToString(m);
    if (s !== undefined) out.push(s);
  }
  return out;
};

function buildThreadId(
  teamId: string,
  channelId: string,
  rootId: string,
): string {
  return `teams-channel:${teamId}:${channelId}:${rootId}`;
}

function buildThreadName(
  sub: TeamsChannelSubscription,
  rootSnippet: string | undefined,
): string | undefined {
  const team = sub.teamName;
  const channel = sub.channelName;
  if (team === undefined && channel === undefined) {
    return rootSnippet !== undefined && rootSnippet !== ""
      ? truncateThreadName(rootSnippet)
      : undefined;
  }
  const parts: string[] = [];
  if (team !== undefined) parts.push(team);
  if (channel !== undefined) parts.push(channel);
  if (rootSnippet !== undefined && rootSnippet !== "") parts.push(rootSnippet);
  return truncateThreadName(parts.join(" / "));
}

function channelMessageToMessage(
  m: TeamsChannelMessage,
  sub: TeamsChannelSubscription,
  rootSnippet: string | undefined,
  importedAt: Date,
): Message {
  const user = m.from?.user;
  const body = m.body;
  const mentions = extractMentions(m.mentions);
  const rootId = m.replyToId ?? m.id;
  const threadId = buildThreadId(sub.teamId, sub.channelId, rootId);
  const threadName = buildThreadName(sub, rootSnippet);
  const chatType: ChatType = "channel";
  const id = `teams-channel:${sub.account}:${sub.teamId}:${sub.channelId}:${m.id}`;
  return {
    id,
    source: "teams-channel",
    account: sub.account,
    nativeId: m.id,
    sentAt: new Date(m.createdDateTime),
    importedAt,
    rawJson: JSON.stringify(m),
    threadId,
    ...(threadName !== undefined && { threadName }),
    ...(user?.displayName !== undefined && { senderName: user.displayName }),
    ...(user?.userPrincipalName !== undefined && {
      senderEmail: user.userPrincipalName,
    }),
    ...(body?.contentType === "text" &&
      body.content !== undefined && { body: body.content }),
    ...(body?.contentType === "html" &&
      body.content !== undefined && { bodyHtml: body.content }),
    chatType,
    ...(m.replyToId !== undefined &&
      m.replyToId !== null && {
        replyToId: `teams-channel:${sub.account}:${sub.teamId}:${sub.channelId}:${m.replyToId}`,
      }),
    ...(mentions !== undefined && { mentions }),
  };
}

const cursorKey = (teamId: string, channelId: string): string =>
  `channel:${teamId}:${channelId}`;

interface FlattenedMessage {
  readonly message: TeamsChannelMessage;
  readonly rootSnippet: string | undefined;
}

function flattenPage(
  value: readonly TeamsChannelMessage[],
  logger: Logger | undefined,
  teamId: string,
  channelId: string,
): readonly FlattenedMessage[] {
  const out: FlattenedMessage[] = [];
  for (const root of value) {
    if (root["@removed"] !== undefined) continue;
    if (root.messageType !== undefined && root.messageType !== "message") {
      continue;
    }
    const rootSnippet = snippetFromBody(root.body);
    out.push({ message: root, rootSnippet });
    const replies = root.replies;
    if (replies !== undefined) {
      for (const r of replies) {
        if (r["@removed"] !== undefined) continue;
        if (r.messageType !== undefined && r.messageType !== "message") {
          continue;
        }
        out.push({ message: r, rootSnippet });
      }
      const total = root["replies@odata.count"];
      if (
        total !== undefined &&
        total > replies.length &&
        logger !== undefined
      ) {
        logger.info(
          `teams_channel_reply_clipped teamId=${teamId} channelId=${channelId} rootMessageId=${root.id} returned=${replies.length} total=${total}`,
        );
      }
    }
  }
  return out;
}

async function syncOneSubscription(deps: {
  client: TeamsChannelClient;
  token: string;
  sub: TeamsChannelSubscription;
  store: MessageStore;
  account: Account;
  clock: Clock;
  logger?: Logger;
  backfillDays?: number;
}): Promise<{ added: number }> {
  const {
    client,
    token,
    sub,
    store,
    account,
    clock,
    logger,
    backfillDays,
  } = deps;
  const key = cursorKey(sub.teamId, sub.channelId);
  const storedCursor = await store.getChatCursor(account.username, key);

  let added = 0;
  let nextLink: string | undefined;
  let pendingDeltaLink: string | undefined;
  let firstCall = true;

  const sinceIso =
    storedCursor === undefined && backfillDays !== undefined
      ? new Date(
          clock.now().getTime() - backfillDays * 86_400_000,
        ).toISOString()
      : undefined;

  for (;;) {
    const opts: {
      deltaLink?: string;
      nextLink?: string;
      sinceIso?: string;
    } = {};
    if (nextLink !== undefined) {
      opts.nextLink = nextLink;
    } else if (storedCursor !== undefined && firstCall) {
      opts.deltaLink = storedCursor;
    } else if (firstCall && sinceIso !== undefined) {
      opts.sinceIso = sinceIso;
    }
    firstCall = false;

    const page = await client.getChannelMessagesDelta(
      token,
      sub.teamId,
      sub.channelId,
      opts,
    );
    const importedAt = clock.now();
    const flat = flattenPage(page.value, logger, sub.teamId, sub.channelId);
    if (flat.length > 0) {
      const messages: Message[] = flat.map((f) =>
        channelMessageToMessage(f.message, sub, f.rootSnippet, importedAt),
      );
      const r = await store.upsertMessages(messages);
      added += r.added + r.updated;
    }

    const next = page["@odata.nextLink"];
    if (next !== undefined) {
      nextLink = next;
      continue;
    }

    const delta = page["@odata.deltaLink"];
    if (delta !== undefined) pendingDeltaLink = delta;
    break;
  }

  if (pendingDeltaLink !== undefined) {
    await store.setChatCursor({
      account: account.username,
      chatId: key,
      cursor: pendingDeltaLink,
    });
  }

  return { added };
}

export async function syncTeamsChannels(
  deps: SyncTeamsChannelsDeps,
): Promise<SyncTeamsChannelsResult> {
  const { account, token, client, store, subs, clock, logger, backfillDays } =
    deps;
  const enabled = await subs.listEnabledForAccount(account.username);
  if (enabled.length === 0) {
    return { added: 0, removed: 0, perSubscription: [] };
  }

  let added = 0;
  const perSubscription: SyncTeamsChannelsSubResult[] = [];
  for (const sub of enabled) {
    try {
      const callDeps: Parameters<typeof syncOneSubscription>[0] = {
        client,
        token,
        sub,
        store,
        account,
        clock,
      };
      if (logger !== undefined) callDeps.logger = logger;
      if (backfillDays !== undefined) callDeps.backfillDays = backfillDays;
      const r = await syncOneSubscription(callDeps);
      added += r.added;
      await subs.setCursor(
        account.username,
        sub.teamId,
        sub.channelId,
        clock.now(),
      );
      perSubscription.push({
        teamId: sub.teamId,
        channelId: sub.channelId,
        added: r.added,
      });
    } catch (err) {
      if (isHardStop(err)) throw err;
      perSubscription.push({
        teamId: sub.teamId,
        channelId: sub.channelId,
        added: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { added, removed: 0, perSubscription };
}
