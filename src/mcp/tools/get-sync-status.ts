import type { Clock } from "../../clock.js";
import type { MessageStore } from "../../store/message-store.js";
import type {
  MessageSource,
  SyncLogStatus,
  SyncStatusRow,
} from "../../store/types.js";

export const STALE_THRESHOLD_MS = 15 * 60 * 1000;

export interface SyncStatusRowView {
  readonly account: string;
  readonly source: MessageSource;
  readonly lastSyncAt?: string;
  readonly lastOkAt?: string;
  readonly lastStatus?: SyncLogStatus;
  readonly lastError?: string;
  readonly messagesAddedLastOk?: number;
  readonly messagesAddedLast24h: number;
  readonly stale: boolean;
}

export interface GetSyncStatusResult {
  readonly generatedAt: string;
  readonly accountsTracked: number;
  readonly staleCount: number;
  readonly rows: readonly SyncStatusRowView[];
}

export const GET_SYNC_STATUS_TOOL = {
  name: "get_sync_status",
  description: [
    "Return a per-(account, source) health snapshot of the sync loop: last sync, last ok, last error, and messages added in the last 24h. Read-only.",
    "",
    'This tool reports health of tracked account/source pairs — it is NOT an authoritative inventory of which sources exist in the lake. Some sources (e.g. whatsapp-local) may be ingested through mechanisms that don\'t appear as rows here. To verify whether a source has data, call get_recent_activity with sources: ["<source>"] directly. Do not tell the user "source X is not synced" based on this tool alone.',
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
} as const;

export async function handleGetSyncStatus(
  store: MessageStore,
  clock: Clock,
): Promise<GetSyncStatusResult> {
  const now = clock.now();
  const rows = await store.getSyncStatus(now);
  const views = rows.map((r) => project(r, now));
  const accounts = new Set(views.map((v) => v.account));
  const staleCount = views.reduce((n, v) => n + (v.stale ? 1 : 0), 0);
  return {
    generatedAt: now.toISOString(),
    accountsTracked: accounts.size,
    staleCount,
    rows: views,
  };
}

function project(r: SyncStatusRow, now: Date): SyncStatusRowView {
  const stale =
    r.lastOkAt === undefined ||
    now.getTime() - r.lastOkAt.getTime() > STALE_THRESHOLD_MS;
  return {
    account: r.account,
    source: r.source,
    ...(r.lastSyncAt !== undefined && {
      lastSyncAt: r.lastSyncAt.toISOString(),
    }),
    ...(r.lastOkAt !== undefined && { lastOkAt: r.lastOkAt.toISOString() }),
    ...(r.lastStatus !== undefined && { lastStatus: r.lastStatus }),
    ...(r.lastError !== undefined && { lastError: r.lastError }),
    ...(r.messagesAddedLastOk !== undefined && {
      messagesAddedLastOk: r.messagesAddedLastOk,
    }),
    messagesAddedLast24h: r.messagesAddedLast24h,
    stale,
  };
}
