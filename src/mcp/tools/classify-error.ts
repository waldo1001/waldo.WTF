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
    lower.includes("401 unauthorized") ||
    /(^|[^\d])401([^\d]|$)/.test(lower) ||
    lower.includes("yammer 401") ||
    lower.includes("graph 401") ||
    lower.includes("http 401")
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
    lower.includes("410 gone") ||
    /(^|[^\d])410([^\d]|$)/.test(lower)
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
