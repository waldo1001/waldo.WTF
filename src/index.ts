import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config as loadDotenv } from "dotenv";
import { loadConfig, type Config } from "./config.js";
import { systemClock, type Clock } from "./clock.js";
import { MsalAuthClient } from "./auth/msal-auth-client.js";
import { TokenCacheStore } from "./auth/token-cache-store.js";
import type { FileSystem } from "./fs.js";
import type { AuthClient } from "./auth/auth-client.js";
import type { MessageStore } from "./store/message-store.js";
import type { GraphClient } from "./sources/graph.js";
import { HttpGraphClient } from "./sources/http-graph-client.js";
import type { TeamsClient } from "./sources/teams.js";
import { HttpTeamsClient } from "./sources/http-teams-client.js";
import { openDatabase } from "./store/open-database.js";
import { SqliteMessageStore } from "./store/sqlite-message-store.js";
import {
  SyncScheduler,
  type SetTimerFn,
  type TimerHandle,
  type TickSummary,
} from "./sync/sync-scheduler.js";
import { createMcpHttpServer } from "./mcp/http-server.js";
import { consoleLogger, type Logger } from "./logger.js";
import type { Server } from "node:http";

export interface MainOverrides {
  readonly auth?: AuthClient;
  readonly graph?: GraphClient;
  readonly teams?: TeamsClient;
  readonly store?: MessageStore;
  readonly setTimer?: SetTimerFn;
  readonly logger?: Logger;
}

export interface MainOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly loadDotenv?: boolean;
  readonly overrides?: MainOverrides;
}

export interface MainResult {
  readonly config: Config;
  readonly scheduler: SyncScheduler;
  readonly httpServer: Server;
  shutdown: () => Promise<void>;
}

export interface Signals {
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
}

export interface RunFromCliOptions extends MainOptions {
  readonly signals?: Signals;
}

const nodeFileSystem: FileSystem = {
  async readFile(p) {
    return fs.readFile(p);
  },
  async writeFile(p, data, mode) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data, { mode });
  },
  async rename(from, to) {
    await fs.rename(from, to);
  },
  watch() {
    throw new Error("not implemented: FileSystem.watch (composition-root stub)");
  },
  async listDir(p) {
    return fs.readdir(p);
  },
};

const nodeSetTimer: SetTimerFn = (fn, ms): TimerHandle => {
  const h = setInterval(fn, ms);
  return { clear: () => clearInterval(h) };
};

/* c8 ignore next 6 -- default process signal seam, exercised only at runtime */
const nodeSignals: Signals = {
  on(signal, handler) {
    process.on(signal, handler);
  },
};

export async function main(opts: MainOptions = {}): Promise<MainResult> {
  if (opts.loadDotenv !== false && !opts.env) {
    loadDotenv();
  }
  const env = opts.env ?? process.env;
  const config = loadConfig(env);
  const overrides = opts.overrides ?? {};
  const logger = overrides.logger ?? consoleLogger;

  const clock: Clock = systemClock;
  const cacheStore = new TokenCacheStore({
    fs: nodeFileSystem,
    path: path.join(config.authDir, "token-cache.json"),
  });
  const auth: AuthClient =
    overrides.auth ??
    new MsalAuthClient({
      clientId: config.msClientId,
      cacheStore,
    });
  const ownsDb = overrides.store === undefined;
  const db = ownsDb ? openDatabase(config.dbPath) : null;
  const store: MessageStore =
    overrides.store ?? new SqliteMessageStore(db!);
  const graph: GraphClient =
    overrides.graph ??
    new HttpGraphClient({
      fetch: (input, init) => globalThis.fetch(input, init),
    });
  const teams: TeamsClient =
    overrides.teams ??
    new HttpTeamsClient({
      fetch: (input, init) => globalThis.fetch(input, init),
    });

  const scheduler = new SyncScheduler({
    auth,
    graph,
    teams,
    store,
    clock,
    setTimer: overrides.setTimer ?? nodeSetTimer,
    intervalMs: config.syncIntervalMs,
    ...(config.backfillDays !== undefined && {
      backfillDays: config.backfillDays,
    }),
    onTickComplete: (summary: TickSummary) => {
      logger.info(
        `sync tick complete: ${summary.accounts} account(s), ` +
          `${summary.okCount} ok, ${summary.errorCount} error(s)`,
      );
    },
  });

  const httpServer = createMcpHttpServer({
    bearerToken: config.bearerToken,
    store,
    clock,
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.bindHost, () => resolve());
  });
  logger.info(
    `waldo.WTF MCP server listening on http://${config.bindHost}:${config.port}`,
  );
  logger.info("starting initial sync tick (this may take a while on first run)");

  await scheduler.start();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    scheduler.stop();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    if (ownsDb && db !== null) db.close();
  };

  return { config, scheduler, httpServer, shutdown };
}

export async function runFromCli(
  opts: RunFromCliOptions = {},
): Promise<MainResult> {
  const logger = opts.overrides?.logger ?? consoleLogger;
  const signals = opts.signals ?? nodeSignals;

  const result = await main(opts);

  const onSignal = (name: string) => () => {
    logger.info(`received ${name}, shutting down`);
    void result.shutdown();
  };
  signals.on("SIGINT", onSignal("SIGINT"));
  signals.on("SIGTERM", onSignal("SIGTERM"));

  return result;
}

/* c8 ignore next 4 -- direct-run guard, exercised only by `tsx src/index.ts` */
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/src/index.ts") === true;
if (isDirectRun) {
  void runFromCli();
}
