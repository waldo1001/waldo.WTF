import { describe, it, expect, vi } from "vitest";
import {
  SyncScheduler,
  DEFAULT_SYNC_INTERVAL_MS,
  type SetTimerFn,
  type TimerHandle,
} from "./sync-scheduler.js";
import { FakeAuthClient } from "../testing/fake-auth-client.js";
import { FakeGraphClient } from "../testing/fake-graph-client.js";
import { FakeTeamsClient } from "../testing/fake-teams-client.js";
import { FakeVivaClient } from "../testing/fake-viva-client.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { InMemoryVivaSubscriptionStore } from "../testing/in-memory-viva-subscription-store.js";
import { FakeClock } from "../testing/fake-clock.js";
import { GraphRateLimitedError, TokenExpiredError } from "../sources/viva.js";
import { vivaAuthorityFor, YAMMER_SCOPE } from "../auth/msal-auth-client.js";
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

// Per Outlook account, the scheduler calls /inbox/delta then /sentitems/delta.
// Tests that only care about inbox behavior append this step to satisfy the
// second call.
const sentOk = {
  kind: "ok" as const,
  response: ok({ "@odata.deltaLink": "sent-link" }),
};

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

  it("runOnce with two accounts appends one ok sync_log row per account per folder", async () => {
    const a1 = acc("alice");
    const a2 = acc("bob");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ value: [], "@odata.deltaLink": "d1" }) },
        sentOk,
        { kind: "ok", response: ok({ value: [], "@odata.deltaLink": "d2" }) },
        sentOk,
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
    expect(store.syncLog).toHaveLength(4);
    expect(store.syncLog.every((e) => e.status === "ok")).toBe(true);
    expect(store.syncLog.map((e) => e.account).sort()).toEqual([
      a1.username,
      a1.username,
      a2.username,
      a2.username,
    ]);
  });

  it("runOnce: one account's inbox throws — sent still runs for it, other account still runs", async () => {
    const a1 = acc("alice");
    const a2 = acc("bob");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        // alice inbox: error
        { kind: "error", error: new Error("boom-alice") },
        // alice sent: ok
        sentOk,
        // bob inbox: ok
        { kind: "ok", response: ok({ value: [], "@odata.deltaLink": "d2" }) },
        // bob sent: ok
        sentOk,
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
    expect(store.syncLog).toHaveLength(4);
    const aliceRows = store.syncLog.filter((e) => e.account === a1.username);
    const bobRows = store.syncLog.filter((e) => e.account === a2.username);
    // Alice: inbox errored, sent ok.
    const aliceErr = aliceRows.find((e) => e.status === "error");
    const aliceOk = aliceRows.find((e) => e.status === "ok");
    expect(aliceErr?.errorMessage).toContain("boom-alice");
    expect(aliceOk).toBeDefined();
    expect(bobRows.every((e) => e.status === "ok")).toBe(true);
  });

  it("per Outlook account runs inbox, then sent; both logged as ok", async () => {
    const a1 = acc("alice");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "inbox-link" }) },
        { kind: "ok", response: ok({ "@odata.deltaLink": "sent-link" }) },
      ],
    });
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
    await scheduler.runOnce();

    // Inbox first, then sent.
    expect(graph.calls.map((c) => c.url)).toEqual([
      "/me/mailFolders/inbox/messages/delta",
      "/me/mailFolders/sentitems/messages/delta",
    ]);
    // Two ok log rows, both for outlook.
    expect(store.syncLog).toHaveLength(2);
    expect(store.syncLog.every((e) => e.source === "outlook")).toBe(true);
    expect(store.syncLog.every((e) => e.status === "ok")).toBe(true);
    // Each has its own sync_state row.
    const inbox = await store.getSyncState(a1.username, "outlook");
    const sent = await store.getSyncState(a1.username, "outlook", "sentitems");
    expect(inbox?.deltaToken).toBe("inbox-link");
    expect(sent?.deltaToken).toBe("sent-link");
  });

  it("sent failure does not swallow inbox ok (and vice versa): both rows appended", async () => {
    const a1 = acc("alice");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "inbox-ok" }) },
        { kind: "error", error: new Error("sent-boom") },
      ],
    });
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
    await scheduler.runOnce();

    expect(store.syncLog).toHaveLength(2);
    const okRow = store.syncLog.find((e) => e.status === "ok");
    const errRow = store.syncLog.find((e) => e.status === "error");
    expect(okRow?.source).toBe("outlook");
    expect(errRow?.source).toBe("outlook");
    expect(errRow?.errorMessage).toContain("sent-boom");
    // The inbox cursor still advanced.
    const inbox = await store.getSyncState(a1.username, "outlook");
    expect(inbox?.deltaToken).toBe("inbox-ok");
  });

  it("upserts each account into the store on every tick", async () => {
    const a1 = acc("alice");
    const a2 = acc("bob");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ value: [], "@odata.deltaLink": "d1" }) },
        sentOk,
        { kind: "ok", response: ok({ value: [], "@odata.deltaLink": "d2" }) },
        sentOk,
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

    const accounts = await store.listAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.username).sort()).toEqual([
      a1.username,
      a2.username,
    ]);
    expect(accounts[0]?.tenantId).toBe(a1.tenantId);
  });

  it("start() awaits first runOnce then arms the timer with intervalMs", async () => {
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "d1" }) },
        sentOk,
      ],
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
    expect(store.syncLog).toHaveLength(2);
    expect(timer.timers).toHaveLength(1);
    expect(timer.timers[0]?.ms).toBe(42_000);
    // Fire the armed timer so the callback body is exercised.
    timer.fire(0);
  });

  it("stop() clears the active timer", async () => {
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "d1" }) },
        sentOk,
      ],
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

  it("with teams dep: runOnce appends inbox + sent + teams rows per account", async () => {
    const a1 = acc("alice");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "do" }) },
        sentOk,
      ],
    });
    const teams = new FakeTeamsClient({
      steps: [{ kind: "listChatsOk", response: { value: [] } }],
    });
    const auth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([[a1.homeAccountId, tok(a1)]]),
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      teams,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.runOnce();
    expect(store.syncLog).toHaveLength(3);
    expect(store.syncLog.map((e) => e.source).sort()).toEqual([
      "outlook",
      "outlook",
      "teams",
    ]);
    expect(store.syncLog.every((e) => e.status === "ok")).toBe(true);
  });

  it("without teams dep: only outlook rows are appended (backwards-compat)", async () => {
    const a1 = acc("alice");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "do" }) },
        sentOk,
      ],
    });
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
    await scheduler.runOnce();
    expect(store.syncLog).toHaveLength(2);
    expect(store.syncLog.every((e) => e.source === "outlook")).toBe(true);
  });

  it("teams error does not block outlook: both rows appended, teams row is error", async () => {
    const a1 = acc("alice");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "do" }) },
        sentOk,
      ],
    });
    const teams = new FakeTeamsClient({
      steps: [{ kind: "error", error: new Error("teams-boom") }],
    });
    const auth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([[a1.homeAccountId, tok(a1)]]),
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      teams,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.runOnce();
    expect(store.syncLog).toHaveLength(3);
    const outlookRows = store.syncLog.filter((e) => e.source === "outlook");
    const teamsRow = store.syncLog.find((e) => e.source === "teams");
    expect(outlookRows).toHaveLength(2);
    expect(outlookRows.every((r) => r.status === "ok")).toBe(true);
    expect(teamsRow?.status).toBe("error");
    expect(teamsRow?.errorMessage).toContain("teams-boom");
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

  it("runOnce forwards backfillDays to both syncInbox and syncTeams (first-call filter URL)", async () => {
    const a1 = acc("alice");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "do" }) },
        sentOk,
      ],
    });
    const teams = new FakeTeamsClient({
      steps: [
        { kind: "listChatsOk", response: { value: [{ id: "chat-1" }] } },
        { kind: "getChatMessagesOk", response: { value: [] } },
      ],
    });
    const auth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([[a1.homeAccountId, tok(a1)]]),
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      teams,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
      backfillDays: 14,
    });
    await scheduler.runOnce();

    expect(graph.calls[0]?.url).toContain("$filter=receivedDateTime%20ge%20");
    const getMsgsCall = teams.calls.find((c) => c.method === "getChatMessages");
    const expectedIso = new Date(
      new Date("2026-04-13T12:00:00Z").getTime() - 14 * 86_400_000,
    ).toISOString();
    expect(getMsgsCall).toMatchObject({
      method: "getChatMessages",
      chatId: "chat-1",
      sinceIso: expectedIso,
    });
  });

  it("with viva dep but no enabled subs: skips viva entirely (no calls, no row)", async () => {
    const a1 = acc("alice");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "do" }) },
        sentOk,
      ],
    });
    const viva = new FakeVivaClient({ steps: [] });
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    const auth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([[a1.homeAccountId, tok(a1)]]),
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      viva,
      vivaSubs,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.runOnce();

    expect(viva.calls).toHaveLength(0);
    expect(store.syncLog).toHaveLength(2);
    expect(store.syncLog.every((e) => e.source === "outlook")).toBe(true);
  });

  it("with viva dep + enabled sub: viva-engage row is appended", async () => {
    const a1 = acc("alice");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "do" }) },
        sentOk,
      ],
    });
    const viva = new FakeVivaClient({
      steps: [
        { kind: "listThreadsOk", response: { value: [] } },
      ],
    });
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    await vivaSubs.subscribe({
      account: a1.username,
      networkId: "net-1",
      communityId: "com-1",
    });
    const auth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([[a1.homeAccountId, tok(a1)]]),
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      viva,
      vivaSubs,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.runOnce();

    expect(store.syncLog).toHaveLength(3);
    const vivaRow = store.syncLog.find((e) => e.source === "viva-engage");
    expect(vivaRow?.status).toBe("ok");
    expect(viva.calls.some((c) => c.method === "listThreads")).toBe(true);
  });

  it("per-community viva error is swallowed: viva-engage row is still ok (isolation)", async () => {
    const a1 = acc("alice");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "do" }) },
        sentOk,
      ],
    });
    const viva = new FakeVivaClient({
      steps: [{ kind: "error", error: new Error("viva-boom") }],
    });
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    await vivaSubs.subscribe({
      account: a1.username,
      networkId: "net-1",
      communityId: "com-1",
    });
    const auth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([[a1.homeAccountId, tok(a1)]]),
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      viva,
      vivaSubs,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.runOnce();

    expect(store.syncLog).toHaveLength(3);
    const outlookRows = store.syncLog.filter((e) => e.source === "outlook");
    const vivaRow = store.syncLog.find((e) => e.source === "viva-engage");
    expect(outlookRows.every((r) => r.status === "ok")).toBe(true);
    expect(vivaRow?.status).toBe("ok");
  });

  it("viva persistent 401 after force-refresh retry resolves as ok row (syncViva does not throw)", async () => {
    // Regression guard for the force-refresh-on-401 retry: even when both the
    // initial and the forceRefresh acquisition return the same stale token and
    // the viva fake 401s twice, syncViva must resolve (per-community error),
    // and the scheduler writes ok — not error — because the tick did not
    // crash. See docs/plans/viva-sync-force-refresh-on-401.md AC3.
    const a1 = acc("alice");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "do" }) },
        sentOk,
      ],
    });
    const viva = new FakeVivaClient({
      steps: [
        { kind: "error", error: new TokenExpiredError() },
        { kind: "error", error: new TokenExpiredError() },
      ],
    });
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    await vivaSubs.subscribe({
      account: a1.username,
      networkId: "net-1",
      communityId: "com-1",
    });
    const auth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([[a1.homeAccountId, tok(a1)]]),
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      viva,
      vivaSubs,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.runOnce();
    const vivaRow = store.syncLog.find((e) => e.source === "viva-engage");
    expect(vivaRow?.status).toBe("ok");
  });

  it("viva hardstop (GraphRateLimited) is recorded as error row, doesn't crash tick", async () => {
    const a1 = acc("alice");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "do" }) },
        sentOk,
      ],
    });
    const viva = new FakeVivaClient({
      steps: [{ kind: "error", error: new GraphRateLimitedError(30) }],
    });
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    await vivaSubs.subscribe({
      account: a1.username,
      networkId: "net-1",
      communityId: "com-1",
    });
    const auth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([[a1.homeAccountId, tok(a1)]]),
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      viva,
      vivaSubs,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.runOnce();
    const vivaRow = store.syncLog.find((e) => e.source === "viva-engage");
    expect(vivaRow?.status).toBe("error");
  });

  it("without viva dep: no viva rows even if vivaSubs present (both must be set)", async () => {
    const a1 = acc("alice");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "do" }) },
        sentOk,
      ],
    });
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    await vivaSubs.subscribe({
      account: a1.username,
      networkId: "net-1",
      communityId: "com-1",
    });
    const auth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([[a1.homeAccountId, tok(a1)]]),
    });
    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      vivaSubs,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.runOnce();
    expect(store.syncLog).toHaveLength(2);
    expect(store.syncLog.every((e) => e.source === "outlook")).toBe(true);
  });

  it("runOnce invokes onTickComplete with the tick summary after sync_log writes", async () => {
    const a1 = acc("alice");
    const a2 = acc("bob");
    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        // alice inbox: ok
        { kind: "ok", response: ok({ value: [], "@odata.deltaLink": "d1" }) },
        // alice sent: ok
        sentOk,
        // bob inbox: error
        { kind: "error", error: new Error("boom") },
        // bob sent: ok
        sentOk,
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
    const onTickComplete = vi.fn();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
      onTickComplete,
    });
    await scheduler.runOnce();

    expect(onTickComplete).toHaveBeenCalledTimes(1);
    const summary = onTickComplete.mock.calls[0]![0] as {
      accounts: number;
      okCount: number;
      errorCount: number;
    };
    expect(summary.accounts).toBe(2);
    expect(summary.okCount).toBe(3);
    expect(summary.errorCount).toBe(1);
    // Contract: callback fires after sync_log has been written
    expect(store.syncLog).toHaveLength(4);
  });

  // ── vivaAuth injection: viva tokens require a separate MSAL cache
  // partition (YAMMER_PUBLIC_CLIENT_ID), so the scheduler must allow a
  // distinct AuthClient for viva syncs. Without this, getTokenSilent with
  // an external-tenant authority silently fails under the main clientId
  // (no cached account for that (clientId, authority) pair), and viva-engage
  // ticks record ok/0 forever.

  it("SyncScheduler passes vivaAuth to syncViva when provided", async () => {
    const a1 = acc("alice");
    const externalTenant = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    const externalAuthority = vivaAuthorityFor(externalTenant);

    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "do" }) },
        sentOk,
      ],
    });
    const viva = new FakeVivaClient({
      steps: [{ kind: "listThreadsOk", response: { value: [] } }],
    });
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    await vivaSubs.subscribe({
      account: a1.username,
      tenantId: externalTenant,
      networkId: "net-ext",
      communityId: "com-ext",
    });

    const mainAuth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([[a1.homeAccountId, tok(a1)]]),
    });
    const vivaYammerToken: AccessToken = {
      token: "yammer-tok",
      expiresOn: new Date("2026-04-13T13:00:00Z"),
      account: a1,
    };
    const vivaAuth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([
        [`${a1.homeAccountId}|${externalAuthority}`, vivaYammerToken],
      ]),
    });

    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth: mainAuth,
      graph,
      viva,
      vivaSubs,
      vivaAuth,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.runOnce();

    const vivaTokenCalls = vivaAuth.calls.filter(
      (c) => c.method === "getTokenSilent",
    );
    expect(vivaTokenCalls).toHaveLength(1);
    const call = vivaTokenCalls[0] as Extract<
      (typeof vivaTokenCalls)[number],
      { method: "getTokenSilent" }
    >;
    expect(call.authority).toBe(externalAuthority);
    expect(call.scopes).toEqual([YAMMER_SCOPE]);

    // mainAuth must NOT have received a Yammer-scope call.
    const mainYammerCalls = mainAuth.calls.filter(
      (c) =>
        c.method === "getTokenSilent" &&
        c.scopes?.includes(YAMMER_SCOPE) === true,
    );
    expect(mainYammerCalls).toHaveLength(0);

    const vivaRow = store.syncLog.find((e) => e.source === "viva-engage");
    expect(vivaRow?.status).toBe("ok");
  });

  it("records status=ok when syncViva self-heals a 401 mid-pass", async () => {
    // Same-tick recovery: underlying Yammer fake 401s, syncViva force-refreshes
    // the token and retries; from the scheduler's point of view it was a normal
    // success. Exactly one ok row, no error row. Closes the Observable churn
    // concern in docs/plans/viva-sync-force-refresh-on-401.md.
    const a1 = acc("alice");
    const homeAuthority = vivaAuthorityFor(a1.tenantId);

    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "do" }) },
        sentOk,
      ],
    });
    const viva = new FakeVivaClient({
      steps: [
        // First attempt: stale-tok → 401.
        { kind: "error", error: new TokenExpiredError("401") },
        // Retry with fresh-tok → empty page, still ok.
        { kind: "listThreadsOk", response: { value: [] } },
      ],
    });
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    await vivaSubs.subscribe({
      account: a1.username,
      tenantId: a1.tenantId,
      networkId: "net-1",
      communityId: "com-1",
    });

    const staleYammer: AccessToken = {
      token: "stale-yammer",
      expiresOn: new Date("2026-04-24T10:00:00Z"),
      account: a1,
    };
    const freshYammer: AccessToken = {
      token: "fresh-yammer",
      expiresOn: new Date("2026-04-24T10:05:00Z"),
      account: a1,
    };
    const vivaAuth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([
        [`${a1.homeAccountId}|${homeAuthority}`, staleYammer],
        [`${a1.homeAccountId}|${homeAuthority}|forceRefresh=true`, freshYammer],
      ]),
    });
    const mainAuth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([[a1.homeAccountId, tok(a1)]]),
    });

    const clock = new FakeClock(new Date("2026-04-24T09:05:00Z"));
    const timer = makeFakeSetTimer();
    const scheduler = new SyncScheduler({
      auth: mainAuth,
      graph,
      viva,
      vivaSubs,
      vivaAuth,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.runOnce();

    const vivaRows = store.syncLog.filter((e) => e.source === "viva-engage");
    expect(vivaRows).toHaveLength(1);
    expect(vivaRows[0]?.status).toBe("ok");
  });

  it("SyncScheduler falls back to main auth for viva when vivaAuth not set", async () => {
    // Regression guard: existing callers that don't set vivaAuth still work
    // — the scheduler uses `this.deps.auth` for viva tokens as before.
    const a1 = acc("alice");
    const homeAuthority = vivaAuthorityFor(a1.tenantId);

    const store = new InMemoryMessageStore();
    const graph = new FakeGraphClient({
      steps: [
        { kind: "ok", response: ok({ "@odata.deltaLink": "do" }) },
        sentOk,
      ],
    });
    const viva = new FakeVivaClient({
      steps: [{ kind: "listThreadsOk", response: { value: [] } }],
    });
    const vivaSubs = new InMemoryVivaSubscriptionStore();
    await vivaSubs.subscribe({
      account: a1.username,
      tenantId: a1.tenantId,
      networkId: "net-1",
      communityId: "com-1",
    });

    // Only the main auth is scripted with a token for the home authority.
    const auth = new FakeAuthClient({
      accounts: [a1],
      tokens: new Map([
        [`${a1.homeAccountId}|${homeAuthority}`, tok(a1)],
      ]),
    });

    const clock = new FakeClock(new Date("2026-04-13T12:00:00Z"));
    const timer = makeFakeSetTimer();

    const scheduler = new SyncScheduler({
      auth,
      graph,
      viva,
      vivaSubs,
      store,
      clock,
      setTimer: timer.setTimer,
      intervalMs: 1000,
    });
    await scheduler.runOnce();

    const yammerCalls = auth.calls.filter(
      (c) =>
        c.method === "getTokenSilent" &&
        c.scopes?.includes(YAMMER_SCOPE) === true,
    );
    expect(yammerCalls).toHaveLength(1);
    const vivaRow = store.syncLog.find((e) => e.source === "viva-engage");
    expect(vivaRow?.status).toBe("ok");
  });
});
