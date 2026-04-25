import type { Clock } from "../clock.js";
import type { Logger } from "../logger.js";
import type { SetTimerFn, TimerHandle } from "../sync/sync-scheduler.js";

export interface EventLoopWatchdogOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly intervalMs: number;
  readonly maxLagMs: number;
  readonly onWedge: () => void;
  readonly setTimer?: SetTimerFn;
}

export interface EventLoopWatchdogHandle {
  stop(): void;
}

/* c8 ignore next 4 -- thin setTimeout/clearTimeout wrapper, exercised at runtime only */
const defaultSetTimer: SetTimerFn = (fn, ms) => {
  const h = setTimeout(fn, ms);
  return { clear: () => clearTimeout(h) };
};

const CONSECUTIVE_THRESHOLD = 3;

export function startEventLoopWatchdog(
  opts: EventLoopWatchdogOptions,
): EventLoopWatchdogHandle {
  const { clock, logger, intervalMs, maxLagMs, onWedge } = opts;
  const setTimer = opts.setTimer ?? defaultSetTimer;

  let consecutive = 0;
  let stopped = false;
  let pending: TimerHandle | undefined;

  const schedule = (): void => {
    const scheduledAt = clock.now().getTime();
    pending = setTimer(() => {
      /* c8 ignore next -- defensive guard against real-Node clearTimeout/in-flight callback race */
      if (stopped) return;
      const actualMs = clock.now().getTime() - scheduledAt;
      if (actualMs > intervalMs + maxLagMs) {
        consecutive += 1;
        if (consecutive >= CONSECUTIVE_THRESHOLD) {
          stopped = true;
          logger.error(
            `event_loop_watchdog_wedged consecutive=${consecutive} actualMs=${actualMs} budgetMs=${intervalMs + maxLagMs}`,
          );
          onWedge();
          return;
        }
      } else {
        consecutive = 0;
      }
      schedule();
    }, intervalMs);
  };

  schedule();

  return {
    stop(): void {
      stopped = true;
      pending?.clear();
    },
  };
}
