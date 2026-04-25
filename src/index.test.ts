import { describe, it, expect, vi } from "vitest";
import { main, runFromCli } from "./index.js";
import { ConfigError } from "./config.js";
import { FakeAuthClient } from "./testing/fake-auth-client.js";
import { FakeGraphClient } from "./testing/fake-graph-client.js";
import { FakeTeamsClient } from "./testing/fake-teams-client.js";
import { InMemoryFileSystem } from "./testing/in-memory-file-system.js";
import { InMemoryMessageStore } from "./testing/in-memory-message-store.js";
import { InMemoryAuthStore } from "./testing/in-memory-auth-store.js";
import type {
  SetTimerFn,
  TimerHandle,
} from "./sync/sync-scheduler.js";
import type { Logger } from "./logger.js";
import type { Signals } from "./index.js";
import type { AddressInfo } from "node:net";
import type { EventLoopWatchdogOptions } from "./health/event-loop-watchdog.js";
import type { SelfProbeOptions } from "./health/self-probe.js";

const randomPort = (): string =>
  String(40000 + Math.floor(Math.random() * 20000));

const makeEnv = (): Readonly<Record<string, string>> => ({
  MS_CLIENT_ID: "client-id",
  BEARER_TOKEN: "bearer-token",
  WALDO_PORT: randomPort(),
  WALDO_SYNC_INTERVAL_MS: "60000",
  WALDO_DB_PATH: ":memory:",
  WALDO_AUTH_DIR: "/tmp/waldo-test-auth",
});

interface Harness {
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  setTimer: SetTimerFn;
  logs: string[];
  errors: string[];
  logger: Logger;
  signalHandlers: Map<"SIGINT" | "SIGTERM", () => void>;
  signals: Signals;
}

const makeHarness = (): Harness => {
  const timers: Harness["timers"] = [];
  const setTimer: SetTimerFn = (fn, ms) => {
    const rec = { fn, ms, cleared: false };
    timers.push(rec);
    const handle: TimerHandle = {
      clear: () => {
        rec.cleared = true;
      },
    };
    return handle;
  };
  const logs: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    info: (m) => {
      logs.push(m);
    },
    error: (m) => {
      errors.push(m);
    },
  };
  const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
  const signals: Signals = {
    on: (signal, handler) => {
      signalHandlers.set(signal, handler);
    },
  };
  return { timers, setTimer, logs, errors, logger, signalHandlers, signals };
};

const makeOverrides = () => ({
  auth: new FakeAuthClient({ accounts: [] }),
  graph: new FakeGraphClient({ steps: [] }),
  teams: new FakeTeamsClient({ steps: [] }),
  store: new InMemoryMessageStore(),
});

describe("main", () => {
  it("throws ConfigError when required env vars are absent (no side effects)", async () => {
    await expect(main({ env: {}, loadDotenv: false })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("throws ConfigError when only BEARER_TOKEN is set", async () => {
    await expect(
      main({ env: { BEARER_TOKEN: "x" }, loadDotenv: false }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("main() calls scheduler.start so the first tick runs before returning", async () => {
    const h = makeHarness();
    const overrides = makeOverrides();
    const result = await main({
      env: makeEnv(),
      loadDotenv: false,
      overrides: { ...overrides, setTimer: h.setTimer, logger: h.logger },
    });
    // start() calls runOnce() then setTimer() exactly once
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(60000);
    await result.shutdown();
  });

  it("binds http server to configured WALDO_BIND_HOST", async () => {
    const h = makeHarness();
    const overrides = makeOverrides();
    const result = await main({
      env: { ...makeEnv(), WALDO_BIND_HOST: "0.0.0.0" },
      loadDotenv: false,
      overrides: { ...overrides, setTimer: h.setTimer, logger: h.logger },
    });
    const addr = result.httpServer.address();
    expect(addr).not.toBeNull();
    expect(typeof addr).toBe("object");
    expect((addr as { address: string }).address).toBe("0.0.0.0");
    await result.shutdown();
  });

  it("does not start the WhatsApp watcher when WALDO_WHATSAPP_WATCH is unset", async () => {
    const h = makeHarness();
    const overrides = makeOverrides();
    const result = await main({
      env: makeEnv(),
      loadDotenv: false,
      overrides: { ...overrides, setTimer: h.setTimer, logger: h.logger },
    });
    expect(result.whatsappWatcher).toBeUndefined();
    await result.shutdown();
  });

  it("starts the WhatsApp watcher when WALDO_WHATSAPP_WATCH=true and imports dropped files", async () => {
    const h = makeHarness();
    const overrides = makeOverrides();
    const fs = new InMemoryFileSystem();
    const result = await main({
      env: {
        ...makeEnv(),
        WALDO_WHATSAPP_WATCH: "true",
        WALDO_WHATSAPP_DOWNLOADS_PATH: "/tmp/dl",
        WALDO_WHATSAPP_ARCHIVE_PATH: "/tmp/archive",
      },
      loadDotenv: false,
      overrides: { ...overrides, setTimer: h.setTimer, logger: h.logger, fs },
    });
    expect(result.whatsappWatcher).toBeDefined();

    const filePath = "/tmp/dl/WhatsApp Chat - Mom.txt";
    await fs.writeFile(
      filePath,
      "[15/04/2026, 09:03:17] waldo: hi there",
    );
    fs.trigger(filePath);
    await new Promise((r) => setTimeout(r, 10));

    const recent = await overrides.store.getRecentMessages({
      since: new Date("2026-04-14T00:00:00.000Z"),
      limit: 10,
    });
    expect(recent.messages.some((m) => m.source === "whatsapp")).toBe(true);

    await result.shutdown();
  });

  it("mounts OAuth discovery + DCR routes when WALDO_PUBLIC_URL is set", async () => {
    const h = makeHarness();
    const overrides = makeOverrides();
    const authStore = new InMemoryAuthStore();
    const result = await main({
      env: {
        ...makeEnv(),
        WALDO_PUBLIC_URL: "https://nas.example.ts.net",
      },
      loadDotenv: false,
      overrides: {
        ...overrides,
        authStore,
        setTimer: h.setTimer,
        logger: h.logger,
      },
    });
    const addr = result.httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const meta = await fetch(
      `${baseUrl}/.well-known/oauth-authorization-server`,
    );
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({
      issuer: "https://nas.example.ts.net",
      registration_endpoint: "https://nas.example.ts.net/oauth/register",
    });

    const reg = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/cb"] }),
    });
    expect(reg.status).toBe(201);
    const regBody = await reg.json();
    expect(regBody.client_id).toMatch(/^[0-9a-f]{64}$/);
    expect(await authStore.getClient(regBody.client_id)).toBeDefined();

    await result.shutdown();
  });

  it("does not mount OAuth routes when WALDO_PUBLIC_URL is unset", async () => {
    const h = makeHarness();
    const overrides = makeOverrides();
    const result = await main({
      env: makeEnv(),
      loadDotenv: false,
      overrides: { ...overrides, setTimer: h.setTimer, logger: h.logger },
    });
    const addr = result.httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const meta = await fetch(
      `${baseUrl}/.well-known/oauth-authorization-server`,
    );
    expect(meta.status).toBe(401);
    await result.shutdown();
  });

  it("starts both watchdogs by default with the documented intervals", async () => {
    const h = makeHarness();
    const overrides = makeOverrides();
    const elwCalls: EventLoopWatchdogOptions[] = [];
    const spCalls: SelfProbeOptions[] = [];
    const startEventLoopWatchdog = vi.fn((opts: EventLoopWatchdogOptions) => {
      elwCalls.push(opts);
      return { stop: vi.fn() };
    });
    const startSelfProbe = vi.fn((opts: SelfProbeOptions) => {
      spCalls.push(opts);
      return { stop: vi.fn() };
    });
    const result = await main({
      env: makeEnv(),
      loadDotenv: false,
      overrides: {
        ...overrides,
        setTimer: h.setTimer,
        logger: h.logger,
        startEventLoopWatchdog,
        startSelfProbe,
      },
    });
    expect(startEventLoopWatchdog).toHaveBeenCalledTimes(1);
    expect(startSelfProbe).toHaveBeenCalledTimes(1);
    expect(elwCalls[0]!.intervalMs).toBe(5_000);
    expect(elwCalls[0]!.maxLagMs).toBe(1_000);
    expect(spCalls[0]!.intervalMs).toBe(30_000);
    expect(spCalls[0]!.timeoutMs).toBe(5_000);
    expect(spCalls[0]!.failuresBeforeWedge).toBe(3);
    await result.shutdown();
  });

  it("does not start watchdogs when WALDO_WATCHDOG_DISABLED=1", async () => {
    const h = makeHarness();
    const overrides = makeOverrides();
    const startEventLoopWatchdog = vi.fn(() => ({ stop: vi.fn() }));
    const startSelfProbe = vi.fn(() => ({ stop: vi.fn() }));
    const result = await main({
      env: { ...makeEnv(), WALDO_WATCHDOG_DISABLED: "1" },
      loadDotenv: false,
      overrides: {
        ...overrides,
        setTimer: h.setTimer,
        logger: h.logger,
        startEventLoopWatchdog,
        startSelfProbe,
      },
    });
    expect(startEventLoopWatchdog).not.toHaveBeenCalled();
    expect(startSelfProbe).not.toHaveBeenCalled();
    await result.shutdown();
  });

  it("shutdown() stops watchdogs before closing the http server", async () => {
    const h = makeHarness();
    const overrides = makeOverrides();
    const order: string[] = [];
    const elwStop = vi.fn(() => {
      order.push("elw.stop");
    });
    const spStop = vi.fn(() => {
      order.push("sp.stop");
    });
    const startEventLoopWatchdog = vi.fn(() => ({ stop: elwStop }));
    const startSelfProbe = vi.fn(() => ({ stop: spStop }));
    const result = await main({
      env: makeEnv(),
      loadDotenv: false,
      overrides: {
        ...overrides,
        setTimer: h.setTimer,
        logger: h.logger,
        startEventLoopWatchdog,
        startSelfProbe,
      },
    });
    const realClose = result.httpServer.close.bind(result.httpServer);
    result.httpServer.close = ((cb?: (err?: Error) => void) => {
      order.push("server.close");
      return realClose(cb);
    }) as typeof result.httpServer.close;
    await result.shutdown();
    expect(order.indexOf("elw.stop")).toBeLessThan(order.indexOf("server.close"));
    expect(order.indexOf("sp.stop")).toBeLessThan(order.indexOf("server.close"));
    expect(elwStop).toHaveBeenCalledTimes(1);
    expect(spStop).toHaveBeenCalledTimes(1);
  });

  it("wedge handler logs error, schedules SIGKILL fallback, then calls processExit(1)", async () => {
    const h = makeHarness();
    const overrides = makeOverrides();
    let capturedOnWedge: (() => void) | undefined;
    const startEventLoopWatchdog = vi.fn(
      (opts: EventLoopWatchdogOptions) => {
        capturedOnWedge = opts.onWedge;
        return { stop: vi.fn() };
      },
    );
    const startSelfProbe = vi.fn(() => ({ stop: vi.fn() }));
    const order: string[] = [];
    const scheduleKill = vi.fn(() => {
      order.push("scheduleKill");
    });
    const processExit = vi.fn(((_code: number) => {
      order.push("processExit");
    }) as (code: number) => never);
    const result = await main({
      env: makeEnv(),
      loadDotenv: false,
      overrides: {
        ...overrides,
        setTimer: h.setTimer,
        logger: h.logger,
        startEventLoopWatchdog,
        startSelfProbe,
        scheduleKill,
        processExit,
      },
    });
    expect(capturedOnWedge).toBeDefined();
    capturedOnWedge!();
    expect(scheduleKill).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledWith(1);
    expect(order).toEqual(["scheduleKill", "processExit"]);
    expect(h.errors.some((e) => /wedged/i.test(e))).toBe(true);
    await result.shutdown();
  });

  it("WALDO_WATCHDOG_DISABLED=1: shutdown does not blow up when handles are absent", async () => {
    const h = makeHarness();
    const overrides = makeOverrides();
    const result = await main({
      env: { ...makeEnv(), WALDO_WATCHDOG_DISABLED: "1" },
      loadDotenv: false,
      overrides: { ...overrides, setTimer: h.setTimer, logger: h.logger },
    });
    await expect(result.shutdown()).resolves.toBeUndefined();
  });

  it("shutdown() stops the scheduler, closes the server, and is safe to call twice", async () => {
    const h = makeHarness();
    const overrides = makeOverrides();
    const result = await main({
      env: makeEnv(),
      loadDotenv: false,
      overrides: { ...overrides, setTimer: h.setTimer, logger: h.logger },
    });
    await result.shutdown();
    expect(h.timers[0]!.cleared).toBe(true);
    // Second call must not throw
    await expect(result.shutdown()).resolves.toBeUndefined();
  });
});

describe("runFromCli", () => {
  it("runFromCli logs startup and one line per completed sync tick", async () => {
    const h = makeHarness();
    const overrides = makeOverrides();
    const result = await runFromCli({
      env: makeEnv(),
      loadDotenv: false,
      overrides: { ...overrides, setTimer: h.setTimer, logger: h.logger },
      signals: h.signals,
    });
    // Expect at least: one startup line + one tick line (zero-account tick)
    expect(h.logs.length).toBeGreaterThanOrEqual(2);
    expect(h.logs.some((l) => /listen|start|ready/i.test(l))).toBe(true);
    expect(h.logs.some((l) => /tick|sync/i.test(l))).toBe(true);
    await result.shutdown();
  });

  it("runFromCli invokes shutdown on SIGINT and SIGTERM", async () => {
    const h = makeHarness();
    const overrides = makeOverrides();
    const result = await runFromCli({
      env: makeEnv(),
      loadDotenv: false,
      overrides: { ...overrides, setTimer: h.setTimer, logger: h.logger },
      signals: h.signals,
    });
    expect(h.signalHandlers.has("SIGINT")).toBe(true);
    expect(h.signalHandlers.has("SIGTERM")).toBe(true);

    const shutdownSpy = vi.spyOn(result, "shutdown");
    // Fire SIGINT — shutdown runs once
    h.signalHandlers.get("SIGINT")!();
    // Fire again: no-op (idempotent) — shutdown may still resolve
    h.signalHandlers.get("SIGTERM")!();
    // Allow the async shutdown to drain
    await new Promise((r) => setTimeout(r, 0));
    expect(shutdownSpy).toHaveBeenCalled();
  });
});
