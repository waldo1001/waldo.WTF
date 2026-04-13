import type { Clock } from "../../clock.js";
import type { MessageStore } from "../../store/message-store.js";
import type { AccountRecord } from "../../store/types.js";

export interface ProjectedAccount {
  readonly username: string;
  readonly displayName?: string;
  readonly addedAt: string;
}

export interface ListAccountsResult {
  readonly count: number;
  readonly accounts: readonly ProjectedAccount[];
}

export const LIST_ACCOUNTS_TOOL = {
  name: "list_accounts",
  description:
    "Return every account Waldo has been logged into. Use this to enumerate available mailboxes before calling other tools. Read-only.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
} as const;

export async function handleListAccounts(
  store: MessageStore,
  _clock: Clock,
): Promise<ListAccountsResult> {
  const rows = await store.listAccounts();
  return {
    count: rows.length,
    accounts: rows.map(project),
  };
}

function project(a: AccountRecord): ProjectedAccount {
  return {
    username: a.username,
    ...(a.displayName !== undefined && { displayName: a.displayName }),
    addedAt: a.addedAt.toISOString(),
  };
}
