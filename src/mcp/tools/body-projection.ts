import type { Message } from "../../store/types.js";

export const MAX_BODY_CHARS = 50_000;
export const MAX_TOTAL_BODY_CHARS = 400_000;
export const TRUNCATION_SENTINEL = "\n\n… [truncated]";

export interface BodyProjection {
  readonly body?: string;
  readonly bodyTruncated?: true;
  readonly consumed: number;
}

export function projectBody(m: Message, budget: number): BodyProjection {
  if (m.body === undefined) return { consumed: 0 };
  if (budget <= 0) return { consumed: 0 };
  if (m.body.length > MAX_BODY_CHARS) {
    if (MAX_BODY_CHARS > budget) return { consumed: 0 };
    return {
      body: m.body.slice(0, MAX_BODY_CHARS) + TRUNCATION_SENTINEL,
      bodyTruncated: true,
      consumed: MAX_BODY_CHARS,
    };
  }
  if (m.body.length > budget) return { consumed: 0 };
  return { body: m.body, consumed: m.body.length };
}
