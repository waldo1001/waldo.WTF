import type { Clock } from "../clock.js";
import type { Logger } from "../logger.js";
import type { FetchLike } from "../sources/http-graph-client.js";
import type { SetTimerFn, TimerHandle } from "../sync/sync-scheduler.js";

export interface SelfProbeOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly port: number;
  readonly failuresBeforeWedge: number;
  readonly onWedge: () => void;
  readonly fetchImpl?: FetchLike;
  readonly setTimer?: SetTimerFn;
}

export interface SelfProbeHandle {
  stop(): void;
}

/* c8 ignore next 4 -- thin setTimeout/clearTimeout wrapper, exercised at runtime only */
const defaultSetTimer: SetTimerFn = (fn, ms) => {
  const h = setTimeout(fn, ms);
  return { clear: () => clearTimeout(h) };
};

/* c8 ignore next 8 -- production fetch wrapper, exercised at runtime only */
const defaultFetch: FetchLike = async (input, init) => {
  const res = await globalThis.fetch(input, init);
  return {
    status: res.status,
    headers: { get: (n: string) => res.headers.get(n) },
    text: () => res.text(),
  };
};

export function startSelfProbe(opts: SelfProbeOptions): SelfProbeHandle {
  const {
    clock,
    logger,
    intervalMs,
    timeoutMs,
    port,
    failuresBeforeWedge,
    onWedge,
  } = opts;
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const setTimer = opts.setTimer ?? defaultSetTimer;
  const url = `http://127.0.0.1:${port}/health`;

  let consecutive = 0;
  let stopped = false;
  let pending: TimerHandle | undefined;

  const probe = async (): Promise<boolean> => {
    const ac = new AbortController();
    const timer = setTimeout(
      () => ac.abort(new DOMException("self-probe timeout", "TimeoutError")),
      timeoutMs,
    );
    try {
      const res = await fetchImpl(url, { method: "GET", signal: ac.signal });
      return res.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const tick = (): void => {
    /* c8 ignore next -- defensive guard against real-Node clearTimeout/in-flight callback race */
    if (stopped) return;
    void (async () => {
      const ok = await probe();
      /* c8 ignore next -- defensive guard against stop() racing the in-flight probe */
      if (stopped) return;
      if (ok) {
        consecutive = 0;
      } else {
        consecutive += 1;
        if (consecutive >= failuresBeforeWedge) {
          stopped = true;
          logger.error(
            `self_probe_wedged consecutive=${consecutive} url=${url}`,
          );
          onWedge();
          return;
        }
      }
      schedule();
    })();
  };

  const schedule = (): void => {
    pending = setTimer(tick, intervalMs);
  };

  schedule();

  // Reference clock to keep the seam wired for future jitter logic;
  // currently not consulted because cadence is timer-driven.
  void clock;

  return {
    stop(): void {
      stopped = true;
      pending?.clear();
    },
  };
}
