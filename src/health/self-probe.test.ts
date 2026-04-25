import { describe, it, expect, vi } from "vitest";
import { startSelfProbe } from "./self-probe.js";
import { FakeClock } from "../testing/fake-clock.js";
import type { FetchLike, FetchLikeResponse } from "../sources/http-graph-client.js";
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

const okResponse = (): FetchLikeResponse => ({
  status: 200,
  headers: { get: () => null },
  text: async () => "{}",
});

const non200 = (status: number): FetchLikeResponse => ({
  status,
  headers: { get: () => null },
  text: async () => "",
});

const baseLogger = () => ({ info: vi.fn(), error: vi.fn() });

async function flushTimer(pending: TestTimer[]): Promise<void> {
  pending.shift()!.fire();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("startSelfProbe", () => {
  it("resets failure counter on a successful probe", async () => {
    const onWedge = vi.fn();
    const responses: Array<FetchLikeResponse | "throw"> = [
      "throw",
      "throw",
      okResponse(),
      "throw",
      "throw",
    ];
    const fetchImpl: FetchLike = async () => {
      const next = responses.shift();
      if (next === "throw") throw new Error("ECONNREFUSED");
      return next!;
    };
    const { setTimer, pending } = makeManualTimer();

    startSelfProbe({
      clock: new FakeClock(new Date("2026-04-25T12:00:00Z")),
      logger: baseLogger(),
      intervalMs: 30_000,
      timeoutMs: 5_000,
      port: 8765,
      failuresBeforeWedge: 3,
      fetchImpl,
      onWedge,
      setTimer,
    });

    for (let i = 0; i < 5; i++) {
      await flushTimer(pending);
    }

    expect(onWedge).not.toHaveBeenCalled();
  });

  it("calls onWedge exactly once after consecutive failures (idempotent)", async () => {
    const onWedge = vi.fn();
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const { setTimer, pending } = makeManualTimer();

    startSelfProbe({
      clock: new FakeClock(new Date("2026-04-25T12:00:00Z")),
      logger: baseLogger(),
      intervalMs: 30_000,
      timeoutMs: 5_000,
      port: 8765,
      failuresBeforeWedge: 3,
      fetchImpl,
      onWedge,
      setTimer,
    });

    for (let i = 0; i < 4; i++) {
      if (pending.length > 0) await flushTimer(pending);
    }

    expect(onWedge).toHaveBeenCalledTimes(1);
  });

  it("counts a slow response (timeout via AbortController) as a failure", async () => {
    const onWedge = vi.fn();
    let aborted = 0;
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise<FetchLikeResponse>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted += 1;
          reject(new Error("aborted"));
        });
      });
    const { setTimer, pending } = makeManualTimer();

    startSelfProbe({
      clock: new FakeClock(new Date("2026-04-25T12:00:00Z")),
      logger: baseLogger(),
      intervalMs: 30_000,
      timeoutMs: 50,
      port: 8765,
      failuresBeforeWedge: 3,
      fetchImpl,
      onWedge,
      setTimer,
    });

    for (let i = 0; i < 3; i++) {
      pending.shift()!.fire();
      await new Promise((r) => setTimeout(r, 80));
    }

    expect(aborted).toBeGreaterThanOrEqual(3);
    expect(onWedge).toHaveBeenCalledTimes(1);
  });

  it("counts a non-200 response as a failure", async () => {
    const onWedge = vi.fn();
    const fetchImpl: FetchLike = async () => non200(503);
    const { setTimer, pending } = makeManualTimer();

    startSelfProbe({
      clock: new FakeClock(new Date("2026-04-25T12:00:00Z")),
      logger: baseLogger(),
      intervalMs: 30_000,
      timeoutMs: 5_000,
      port: 8765,
      failuresBeforeWedge: 3,
      fetchImpl,
      onWedge,
      setTimer,
    });

    for (let i = 0; i < 3; i++) {
      await flushTimer(pending);
    }

    expect(onWedge).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels the next probe", async () => {
    const onWedge = vi.fn();
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(okResponse());
    const { setTimer, pending } = makeManualTimer();

    const handle = startSelfProbe({
      clock: new FakeClock(new Date("2026-04-25T12:00:00Z")),
      logger: baseLogger(),
      intervalMs: 30_000,
      timeoutMs: 5_000,
      port: 8765,
      failuresBeforeWedge: 3,
      fetchImpl,
      onWedge,
      setTimer,
    });

    await flushTimer(pending);
    handle.stop();

    for (let i = 0; i < 5; i++) {
      const next = pending.shift();
      if (next) next.fire();
    }
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onWedge).not.toHaveBeenCalled();
  });

  it("uses default fetch and setTimer when none provided and stop() prevents firing", () => {
    const onWedge = vi.fn();
    const handle = startSelfProbe({
      clock: new FakeClock(new Date("2026-04-25T12:00:00Z")),
      logger: baseLogger(),
      intervalMs: 30_000,
      timeoutMs: 5_000,
      port: 8765,
      failuresBeforeWedge: 3,
      onWedge,
    });
    handle.stop();
    expect(onWedge).not.toHaveBeenCalled();
  });

  it("issues GET to http://127.0.0.1:<port>/health", async () => {
    const onWedge = vi.fn();
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      calls.push(input);
      return okResponse();
    };
    const { setTimer, pending } = makeManualTimer();

    startSelfProbe({
      clock: new FakeClock(new Date("2026-04-25T12:00:00Z")),
      logger: baseLogger(),
      intervalMs: 30_000,
      timeoutMs: 5_000,
      port: 18765,
      failuresBeforeWedge: 3,
      fetchImpl,
      onWedge,
      setTimer,
    });

    await flushTimer(pending);

    expect(calls).toEqual(["http://127.0.0.1:18765/health"]);
  });
});
