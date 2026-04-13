import type { AuthClient } from "../auth/auth-client.js";
import type { Account } from "../auth/types.js";
import type { Clock } from "../clock.js";
import type { MessageStore } from "../store/message-store.js";
import type { ChatType, Message } from "../store/types.js";
import {
  GraphRateLimitedError,
  TokenExpiredError,
  type TeamsChat,
  type TeamsClient,
  type TeamsMention,
  type TeamsMessage,
} from "../sources/teams.js";

export interface SyncTeamsDeps {
  readonly account: Account;
  readonly auth: AuthClient;
  readonly teams: TeamsClient;
  readonly store: MessageStore;
  readonly clock: Clock;
  readonly backfillDays?: number;
}

export interface SyncTeamsResult {
  readonly added: number;
  readonly removed: number;
}

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

const chatTypeFromChat = (c: TeamsChat): ChatType | undefined => {
  if (c.chatType === "oneOnOne") return "oneOnOne";
  if (c.chatType === "group") return "group";
  return undefined;
};

const toMessage = (
  t: TeamsMessage,
  chat: TeamsChat,
  accountUsername: string,
  importedAt: Date,
): Message => {
  const user = t.from?.user;
  const body = t.body;
  const mentions = extractMentions(t.mentions);
  const chatType = chatTypeFromChat(chat);
  const threadId = t.chatId ?? chat.id;
  const threadName = chat.topic ?? undefined;
  return {
    id: `teams:${accountUsername}:${t.id}`,
    source: "teams",
    account: accountUsername,
    nativeId: t.id,
    sentAt: new Date(t.createdDateTime),
    importedAt,
    rawJson: JSON.stringify(t),
    ...(threadId !== undefined && { threadId }),
    ...(threadName !== undefined &&
      threadName !== null && { threadName }),
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

const messageTimestamp = (t: TeamsMessage): string => {
  // lastModifiedDateTime is the cursor key but TeamsMessage may not carry it;
  // fall back to createdDateTime which is always present.
  const lm = (t as { lastModifiedDateTime?: string }).lastModifiedDateTime;
  return lm ?? t.createdDateTime;
};

const isHardStop = (err: unknown): boolean =>
  err instanceof TokenExpiredError || err instanceof GraphRateLimitedError;

async function listAllChats(
  teams: TeamsClient,
  token: string,
): Promise<TeamsChat[]> {
  const out: TeamsChat[] = [];
  let nextLink: string | undefined;
  for (;;) {
    const page: Awaited<ReturnType<TeamsClient["listChats"]>> =
      nextLink === undefined
        ? await teams.listChats(token)
        : await teams.listChats(token, nextLink);
    for (const c of page.value) out.push(c);
    const next = page["@odata.nextLink"];
    if (next === undefined) return out;
    nextLink = next;
  }
}

async function syncOneChat(deps: {
  teams: TeamsClient;
  token: string;
  chat: TeamsChat;
  store: MessageStore;
  account: Account;
  clock: Clock;
  initialSinceIso: string | undefined;
}): Promise<{ added: number; newCursor: string | undefined }> {
  const { teams, token, chat, store, account, clock, initialSinceIso } = deps;
  const storedCursor = await store.getChatCursor(account.username, chat.id);
  const sinceIso = storedCursor ?? initialSinceIso;

  let added = 0;
  let highWater: string | undefined = storedCursor;
  let nextLink: string | undefined;
  for (;;) {
    const page = nextLink === undefined
      ? await teams.getChatMessages(token, chat.id, { ...(sinceIso !== undefined && { sinceIso }) })
      : await teams.getChatMessages(token, chat.id, { nextLink });
    const importedAt = clock.now();
    const toUpsert: Message[] = [];
    for (const t of page.value) {
      if (t["@removed"] !== undefined) continue;
      toUpsert.push(toMessage(t, chat, account.username, importedAt));
      const ts = messageTimestamp(t);
      if (highWater === undefined || ts > highWater) highWater = ts;
    }
    if (toUpsert.length > 0) {
      const r = await store.upsertMessages(toUpsert);
      added += r.added + r.updated;
    }
    const next = page["@odata.nextLink"];
    if (next === undefined) break;
    nextLink = next;
  }

  return { added, newCursor: highWater };
}

export async function syncTeams(deps: SyncTeamsDeps): Promise<SyncTeamsResult> {
  const { account, auth, teams, store, clock } = deps;
  const token = await auth.getTokenSilent(account);

  const initialSinceIso =
    deps.backfillDays !== undefined
      ? new Date(clock.now().getTime() - deps.backfillDays * 86_400_000)
          .toISOString()
      : undefined;

  const chats = await listAllChats(teams, token.token);

  let added = 0;
  for (const chat of chats) {
    try {
      const res = await syncOneChat({
        teams,
        token: token.token,
        chat,
        store,
        account,
        clock,
        initialSinceIso,
      });
      added += res.added;
      if (res.newCursor !== undefined) {
        await store.setChatCursor({
          account: account.username,
          chatId: chat.id,
          cursor: res.newCursor,
        });
      }
    } catch (err) {
      if (isHardStop(err)) throw err;
      // Per-chat isolation: other errors are swallowed so one bad chat
      // doesn't block the tick. The sync-log row from the scheduler still
      // reports success for the source; individual chat failures will
      // retry on the next tick with the same (unchanged) cursor.
    }
  }

  await store.setSyncState({
    account: account.username,
    source: "teams",
    lastSyncAt: clock.now(),
  });

  return { added, removed: 0 };
}
