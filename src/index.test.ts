import { describe, it, expect, vi } from "vitest";
import { main, runFromCli } from "./index.js";
import { ConfigError } from "./config.js";
import { FakeAuthClient } from "./testing/fake-auth-client.js";
import { FakeGraphClient } from "./testing/fake-graph-client.js";
import { FakeTeamsClient } from "./testing/fake-teams-client.js";
import { InMemoryMessageStore } from "./testing/in-memory-message-store.js";
import type {
  SetTimerFn,
  TimerHandle,
} from "./sync/sync-scheduler.js";
import type { Logger } from "./logger.js";
import type { Signals } from "./index.js";

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
