export type FindingCategory =
  | "auth"
  | "rate-limit"
  | "delta-invalid"
  | "stale"
  | "repeated-failure"
  | "viva-sub-drift"
  | "never-synced"
  | "unknown-error";

export function classifyError(raw: string): FindingCategory {
  const msg = raw.trim();
  if (msg === "") return "unknown-error";
  const lower = msg.toLowerCase();

  if (
    msg.includes("TokenExpiredError") ||
    /\b401\s+(unauthorized|forbidden)\b/.test(lower) ||
    /\b(http|graph|yammer|msal)\s+401\b/.test(lower) ||
    /\bstatus[:= ]\s*401\b/.test(lower) ||
    /^401\b/.test(lower)
  ) {
    return "auth";
  }

  if (
    msg.includes("GraphRateLimitedError") ||
    lower.includes("rate limited") ||
    lower.includes("retry after") ||
    lower.includes("retry-after") ||
    lower.includes("429") ||
    lower.includes("too many requests")
  ) {
    return "rate-limit";
  }

  if (
    msg.includes("DeltaTokenInvalidError") ||
    lower.includes("resync required") ||
    /\b410\s+gone\b/.test(lower) ||
    /\b(http|graph|yammer|msal)\s+410\b/.test(lower) ||
    /\bstatus[:= ]\s*410\b/.test(lower) ||
    /^410\b/.test(lower)
  ) {
    return "delta-invalid";
  }

  return "unknown-error";
}

export function extractRetryAfterSeconds(raw: string): number | undefined {
  const m1 = /retry[- ]after[:\s]+(\d+)/i.exec(raw);
  if (m1 !== null) return parseInt(m1[1]!, 10);
  const m2 = /retry after (\d+)s/i.exec(raw);
  if (m2 !== null) return parseInt(m2[1]!, 10);
  return undefined;
}
