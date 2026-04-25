import { describe, it, expect, vi } from "vitest";
import { startEventLoopWatchdog } from "./event-loop-watchdog.js";
import { FakeClock } from "../testing/fake-clock.js";
import type { SetTimerFn, TimerHandle } from "../sync/sync-scheduler.js";

interface TestTimer {
  fire(): void;
  cleared: boolean;
}

function makeManualTimer(): { setTimer: SetTimerFn; pending: TestTimer[] } {
  const pending: TestTimer[] = [];
  const setTimer: SetTimerFn = (fn) => {
    const slot: TestTimer = {
      cleared: false,
      fire() {
        if (slot.cleared) return;
        fn();
      },
    };
    pending.push(slot);
    const handle: TimerHandle = {
      clear() {
        slot.cleared = true;
      },
    };
    return handle;
  };
  return { setTimer, pending };
}

const baseLogger = { info: vi.fn(), error: vi.fn() };

describe("startEventLoopWatchdog", () => {
  it("fires onWedge after 3 consecutive over-budget intervals", () => {
    const clock = new FakeClock(new Date("2026-04-25T12:00:00Z"));
    const onWedge = vi.fn();
    const { setTimer, pending } = makeManualTimer();

    startEventLoopWatchdog({
      clock,
      logger: { info: vi.fn(), error: vi.fn() },
      intervalMs: 5_000,
      maxLagMs: 1_000,
      onWedge,
      setTimer,
    });

    for (let i = 0; i < 3; i++) {
      clock.advance(5_000 + 2_000);
      const next = pending.shift()!;
      next.fire();
    }

    expect(onWedge).toHaveBeenCalledTimes(1);
  });

  it("resets the over-budget counter when a single interval is on time", () => {
    const clock = new FakeClock(new Date("2026-04-25T12:00:00Z"));
    const onWedge = vi.fn();
    const { setTimer, pending } = makeManualTimer();

    startEventLoopWatchdog({
      clock,
      logger: { info: vi.fn(), error: vi.fn() },
      intervalMs: 5_000,
      maxLagMs: 1_000,
      onWedge,
      setTimer,
    });

    clock.advance(7_000);
    pending.shift()!.fire();
    clock.advance(5_000);
    pending.shift()!.fire();
    clock.advance(7_000);
    pending.shift()!.fire();
    clock.advance(7_000);
    pending.shift()!.fire();

    expect(onWedge).not.toHaveBeenCalled();
  });

  it("stop() cancels the next firing", () => {
    const clock = new FakeClock(new Date("2026-04-25T12:00:00Z"));
    const onWedge = vi.fn();
    const { setTimer, pending } = makeManualTimer();

    const handle = startEventLoopWatchdog({
      clock,
      logger: { info: vi.fn(), error: vi.fn() },
      intervalMs: 5_000,
      maxLagMs: 1_000,
      onWedge,
      setTimer,
    });

    clock.advance(7_000);
    pending.shift()!.fire();

    handle.stop();

    for (let i = 0; i < 5; i++) {
      clock.advance(7_000);
      const next = pending.shift();
      if (next) next.fire();
    }

    expect(onWedge).not.toHaveBeenCalled();
  });

  it("uses the injected clock for lag measurement", () => {
    const realClock = new FakeClock(new Date("2026-04-25T12:00:00Z"));
    const onWedge = vi.fn();
    const { setTimer, pending } = makeManualTimer();

    startEventLoopWatchdog({
      clock: realClock,
      logger: { info: vi.fn(), error: vi.fn() },
      intervalMs: 5_000,
      maxLagMs: 1_000,
      onWedge,
      setTimer,
    });

    for (let i = 0; i < 3; i++) {
      realClock.advance(7_000);
      pending.shift()!.fire();
    }

    expect(onWedge).toHaveBeenCalledTimes(1);
  });

  it("uses real setTimeout when no setTimer is injected (stop is no-op safe)", () => {
    const clock = new FakeClock(new Date("2026-04-25T12:00:00Z"));
    const onWedge = vi.fn();
    const handle = startEventLoopWatchdog({
      clock,
      logger: { info: vi.fn(), error: vi.fn() },
      intervalMs: 60_000,
      maxLagMs: 1_000,
      onWedge,
    });
    handle.stop();
    expect(onWedge).not.toHaveBeenCalled();
  });

  it("logs once before invoking onWedge", () => {
    const clock = new FakeClock(new Date("2026-04-25T12:00:00Z"));
    const onWedge = vi.fn();
    const error = vi.fn();
    const { setTimer, pending } = makeManualTimer();

    startEventLoopWatchdog({
      clock,
      logger: { info: baseLogger.info, error },
      intervalMs: 5_000,
      maxLagMs: 1_000,
      onWedge,
      setTimer,
    });

    for (let i = 0; i < 3; i++) {
      clock.advance(7_000);
      pending.shift()!.fire();
    }

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toContain("event_loop_watchdog_wedged");
  });
});
