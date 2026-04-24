import type { Clock } from "../../clock.js";
import type { MessageStore } from "../../store/message-store.js";
import type { VivaSubscriptionStore } from "../../store/viva-subscription-store.js";
import type {
  MessageSource,
  SyncLogEntry,
  SyncStatusRow,
  VivaSubscription,
} from "../../store/types.js";
import {
  classifyError,
  extractRetryAfterSeconds,
  type FindingCategory,
} from "./classify-error.js";
import {
  buildRemediationPrompt,
  redactSecretsFromError,
} from "./remediation-prompts.js";

export const STALE_WARN_THRESHOLD_MS = 15 * 60 * 1000;
export const STALE_ERROR_THRESHOLD_MS = 6 * 60 * 60 * 1000;
export const REPEATED_FAILURE_WARN_N = 3;
export const REPEATED_FAILURE_ERROR_N = 5;
export const VIVA_DRIFT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const VIVA_SUB_GRACE_MS = 24 * 60 * 60 * 1000;
const SYNC_LOG_FETCH_LIMIT = 500;

export type FindingSeverity = "info" | "warn" | "error";

export interface Finding {
  readonly id: string;
  readonly category: FindingCategory;
  readonly severity: FindingSeverity;
  readonly account: string;
  readonly source?: MessageSource;
  readonly summary: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly remediationPrompt: string;
  readonly remediationCli?: string;
}

export interface DiagnoseSyncHealthResult {
  readonly generatedAt: string;
  readonly overallStatus: "healthy" | "degraded" | "critical";
  readonly summary: {
    readonly totalFindings: number;
    readonly byCategory: Record<FindingCategory, number>;
    readonly bySeverity: Record<FindingSeverity, number>;
  };
  readonly findings: readonly Finding[];
}

export const DIAGNOSE_SYNC_HEALTH_TOOL = {
  name: "diagnose_sync_health",
  description: [
    "Return a ranked list of sync-health findings across accounts and sources.",
    "Read-only: no writes, no external calls. Each finding carries a paste-ready remediation prompt.",
    "Categories: auth, rate-limit, delta-invalid, stale, repeated-failure, viva-sub-drift, never-synced, unknown-error.",
    "Severity: info | warn | error. overallStatus rolls up to healthy | degraded | critical.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
} as const;

export async function handleDiagnoseSyncHealth(
  store: MessageStore,
  vivaSubs: VivaSubscriptionStore | undefined,
  clock: Clock,
): Promise<DiagnoseSyncHealthResult> {
  const now = clock.now();
  const rows = await store.getSyncStatus(now);
  const logs = await store.getSyncLogRecent(SYNC_LOG_FETCH_LIMIT);
  const accounts = await store.listAccounts();
  const subs = vivaSubs !== undefined ? await vivaSubs.listAll() : [];

  const findings: Finding[] = [];

  for (const row of rows) {
    const finding = findingForPair(row, logs, now);
    if (finding !== null) {
      findings.push(finding);
    }
  }

  for (const account of accounts) {
    const hasActivity =
      rows.some((r) => r.account === account.username) ||
      logs.some((l) => l.account === account.username);
    if (!hasActivity) {
      findings.push(neverSyncedFinding(account.username));
    }
  }

  for (const sub of subs) {
    if (!sub.enabled) continue;
    if (now.getTime() - sub.subscribedAt.getTime() < VIVA_SUB_GRACE_MS) {
      continue;
    }
    const lastOk = logs.find(
      (l) =>
        l.account === sub.account &&
        l.source === "viva-engage" &&
        l.status === "ok" &&
        now.getTime() - l.ts.getTime() < VIVA_DRIFT_WINDOW_MS,
    );
    if (lastOk !== undefined) continue;
    findings.push(vivaDriftFinding(sub));
  }

  findings.sort(sortFindings);

  const byCategory: Record<FindingCategory, number> = {
    auth: 0,
    "rate-limit": 0,
    "delta-invalid": 0,
    stale: 0,
    "repeated-failure": 0,
    "viva-sub-drift": 0,
    "never-synced": 0,
    "unknown-error": 0,
  };
  const bySeverity: Record<FindingSeverity, number> = {
    info: 0,
    warn: 0,
    error: 0,
  };
  for (const f of findings) {
    byCategory[f.category]++;
    bySeverity[f.severity]++;
  }
  const overallStatus: DiagnoseSyncHealthResult["overallStatus"] =
    bySeverity.error > 0
      ? "critical"
      : bySeverity.warn > 0
        ? "degraded"
        : "healthy";

  return {
    generatedAt: now.toISOString(),
    overallStatus,
    summary: {
      totalFindings: findings.length,
      byCategory,
      bySeverity,
    },
    findings,
  };
}

function findingForPair(
  row: SyncStatusRow,
  logs: readonly SyncLogEntry[],
  now: Date,
): Finding | null {
  if (row.lastStatus === "error") {
    const rawErr = row.lastError ?? "";
    const baseCategory = classifyError(rawErr);
    const consecutive = countConsecutiveTrailingErrors(
      logs,
      row.account,
      row.source,
    );
    let category: FindingCategory = baseCategory;
    if (category === "unknown-error" && consecutive >= REPEATED_FAILURE_WARN_N) {
      category = "repeated-failure";
    }
    switch (category) {
      case "auth":
        return authFinding(row, rawErr);
      case "delta-invalid":
        return deltaInvalidFinding(row, rawErr);
      case "rate-limit":
        return rateLimitFinding(row, rawErr);
      case "repeated-failure":
        return repeatedFailureFinding(row, rawErr, consecutive);
      default:
        return unknownErrorFinding(row, rawErr);
    }
  }
  if (row.lastOkAt !== undefined) {
    const staleMs = now.getTime() - row.lastOkAt.getTime();
    if (staleMs > STALE_WARN_THRESHOLD_MS) {
      return staleFinding(row, staleMs);
    }
  }
  return null;
}

function countConsecutiveTrailingErrors(
  logs: readonly SyncLogEntry[],
  account: string,
  source: MessageSource,
): number {
  const forPair = logs.filter(
    (l) => l.account === account && l.source === source,
  );
  let n = 0;
  for (const l of forPair) {
    if (l.status === "error") n++;
    else break;
  }
  return n;
}

function authFinding(row: SyncStatusRow, rawErr: string): Finding {
  const safeErr = redactSecretsFromError(rawErr);
  return {
    id: `auth:${row.account}:${row.source}`,
    category: "auth",
    severity: "error",
    account: row.account,
    source: row.source,
    summary: `Auth failure for ${row.account} on ${row.source}: token expired or rejected.`,
    evidence: {
      account: row.account,
      source: row.source,
      lastError: safeErr,
    },
    remediationPrompt: buildRemediationPrompt({
      category: "auth",
      account: row.account,
      source: row.source,
      lastError: rawErr,
    }),
    remediationCli: `tsx src/cli.ts --add-account`,
  };
}

function deltaInvalidFinding(row: SyncStatusRow, rawErr: string): Finding {
  const safeErr = redactSecretsFromError(rawErr);
  return {
    id: `delta-invalid:${row.account}:${row.source}`,
    category: "delta-invalid",
    severity: "error",
    account: row.account,
    source: row.source,
    summary: `Delta cursor invalid for ${row.account} on ${row.source}: full resync needed.`,
    evidence: {
      account: row.account,
      source: row.source,
      lastError: safeErr,
    },
    remediationPrompt: buildRemediationPrompt({
      category: "delta-invalid",
      account: row.account,
      source: row.source,
      lastError: rawErr,
    }),
  };
}

function rateLimitFinding(row: SyncStatusRow, rawErr: string): Finding {
  const safeErr = redactSecretsFromError(rawErr);
  const retryAfterSeconds = extractRetryAfterSeconds(rawErr);
  const evidence: Record<string, unknown> = {
    account: row.account,
    source: row.source,
    lastError: safeErr,
  };
  if (retryAfterSeconds !== undefined) {
    evidence["retryAfterSeconds"] = retryAfterSeconds;
  }
  return {
    id: `rate-limit:${row.account}:${row.source}`,
    category: "rate-limit",
    severity: "warn",
    account: row.account,
    source: row.source,
    summary: `Rate-limited on ${row.source} for ${row.account}${retryAfterSeconds !== undefined ? ` (retry after ${retryAfterSeconds}s)` : ""}.`,
    evidence,
    remediationPrompt: buildRemediationPrompt({
      category: "rate-limit",
      account: row.account,
      source: row.source,
      lastError: rawErr,
      ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
    }),
  };
}

function repeatedFailureFinding(
  row: SyncStatusRow,
  rawErr: string,
  consecutive: number,
): Finding {
  const safeErr = redactSecretsFromError(rawErr);
  const severity: FindingSeverity =
    consecutive >= REPEATED_FAILURE_ERROR_N ? "error" : "warn";
  return {
    id: `repeated-failure:${row.account}:${row.source}`,
    category: "repeated-failure",
    severity,
    account: row.account,
    source: row.source,
    summary: `${consecutive} consecutive failures for ${row.account} on ${row.source}.`,
    evidence: {
      account: row.account,
      source: row.source,
      consecutiveFailures: consecutive,
      lastError: safeErr,
    },
    remediationPrompt: buildRemediationPrompt({
      category: "repeated-failure",
      account: row.account,
      source: row.source,
      consecutiveFailures: consecutive,
      lastError: rawErr,
    }),
  };
}

function staleFinding(row: SyncStatusRow, staleMs: number): Finding {
  const severity: FindingSeverity =
    staleMs > STALE_ERROR_THRESHOLD_MS ? "error" : "warn";
  const lastOkAt = row.lastOkAt?.toISOString();
  const evidence: Record<string, unknown> = {
    account: row.account,
    source: row.source,
    staleMs,
  };
  if (lastOkAt !== undefined) evidence["lastOkAt"] = lastOkAt;
  return {
    id: `stale:${row.account}:${row.source}`,
    category: "stale",
    severity,
    account: row.account,
    source: row.source,
    summary: `Stale sync for ${row.account} on ${row.source}: last ok ${Math.round(staleMs / 60000)} min ago.`,
    evidence,
    remediationPrompt: buildRemediationPrompt({
      category: "stale",
      account: row.account,
      source: row.source,
      staleMs,
      ...(lastOkAt !== undefined && { lastOkAt }),
    }),
  };
}

function unknownErrorFinding(row: SyncStatusRow, rawErr: string): Finding {
  const safeErr = redactSecretsFromError(rawErr);
  return {
    id: `unknown-error:${row.account}:${row.source}`,
    category: "unknown-error",
    severity: "warn",
    account: row.account,
    source: row.source,
    summary: `Unclassified error for ${row.account} on ${row.source}.`,
    evidence: {
      account: row.account,
      source: row.source,
      lastError: safeErr,
    },
    remediationPrompt: buildRemediationPrompt({
      category: "unknown-error",
      account: row.account,
      source: row.source,
      lastError: rawErr,
    }),
  };
}

function neverSyncedFinding(account: string): Finding {
  return {
    id: `never-synced:${account}`,
    category: "never-synced",
    severity: "warn",
    account,
    summary: `${account} has not yet been synced.`,
    evidence: {
      account,
    },
    remediationPrompt: buildRemediationPrompt({
      category: "never-synced",
      account,
    }),
  };
}

function vivaDriftFinding(sub: VivaSubscription): Finding {
  const external = sub.tenantId !== undefined;
  const evidence: Record<string, unknown> = {
    account: sub.account,
    communityId: sub.communityId,
  };
  if (sub.communityName !== undefined) {
    evidence["communityName"] = sub.communityName;
  }
  if (sub.tenantId !== undefined) {
    evidence["tenantId"] = sub.tenantId;
  }
  const summary = external
    ? `No Viva posts in 24h for ${sub.account} on external tenant ${sub.tenantId} community ${sub.communityId}.`
    : `No Viva posts in 24h for ${sub.account} community ${sub.communityId}.`;
  return {
    id: `viva-sub-drift:${sub.account}:${sub.communityId}`,
    category: "viva-sub-drift",
    severity: "warn",
    account: sub.account,
    source: "viva-engage",
    summary,
    evidence,
    remediationPrompt: buildRemediationPrompt({
      category: "viva-sub-drift",
      account: sub.account,
      source: "viva-engage",
      communityId: sub.communityId,
      ...(sub.communityName !== undefined && {
        communityName: sub.communityName,
      }),
      ...(sub.tenantId !== undefined && { tenantId: sub.tenantId }),
    }),
  };
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  error: 0,
  warn: 1,
  info: 2,
};

function sortFindings(a: Finding, b: Finding): number {
  const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (s !== 0) return s;
  const ac = a.account.localeCompare(b.account);
  if (ac !== 0) return ac;
  const as = a.source ?? "\uffff";
  const bs = b.source ?? "\uffff";
  const src = as.localeCompare(bs);
  if (src !== 0) return src;
  return a.category.localeCompare(b.category);
}
