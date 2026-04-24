import type { AuthClient } from "../auth/auth-client.js";
import { vivaAuthorityFor, YAMMER_SCOPE } from "../auth/msal-auth-client.js";
import type { Account, AccessToken } from "../auth/types.js";
import type { Clock } from "../clock.js";
import type { MessageStore } from "../store/message-store.js";
import type { VivaSubscriptionStore } from "../store/viva-subscription-store.js";
import type { Message, VivaSubscription } from "../store/types.js";
import {
  GraphRateLimitedError,
  TokenExpiredError,
  type VivaClient,
  type VivaPost,
  type VivaThread,
} from "../sources/viva.js";

export interface SyncVivaDeps {
  readonly account: Account;
  readonly auth: AuthClient;
  readonly viva: VivaClient;
  readonly store: MessageStore;
  readonly subs: VivaSubscriptionStore;
  readonly clock: Clock;
}

export interface SyncVivaCommunityResult {
  readonly communityId: string;
  readonly added: number;
  readonly error?: string;
}

export interface SyncVivaResult {
  readonly added: number;
  readonly removed: number;
  readonly perCommunity: readonly SyncVivaCommunityResult[];
}

const isHardStop = (err: unknown): boolean =>
  err instanceof TokenExpiredError || err instanceof GraphRateLimitedError;

const truncateThreadName = (raw: string, max = 200): string =>
  raw.length > max ? raw.slice(0, max) : raw;

function buildThreadId(sub: VivaSubscription, conversationId: string): string {
  return `viva:${sub.networkId}:${sub.communityId}:${conversationId}`;
}

function buildThreadName(
  sub: VivaSubscription,
  thread: VivaThread,
): string | undefined {
  const community = sub.communityName;
  const topic = thread.topic ?? undefined;
  if (community === undefined && (topic === undefined || topic === "")) {
    return undefined;
  }
  if (community !== undefined && topic !== undefined && topic !== "") {
    return truncateThreadName(`${community} / ${topic}`);
  }
  if (community !== undefined) return truncateThreadName(community);
  return truncateThreadName(topic ?? "");
}

function postToMessage(
  p: VivaPost,
  sub: VivaSubscription,
  thread: VivaThread,
  importedAt: Date,
): Message {
  const user = p.from?.user;
  const body = p.body;
  const threadName = buildThreadName(sub, thread);
  return {
    id: `viva-engage:${sub.account}:${p.id}`,
    source: "viva-engage",
    account: sub.account,
    nativeId: p.id,
    sentAt: new Date(p.createdDateTime),
    importedAt,
    rawJson: JSON.stringify(p),
    threadId: buildThreadId(sub, p.conversationId),
    ...(threadName !== undefined && { threadName }),
    ...(user?.displayName !== undefined && { senderName: user.displayName }),
    ...(user?.userPrincipalName !== undefined && {
      senderEmail: user.userPrincipalName,
    }),
    ...(body?.contentType === "text" &&
      body.content !== undefined && { body: body.content }),
    ...(body?.contentType === "html" &&
      body.content !== undefined && { bodyHtml: body.content }),
    chatType: "group",
  };
}

const MAX_PAGES_PER_WALK = 50;

async function listThreadsForCommunity(
  viva: VivaClient,
  token: string,
  communityId: string,
  sinceDate: Date | undefined,
): Promise<readonly VivaThread[]> {
  const out: VivaThread[] = [];
  let olderThan: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_WALK; page++) {
    const result = await viva.listThreads(token, communityId, { olderThan });
    if (result.value.length === 0) break;
    for (const t of result.value) out.push(t);
    if (sinceDate !== undefined) {
      const oldest = result.value.reduce((min, t) => {
        const ts = t.lastPostedDateTime ?? "";
        return ts < (min.lastPostedDateTime ?? "") ? t : min;
      }, result.value[0]!);
      if (
        oldest.lastPostedDateTime !== undefined &&
        new Date(oldest.lastPostedDateTime).getTime() <= sinceDate.getTime()
      ) {
        break;
      }
    }
    if (result.olderThanCursor === undefined) break;
    olderThan = result.olderThanCursor;
  }
  return out;
}

async function listPostsForThread(
  viva: VivaClient,
  token: string,
  threadId: string,
  sinceDate?: Date | undefined,
): Promise<readonly VivaPost[]> {
  const out: VivaPost[] = [];
  let olderThan: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_WALK; page++) {
    const result = await viva.listPosts(token, threadId, { olderThan });
    if (result.value.length === 0) break;
    for (const p of result.value) out.push(p);
    if (sinceDate !== undefined) {
      const oldest = result.value.reduce((min, p) =>
        p.createdDateTime < min.createdDateTime ? p : min,
      );
      if (new Date(oldest.createdDateTime).getTime() <= sinceDate.getTime()) {
        break;
      }
    }
    if (result.olderThanCursor === undefined) break;
    olderThan = result.olderThanCursor;
  }
  return out;
}

async function syncOneCommunity(deps: {
  viva: VivaClient;
  token: string;
  sub: VivaSubscription;
  store: MessageStore;
  subs: VivaSubscriptionStore;
  clock: Clock;
}): Promise<{ added: number; newCursor: Date | undefined }> {
  const { viva, token, sub, store, clock } = deps;
  const threads = await listThreadsForCommunity(
    viva,
    token,
    sub.communityId,
    sub.lastCursorAt,
  );

  let added = 0;
  let highWater: Date | undefined = sub.lastCursorAt;
  const importedAt = clock.now();
  for (const thread of threads) {
    const posts = await listPostsForThread(viva, token, thread.id, sub.lastCursorAt);
    if (posts.length === 0) continue;
    const messages = posts.map((p) => postToMessage(p, sub, thread, importedAt));
    const r = await store.upsertMessages(messages);
    added += r.added + r.updated;
    for (const p of posts) {
      const ts = new Date(p.createdDateTime);
      if (highWater === undefined || ts.getTime() > highWater.getTime()) {
        highWater = ts;
      }
    }
  }
  return { added, newCursor: highWater };
}

export async function syncViva(deps: SyncVivaDeps): Promise<SyncVivaResult> {
  const { account, auth, viva, store, subs, clock } = deps;
  const enabled = await subs.listEnabledForAccount(account.username);

  const tokenCache = new Map<string, AccessToken | Error>();
  const getTokenForTenant = async (
    tenantId: string,
  ): Promise<AccessToken | Error> => {
    const cached = tokenCache.get(tenantId);
    if (cached !== undefined) return cached;
    try {
      const tok = await auth.getTokenSilent(account, {
        scopes: [YAMMER_SCOPE],
        authority: vivaAuthorityFor(tenantId),
      });
      tokenCache.set(tenantId, tok);
      return tok;
    } catch (err) {
      if (isHardStop(err)) throw err;
      const e = err instanceof Error ? err : new Error(String(err));
      tokenCache.set(tenantId, e);
      return e;
    }
  };

  let added = 0;
  const perCommunity: SyncVivaCommunityResult[] = [];
  for (const sub of enabled) {
    const tenantId = sub.tenantId ?? account.tenantId;
    const tokResult = await getTokenForTenant(tenantId);
    if (tokResult instanceof Error) {
      perCommunity.push({
        communityId: sub.communityId,
        added: 0,
        error: tokResult.message,
      });
      continue;
    }
    try {
      const res = await syncOneCommunity({
        viva,
        token: tokResult.token,
        sub,
        store,
        subs,
        clock,
      });
      added += res.added;
      if (
        res.newCursor !== undefined &&
        (sub.lastCursorAt === undefined ||
          res.newCursor.getTime() > sub.lastCursorAt.getTime())
      ) {
        await subs.setCursor(account.username, sub.communityId, res.newCursor);
      }
      perCommunity.push({ communityId: sub.communityId, added: res.added });
    } catch (err) {
      if (isHardStop(err)) throw err;
      perCommunity.push({
        communityId: sub.communityId,
        added: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await store.setSyncState({
    account: account.username,
    source: "viva-engage",
    lastSyncAt: clock.now(),
  });

  return { added, removed: 0, perCommunity };
}
