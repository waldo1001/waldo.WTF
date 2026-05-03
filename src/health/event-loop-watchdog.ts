import type { Clock } from "../clock.js";
import type { Logger } from "../logger.js";
import type { SetTimerFn, TimerHandle } from "../sync/sync-scheduler.js";

export interface EventLoopWatchdogOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly intervalMs: number;
  readonly maxLagMs: number;
  // Any single tick whose lag exceeds this threshold fires onWedge
  // immediately, instead of needing 3 consecutive over-budget ticks.
  // Catches single-block wedges (e.g. a 90 s synchronous DB query) that
  // the consecutive-tick logic is invisible to — once the loop unblocks,
  // the lag counter resets to 0 and the wedge is forgotten.
  readonly singleBlockMs: number;
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
  const { clock, logger, intervalMs, maxLagMs, singleBlockMs, onWedge } = opts;
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
      const lagMs = actualMs - intervalMs;
      if (lagMs > singleBlockMs) {
        stopped = true;
        logger.error(
          `event_loop_watchdog_single_block lagMs=${lagMs} thresholdMs=${singleBlockMs} actualMs=${actualMs}`,
        );
        onWedge();
        return;
      }
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
