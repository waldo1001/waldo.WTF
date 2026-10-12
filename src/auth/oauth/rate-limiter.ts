import type { Clock } from "../../clock.js";

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
}

export interface FixedWindowRateLimiterOptions {
  readonly clock: Clock;
  readonly windowMs: number;
  /** Max allowed calls per key (client IP) per window. */
  readonly perKey: number;
  /** Max allowed calls across all keys per window. */
  readonly global: number;
}

/**
 * In-memory fixed-window limiter, one window shared by all keys. When the
 * window rolls the whole key map is dropped, so memory is bounded by the
 * number of distinct keys seen in a single window. Refused calls are not
 * counted, so a hammering client cannot drain the global bucket further
 * than its own per-key allowance.
 */
export class FixedWindowRateLimiter {
  private readonly opts: FixedWindowRateLimiterOptions;
  private windowStartMs: number;
  private globalCount = 0;
  private readonly counts = new Map<string, number>();

  constructor(opts: FixedWindowRateLimiterOptions) {
    this.opts = opts;
    this.windowStartMs = opts.clock.now().getTime();
  }

  check(key: string): RateLimitDecision {
    const nowMs = this.opts.clock.now().getTime();
    if (nowMs - this.windowStartMs >= this.opts.windowMs) {
      this.windowStartMs = nowMs;
      this.globalCount = 0;
      this.counts.clear();
    }
    const keyCount = this.counts.get(key) ?? 0;
    if (keyCount >= this.opts.perKey || this.globalCount >= this.opts.global) {
      const remainingMs = this.windowStartMs + this.opts.windowMs - nowMs;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
      };
    }
    this.counts.set(key, keyCount + 1);
    this.globalCount += 1;
    return { allowed: true };
  }

  trackedKeys(): number {
    return this.counts.size;
  }
}
