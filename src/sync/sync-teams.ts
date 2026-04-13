import type { AuthClient } from "../auth/auth-client.js";
import type { Account } from "../auth/types.js";
import type { Clock } from "../clock.js";
import type { MessageStore } from "../store/message-store.js";
import type { ChatType, Message } from "../store/types.js";
import type {
  TeamsClient,
  TeamsMention,
  TeamsMessage,
} from "../sources/teams.js";

export const DEFAULT_TEAMS_DELTA_ENDPOINT = "/me/chats/getAllMessages/delta";

export interface SyncTeamsDeps {
  readonly account: Account;
  readonly auth: AuthClient;
  readonly teams: TeamsClient;
  readonly store: MessageStore;
  readonly clock: Clock;
  readonly deltaEndpoint?: string;
}

export interface SyncTeamsResult {
  readonly added: number;
  readonly removed: number;
}

const isRemoved = (m: TeamsMessage): boolean => m["@removed"] !== undefined;

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

const chatTypeOf = (t: TeamsMessage): ChatType | undefined => {
  if (t.channelIdentity && (t.channelIdentity.channelId || t.channelIdentity.teamId)) {
    return "channel";
  }
  return undefined;
};

const toMessage = (
  t: TeamsMessage,
  accountUsername: string,
  importedAt: Date,
): Message => {
  const user = t.from?.user;
  const body = t.body;
  const mentions = extractMentions(t.mentions);
  const chatType = chatTypeOf(t);
  return {
    id: `teams:${accountUsername}:${t.id}`,
    source: "teams",
    account: accountUsername,
    nativeId: t.id,
    sentAt: new Date(t.createdDateTime),
    importedAt,
    rawJson: JSON.stringify(t),
    ...(t.chatId !== undefined && { threadId: t.chatId }),
    ...(user?.displayName !== undefined && { senderName: user.displayName }),
    ...(user?.userPrincipalName !== undefined && {
      senderEmail: user.userPrincipalName,
    }),
    ...(body?.contentType === "text" &&
      body.content !== undefined && { body: body.content }),
    ...(body?.contentType === "html" &&
      body.content !== undefined && { bodyHtml: body.content }),
    ...(chatType !== undefined && { chatType }),
    ...(t.replyToId !== undefined &&
      t.replyToId !== null && { replyToId: t.replyToId }),
    ...(mentions !== undefined && { mentions }),
  };
};

export async function syncTeams(deps: SyncTeamsDeps): Promise<SyncTeamsResult> {
  const { account, auth, teams, store, clock } = deps;
  const token = await auth.getTokenSilent(account);

  const existing = await store.getSyncState(account.username, "teams");
  let url =
    existing?.deltaToken ?? deps.deltaEndpoint ?? DEFAULT_TEAMS_DELTA_ENDPOINT;

  let added = 0;
  let removed = 0;
  let finalDeltaLink: string | undefined;

  for (;;) {
    const res = await teams.getDelta(url, token.token);
    const importedAt = clock.now();
    const toUpsert: Message[] = [];
    const toDelete: string[] = [];
    for (const t of res.value) {
      if (isRemoved(t)) {
        toDelete.push(`teams:${account.username}:${t.id}`);
      } else {
        toUpsert.push(toMessage(t, account.username, importedAt));
      }
    }
    if (toUpsert.length > 0) {
      const r = await store.upsertMessages(toUpsert);
      added += r.added + r.updated;
    }
    if (toDelete.length > 0) {
      const r = await store.deleteMessages(toDelete);
      removed += r.deleted;
    }
    if (res["@odata.nextLink"]) {
      url = res["@odata.nextLink"];
      continue;
    }
    finalDeltaLink = res["@odata.deltaLink"];
    break;
  }

  await store.setSyncState({
    account: account.username,
    source: "teams",
    ...(finalDeltaLink !== undefined ? { deltaToken: finalDeltaLink } : {}),
    lastSyncAt: clock.now(),
  });

  return { added, removed };
}
