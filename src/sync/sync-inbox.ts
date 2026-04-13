import type { AuthClient } from "../auth/auth-client.js";
import type { Account } from "../auth/types.js";
import type { Clock } from "../clock.js";
import type { MessageStore } from "../store/message-store.js";
import type { Message } from "../store/types.js";
import type { GraphClient, GraphMessage } from "../sources/graph.js";

export const DEFAULT_INBOX_DELTA_ENDPOINT =
  "/me/mailFolders/inbox/messages/delta";

export interface SyncInboxDeps {
  readonly account: Account;
  readonly auth: AuthClient;
  readonly graph: GraphClient;
  readonly store: MessageStore;
  readonly clock: Clock;
  readonly deltaEndpoint?: string;
}

export interface SyncInboxResult {
  readonly added: number;
  readonly removed: number;
}

const isRemoved = (m: GraphMessage): boolean => m["@removed"] !== undefined;

const toMessage = (
  g: GraphMessage,
  accountUsername: string,
  importedAt: Date,
): Message => {
  const body = g.body;
  const msg: Message = {
    id: `outlook:${accountUsername}:${g.id}`,
    source: "outlook",
    account: accountUsername,
    nativeId: g.id,
    sentAt: new Date(g.receivedDateTime),
    importedAt,
  };
  if (g.from) {
    return {
      ...msg,
      senderName: g.from.emailAddress.name,
      senderEmail: g.from.emailAddress.address,
      ...(body?.contentType === "text" ? { body: body.content } : {}),
      ...(body?.contentType === "html" ? { bodyHtml: body.content } : {}),
    };
  }
  return msg;
};

export async function syncInbox(deps: SyncInboxDeps): Promise<SyncInboxResult> {
  const { account, auth, graph, store, clock } = deps;
  const token = await auth.getTokenSilent(account);

  const existing = await store.getSyncState(account.username, "outlook");
  let url =
    existing?.deltaToken ?? deps.deltaEndpoint ?? DEFAULT_INBOX_DELTA_ENDPOINT;

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
        toUpsert.push(toMessage(g, account.username, importedAt));
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
    ...(finalDeltaLink !== undefined ? { deltaToken: finalDeltaLink } : {}),
    lastSyncAt: clock.now(),
  });

  return { added, removed };
}
