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

// Yammer REST has no delta API. Instead of stale cursor pagination,
// each cycle re-fetches the most recently active threads and walks
// post pages backward until createdDateTime crosses this window.
// 24h is generous enough to bridge overnight outages and timezone
// spread across federated networks.
const VIVA_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;

const MAX_POST_PAGES_PER_THREAD = 50;

async function fetchPostsSince(
  viva: VivaClient,
  token: string,
  threadId: string,
  cutoff: Date,
): Promise<readonly VivaPost[]> {
  const cutoffMs = cutoff.getTime();
  const out: VivaPost[] = [];
  let olderThan: string | undefined;
  for (let page = 0; page < MAX_POST_PAGES_PER_THREAD; page++) {
    const opts = olderThan !== undefined ? { olderThan } : {};
    const result = await viva.listPosts(token, threadId, opts);
    if (result.value.length === 0) break;
    let crossed = false;
    for (const p of result.value) {
      if (new Date(p.createdDateTime).getTime() < cutoffMs) {
        crossed = true;
        continue;
      }
      out.push(p);
    }
    if (crossed) break;
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
  clock: Clock;
}): Promise<{ added: number }> {
  const { viva, token, sub, store, clock } = deps;
  const now = clock.now();
  const cutoff = new Date(now.getTime() - VIVA_SYNC_WINDOW_MS);

  const page = await viva.listThreads(token, sub.communityId, {});

  let added = 0;
  for (const thread of page.value) {
    const posts = await fetchPostsSince(viva, token, thread.id, cutoff);
    if (posts.length === 0) continue;
    const messages = posts.map((p) => postToMessage(p, sub, thread, now));
    const r = await store.upsertMessages(messages);
    added += r.added;
  }
  return { added };
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
  // Same-tick self-heal: MSAL holds a stale-but-unexpired AT for the
  // Yammer-clientId partition after tenant-consent churn or deploy. One
  // forceRefresh request mints a new AT; replace the per-run cache so
  // later subs in the same tenant reuse it. Failure here is always an
  // MSAL-side AuthError (token endpoint unreachable, refresh token
  // revoked, etc.) — it cannot be a Yammer TokenExpiredError /
  // GraphRateLimitedError, because those live in the HTTP-to-Yammer
  // layer, not in MSAL.
  const forceRefreshTokenForTenant = async (
    tenantId: string,
  ): Promise<AccessToken | Error> => {
    try {
      const tok = await auth.getTokenSilent(account, {
        scopes: [YAMMER_SCOPE],
        authority: vivaAuthorityFor(tenantId),
        forceRefresh: true,
      });
      tokenCache.set(tenantId, tok);
      return tok;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  };

  let added = 0;
  const perCommunity: SyncVivaCommunityResult[] = [];
  const recordSuccess = (
    sub: VivaSubscription,
    res: { added: number },
  ): void => {
    added += res.added;
    perCommunity.push({ communityId: sub.communityId, added: res.added });
  };
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
        clock,
      });
      recordSuccess(sub, res);
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        const fresh = await forceRefreshTokenForTenant(tenantId);
        if (fresh instanceof Error) {
          perCommunity.push({
            communityId: sub.communityId,
            added: 0,
            error: fresh.message,
          });
          continue;
        }
        try {
          const retryRes = await syncOneCommunity({
            viva,
            token: fresh.token,
            sub,
            store,
            clock,
          });
          recordSuccess(sub, retryRes);
        } catch (retryErr) {
          // 429 still aborts the whole pass (Retry-After contract).
          // A second 401 is treated as a genuine per-community failure.
          if (retryErr instanceof GraphRateLimitedError) throw retryErr;
          perCommunity.push({
            communityId: sub.communityId,
            added: 0,
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
        }
        continue;
      }
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
