import type { MessageSource } from "../../store/types.js";
import type { FindingCategory } from "./classify-error.js";

export function redactSecretsFromError(raw: string): string {
  if (raw === "") return "";
  let out = raw.replace(/Bearer\s+[A-Za-z0-9._\-=/+]+/g, "[REDACTED]");
  out = out.replace(/[A-Za-z0-9+/=_\-]{40,}/g, "[REDACTED]");
  return out;
}

export interface RemediationInput {
  readonly category: FindingCategory;
  readonly account: string;
  readonly source?: MessageSource;
  readonly tenantId?: string;
  readonly lastError?: string;
  readonly retryAfterSeconds?: number;
  readonly lastOkAt?: string;
  readonly staleMs?: number;
  readonly consecutiveFailures?: number;
  readonly communityId?: string;
  readonly communityName?: string;
}

export function buildRemediationPrompt(input: RemediationInput): string {
  const safeErr =
    input.lastError !== undefined
      ? redactSecretsFromError(input.lastError)
      : undefined;
  switch (input.category) {
    case "auth":
      return authPrompt(input, safeErr);
    case "delta-invalid":
      return deltaInvalidPrompt(input, safeErr);
    case "rate-limit":
      return rateLimitPrompt(input, safeErr);
    case "stale":
      return stalePrompt(input);
    case "repeated-failure":
      return repeatedFailurePrompt(input, safeErr);
    case "viva-sub-drift":
      return vivaDriftPrompt(input);
    case "never-synced":
      return neverSyncedPrompt(input);
    case "unknown-error":
      return unknownErrorPrompt(input, safeErr);
  }
}

function authPrompt(input: RemediationInput, safeErr?: string): string {
  const tenant = input.tenantId ?? "common";
  return [
    `Account ${input.account} (source: ${input.source ?? "unknown"})`,
    `has an expired or invalid token. Re-authenticate by running:`,
    ``,
    `    tsx src/cli.ts --add-account --tenant ${tenant}`,
    ``,
    `Device-code login will bind a fresh token to tenant ${tenant}.`,
    safeErr !== undefined ? `Last error: ${safeErr}` : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function deltaInvalidPrompt(
  input: RemediationInput,
  safeErr?: string,
): string {
  return [
    `Account ${input.account} (source: ${input.source ?? "unknown"})`,
    `has an invalid delta cursor. A full resync is needed.`,
    ``,
    `Clear the sync_state row for this pair and let the next scheduler`,
    `tick restart from scratch:`,
    ``,
    `    sqlite3 /data/db/lake.db \\`,
    `      "DELETE FROM sync_state WHERE account='${input.account}'`,
    `       AND source='${input.source ?? ""}';"`,
    safeErr !== undefined ? `Last error: ${safeErr}` : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function rateLimitPrompt(
  input: RemediationInput,
  safeErr?: string,
): string {
  const head = `Account ${input.account} (source: ${input.source ?? "unknown"}) is rate limited.`;
  if (input.retryAfterSeconds !== undefined) {
    return [
      head,
      `The server asked us to retry after ${input.retryAfterSeconds} seconds.`,
      `Wait for the next scheduler tick (5 min) — it will self-recover.`,
      safeErr !== undefined ? `Last error: ${safeErr}` : "",
    ]
      .filter((s) => s !== "")
      .join("\n");
  }
  return [
    head,
    `No explicit retry-after was returned. Wait one scheduler tick`,
    `(5 min) and re-check; the sync loop will self-recover.`,
    safeErr !== undefined ? `Last error: ${safeErr}` : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function stalePrompt(input: RemediationInput): string {
  const mins =
    input.staleMs !== undefined
      ? Math.round(input.staleMs / 60000)
      : undefined;
  return [
    `Account ${input.account} (source: ${input.source ?? "unknown"}) is stale.`,
    input.lastOkAt !== undefined
      ? `Last successful sync: ${input.lastOkAt}`
      : "Last successful sync: unknown",
    mins !== undefined ? `Staleness: ${mins} minute(s).` : "",
    `Check the scheduler: confirm the container is running and`,
    `that sync ticks are firing. docker compose logs --tail=50 waldo-wtf.`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function repeatedFailurePrompt(
  input: RemediationInput,
  safeErr?: string,
): string {
  return [
    `Account ${input.account} (source: ${input.source ?? "unknown"})`,
    `has ${input.consecutiveFailures ?? 0} consecutive failures.`,
    `Investigate the underlying error before it silently eats sync budget.`,
    safeErr !== undefined ? `Last error: ${safeErr}` : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function vivaDriftPrompt(input: RemediationInput): string {
  const external = input.tenantId !== undefined;
  const community =
    input.communityName !== undefined
      ? `${input.communityName} (${input.communityId ?? ""})`
      : (input.communityId ?? "unknown");
  const lines = [
    `Account ${input.account} is subscribed to Viva Engage`,
    `community ${community} but has not received any posts in the`,
    `last 24 hours.`,
  ];
  if (external) {
    lines.push(
      `This subscription is on an external tenant (${input.tenantId}).`,
      `Re-check Yammer consent for that tenant — run:`,
      ``,
      `    tsx src/cli.ts --add-account --tenant ${input.tenantId}`,
      ``,
      `to force a fresh device-code flow with the Yammer scope.`,
    );
  } else {
    lines.push(
      `Re-check Yammer consent and Viva subscription status; the`,
      `community may have become inaccessible.`,
    );
  }
  return lines.join("\n");
}

function neverSyncedPrompt(input: RemediationInput): string {
  return [
    `Account ${input.account} has not yet been synced.`,
    `The scheduler has not yet run a successful tick for this account.`,
    `Check the container logs for errors from the first tick:`,
    ``,
    `    docker compose logs --tail=200 waldo-wtf | grep ${input.account}`,
  ].join("\n");
}

function unknownErrorPrompt(
  input: RemediationInput,
  safeErr?: string,
): string {
  return [
    `Account ${input.account} (source: ${input.source ?? "unknown"})`,
    `failed with an error that did not match any known pattern.`,
    `Manual investigation required.`,
    safeErr !== undefined ? `Last error: ${safeErr}` : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
}
