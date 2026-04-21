import type { AuthClient } from "../auth/auth-client.js";
import type { Account } from "../auth/types.js";
import type { Clock } from "../clock.js";
import type { MessageStore } from "../store/message-store.js";
import type { Message } from "../store/types.js";
import type { GraphClient, GraphMessage } from "../sources/graph.js";
import { htmlToText } from "../text/html-to-text.js";

export const DEFAULT_SENT_DELTA_ENDPOINT =
  "/me/mailFolders/sentitems/messages/delta";

export const SENT_FOLDER = "sentitems";

export interface SyncSentDeps {
  readonly account: Account;
  readonly auth: AuthClient;
  readonly graph: GraphClient;
  readonly store: MessageStore;
  readonly clock: Clock;
  readonly deltaEndpoint?: string;
  readonly backfillDays?: number;
}

export interface SyncSentResult {
  readonly added: number;
  readonly removed: number;
}

const isRemoved = (m: GraphMessage): boolean => m["@removed"] !== undefined;

const toSentMessage = (
  g: GraphMessage,
  accountUsername: string,
  importedAt: Date,
): Message => {
  const body = g.body;
  const base: Message = {
    id: `outlook:${accountUsername}:${g.id}`,
    source: "outlook",
    account: accountUsername,
    nativeId: g.id,
    sentAt: g.receivedDateTime ? new Date(g.receivedDateTime) : importedAt,
    importedAt,
    rawJson: JSON.stringify(g),
    fromMe: true,
    ...(g.conversationId !== undefined ? { threadId: g.conversationId } : {}),
    ...(g.subject !== null && g.subject !== undefined
      ? { threadName: g.subject }
      : {}),
  };
  // Sent-items drafts can arrive without a populated `from` field. The folder
  // is the source of truth for "from me", so synthesize the sender from the
  // account username so steering/search still have something to match on.
  const sender = g.from
    ? {
        senderName: g.from.emailAddress.name,
        senderEmail: g.from.emailAddress.address,
      }
    : { senderEmail: accountUsername };
  const bodyFields =
    body?.contentType === "text"
      ? { body: body.content }
      : body?.contentType === "html"
        ? { bodyHtml: body.content, body: htmlToText(body.content) }
        : {};
  return { ...base, ...sender, ...bodyFields };
};

export async function syncSent(deps: SyncSentDeps): Promise<SyncSentResult> {
  const { account, auth, graph, store, clock } = deps;
  const token = await auth.getTokenSilent(account);

  const existing = await store.getSyncState(
    account.username,
    "outlook",
    SENT_FOLDER,
  );
  const baseEndpoint = deps.deltaEndpoint ?? DEFAULT_SENT_DELTA_ENDPOINT;
  let url: string;
  if (existing?.deltaToken !== undefined) {
    url = existing.deltaToken;
  } else if (deps.backfillDays !== undefined) {
    const cutoff = new Date(
      clock.now().getTime() - deps.backfillDays * 86_400_000,
    ).toISOString();
    url = `${baseEndpoint}?$filter=${encodeURIComponent(`receivedDateTime ge ${cutoff}`)}`;
  } else {
    url = baseEndpoint;
  }

  let added = 0;
  let removed = 0;
  let finalDeltaLink: string | undefined;

  for (;;) {
    const res = await graph.getDelta(url, token.token);
    const importedAt = clock.now();
    const toUpsert: Message[] = [];
    const toDelete: string[] = [];
    for (const g of res.value) {
      if (isRemoved(g)) {
        toDelete.push(`outlook:${account.username}:${g.id}`);
      } else {
        toUpsert.push(toSentMessage(g, account.username, importedAt));
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
    source: "outlook",
    folder: SENT_FOLDER,
    ...(finalDeltaLink !== undefined ? { deltaToken: finalDeltaLink } : {}),
    lastSyncAt: clock.now(),
  });

  return { added, removed };
}
