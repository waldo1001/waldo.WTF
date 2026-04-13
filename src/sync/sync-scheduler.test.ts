import { describe, it, expect, vi } from "vitest";
import {
  SyncScheduler,
  DEFAULT_SYNC_INTERVAL_MS,
  type SetTimerFn,
  type TimerHandle,
} from "./sync-scheduler.js";
import { FakeAuthClient } from "../testing/fake-auth-client.js";
import { FakeGraphClient } from "../testing/fake-graph-client.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { FakeClock } from "../testing/fake-clock.js";
import type { Account, AccessToken } from "../auth/types.js";
import type { GraphDeltaResponse } from "../sources/graph.js";

const acc = (n: string): Account => ({
  username: `${n}@x.invalid`,
  homeAccountId: `h-${n}`,
  tenantId: `t-${n}`,
});

const tok = (a: Account): AccessToken => ({
  token: `tok-${a.homeAccountId}`,
  expiresOn: new Date("2026-04-13T11:00:00Z"),
  account: a,
});

const ok = (r: Partial<GraphDeltaResponse>): GraphDeltaResponse => ({
  value: [],
  ...r,
});

interface RecordedTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

const makeFakeSetTimer = (): {
  setTimer: SetTimerFn;
  timers: RecordedTimer[];
  fire: (i: number) => void;
} => {
  const timers: RecordedTimer[] = [];
  const setTimer: SetTimerFn = (fn, ms) => {
    const rec: RecordedTimer = { fn, ms, cleared: false };
    timers.push(rec);
    const handle: TimerHandle = {
      clear: () => {
        rec.cleared = true;
      },
    };
    return handle;
  };
  const fire = (i: number): void => {
    const t = timers[i];
    if (!t) throw new Error(`no timer at ${i}`);
    t.fn();
  };
  return { setTimer, timers, fire };
};

describe("SyncScheduler", () => {
  it("DEFAULT_SYNC_INTERVAL_MS equals 5 minutes", () => {
    expect(DEFAULT_SYNC_INTERVAL_MS).toBe(300_000);
  });

  it("runOnce with zero accounts performs zero graph calls and zero sync_log rows", async () => {
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({ steps: [] });
    const auth = new FakeAuthClient({ accounts: [] });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.runOnce();
    expect(graph.calls).toHaveLength(0);
    expect(store.syncLog).toHaveLength(0);
  });

  it("runOnce with two accounts appends one ok sync_log row per account", async () => {
    const a1 = acc("alice");
    const a2 = acc("bob");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ value: [], "@odata.deltaLink": "d1" }) },
        { kind: "ok", response: ok({ value: [], "@odata.deltaLink": "d2" }) },
      ],
    });
    const auth = new FakeAuthClient({
      accounts: [a1, a2],
      tokens: new Map([
        [a1.homeAccountId, tok(a1)],
        [a2.homeAccountId, tok(a2)],
      ]),
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.runOnce();
    expect(store.syncLog).toHaveLength(2);
    expect(store.syncLog.every((e) => e.status === "ok")).toBe(true);
    expect(store.syncLog.map((e) => e.account).sort()).toEqual([
      a1.username,
      a2.username,
    ]);
  });

  it("runOnce: one account throws — other still runs, error row has stringified message", async () => {
    const a1 = acc("alice");
    const a2 = acc("bob");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "error", error: new Error("boom-alice") },
        { kind: "ok", response: ok({ value: [], "@odata.deltaLink": "d2" }) },
      ],
    });
    const auth = new FakeAuthClient({
      accounts: [a1, a2],
      tokens: new Map([
        [a1.homeAccountId, tok(a1)],
        [a2.homeAccountId, tok(a2)],
      ]),
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.runOnce();
    expect(store.syncLog).toHaveLength(2);
    const aliceRow = store.syncLog.find((e) => e.account === a1.username);
    const bobRow = store.syncLog.find((e) => e.account === a2.username);
    expect(aliceRow?.status).toBe("error");
    expect(aliceRow?.errorMessage).toContain("boom-alice");
    expect(bobRow?.status).toBe("ok");
  });

  it("start() awaits first runOnce then arms the timer with intervalMs", async () => {
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [{ kind: "ok", response: ok({ "@odata.deltaLink": "d1" }) }],
    });
    const a1 = acc("alice");
    const auth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([[a1.homeAccountId, tok(a1)]]),
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 42_000,
    });
    await scheduler.start();
    expect(store.syncLog).toHaveLength(1);
    expect(timer.timers).toHaveLength(1);
    expect(timer.timers[0]?.ms).toBe(42_000);
  });

  it("stop() clears the active timer", async () => {
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [{ kind: "ok", response: ok({ "@odata.deltaLink": "d1" }) }],
    });
    const a1 = acc("alice");
    const auth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([[a1.homeAccountId, tok(a1)]]),
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.start();
    scheduler.stop();
    expect(timer.timers[0]?.cleared).toBe(true);
  });

  it("timer firing during an in-flight run is skipped and onSkip is invoked", async () => {
    const a1 = acc("alice");
    let releaseFirstRun: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    const slowGraph = {
      async getDelta() {
        await gate;
        return ok({ "@odata.deltaLink": "d1" });
      },
    };
    const store = new InMemoryMessageStore();
    const auth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([[a1.homeAccountId, tok(a1)]]),
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();
    const onSkip = vi.fn();

    const scheduler = new SyncScheduler({
      auth,
      graph: slowGraph as never,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
      onSkip,
    });
    const firstRun = scheduler.runOnce();
    // Second call while first is still waiting on `gate`
    await scheduler.runOnce();
    expect(onSkip).toHaveBeenCalledTimes(1);
    releaseFirstRun?.();
    await firstRun;
  });
});
