import * as path from "node:path";
import Database from "better-sqlite3";
import { config as loadDotenv } from "dotenv";
import { loadConfig, type Config } from "./config.js";
import { systemClock, type Clock } from "./clock.js";
import {
  MsalAuthClient,
  YAMMER_PUBLIC_CLIENT_ID,
} from "./auth/msal-auth-client.js";
import { TokenCacheStore } from "./auth/token-cache-store.js";
import type { FileSystem } from "./fs.js";
import { nodeFileSystem } from "./fs-node.js";
import type { AuthClient } from "./auth/auth-client.js";
import type { MessageStore } from "./store/message-store.js";
import type { GraphClient } from "./sources/graph.js";
import { HttpGraphClient } from "./sources/http-graph-client.js";
import type { TeamsClient } from "./sources/teams.js";
import { HttpTeamsClient } from "./sources/http-teams-client.js";
import type { VivaClient } from "./sources/viva.js";
import { HttpYammerClient } from "./sources/http-yammer-client.js";
import { createFetchWithTimeout } from "./sources/fetch-with-timeout.js";
import { openDatabase } from "./store/open-database.js";
import { SqliteMessageStore } from "./store/sqlite-message-store.js";
import {
  SqliteVivaSubscriptionStore,
  type VivaSubscriptionStore,
} from "./store/viva-subscription-store.js";
import {
  SqliteSteeringStore,
  type SteeringStore,
} from "./store/steering-store.js";
import type { AuthStore } from "./auth/oauth/auth-store.js";
import { SqliteAuthStore } from "./auth/oauth/sqlite-auth-store.js";
import { cryptoRandomIdSource } from "./auth/oauth/ids.js";
import { loadOAuthConfig } from "./auth/oauth/oauth-config.js";
import { scryptPasswordHasher } from "./auth/oauth/password.js";
import {
  SyncScheduler,
  type SetTimerFn,
  type TimerHandle,
  type TickSummary,
} from "./sync/sync-scheduler.js";
import { createMcpHttpServer } from "./mcp/http-server.js";
import {
  createTimestampedConsoleLogger,
  type Logger,
} from "./logger.js";
import { importWhatsAppFile } from "./sync/import-whatsapp.js";
import {
  startWhatsAppWatcher,
  type WhatsAppWatcherHandle,
} from "./sync/whatsapp-watcher.js";
import type { Server } from "node:http";

export interface MainOverrides {
  readonly auth?: AuthClient;
  readonly vivaAuth?: AuthClient;
  readonly graph?: GraphClient;
  readonly teams?: TeamsClient;
  readonly viva?: VivaClient;
  readonly vivaSubs?: VivaSubscriptionStore;
  readonly store?: MessageStore;
  readonly steering?: SteeringStore;
  readonly authStore?: AuthStore;
  readonly setTimer?: SetTimerFn;
  readonly logger?: Logger;
  readonly fs?: FileSystem;
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
  readonly whatsappWatcher?: WhatsAppWatcherHandle;
  shutdown: () => Promise<void>;
}

export interface Signals {
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
}

export interface RunFromCliOptions extends MainOptions {
  readonly signals?: Signals;
}

const nodeSetTimer: SetTimerFn = (fn, ms): TimerHandle => {
  const h = setInterval(fn, ms);
  return { clear: () => clearInterval(h) };
};

const DEFAULT_HTTP_TIMEOUT_MS = 60_000;

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
  const clock: Clock = systemClock;
  const logger = overrides.logger ?? createTimestampedConsoleLogger(clock);
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
  // Viva needs the Yammer public clientId because --add-account --tenant
  // writes external-tenant refresh tokens under that cache partition.
  // See docs/plans/done/sync-viva-yammer-clientid.md.
  const vivaAuth: AuthClient =
    overrides.vivaAuth ??
    new MsalAuthClient({
      clientId: YAMMER_PUBLIC_CLIENT_ID,
      cacheStore,
    });
  const ownsDb = overrides.store === undefined;
  const db = ownsDb ? openDatabase(config.dbPath) : null;
  const steering: SteeringStore =
    overrides.steering ??
    (db !== null
      ? new SqliteSteeringStore(db, clock)
      : new SqliteSteeringStore(new Database(":memory:"), clock));
  const store: MessageStore =
    overrides.store ?? new SqliteMessageStore(db!, steering);
  const httpFetch = createFetchWithTimeout({
    fetch: (input, init) => globalThis.fetch(input, init),
    defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
  });
  const graph: GraphClient =
    overrides.graph ?? new HttpGraphClient({ fetch: httpFetch });
  const teams: TeamsClient =
    overrides.teams ?? new HttpTeamsClient({ fetch: httpFetch });
  const viva: VivaClient =
    overrides.viva ?? new HttpYammerClient({ fetch: httpFetch });
  const vivaSubs: VivaSubscriptionStore =
    overrides.vivaSubs ??
    (db !== null
      ? new SqliteVivaSubscriptionStore(db, clock)
      : new SqliteVivaSubscriptionStore(new Database(":memory:"), clock));

  const scheduler = new SyncScheduler({
    auth,
    vivaAuth,
    graph,
    teams,
    viva,
    vivaSubs,
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

  const oauthEnv = env.WALDO_PUBLIC_URL;
  const oauth =
    oauthEnv !== undefined && oauthEnv !== ""
      ? await (async () => {
          const oauthConfig = loadOAuthConfig(env);
          const authStore: AuthStore =
            overrides.authStore ?? new SqliteAuthStore(db!);
          let adminPasswordHash: string | undefined;
          if (oauthConfig.adminPassword !== undefined) {
            adminPasswordHash = await scryptPasswordHasher.hash(
              oauthConfig.adminPassword,
            );
          }
          return {
            publicUrl: oauthConfig.publicUrl,
            authStore,
            ids: cryptoRandomIdSource,
            adminPasswordHash,
            hasher: scryptPasswordHasher,
            disableStaticBearer: oauthConfig.disableStaticBearer,
          };
        })()
      : undefined;

  const httpServer = createMcpHttpServer({
    bearerToken: config.bearerToken,
    store,
    steering,
    clock,
    vivaSubs,
    ...(oauth !== undefined ? { oauth } : {}),
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.bindHost, () => resolve());
  });
  logger.info(
    `waldo.WTF MCP server listening on http://${config.bindHost}:${config.port}`,
  );
  logger.info("starting initial sync tick (this may take a while on first run)");

  await scheduler.start();

  let whatsappWatcher: WhatsAppWatcherHandle | undefined;
  if (config.whatsappWatch) {
    const watcherFs = overrides.fs ?? nodeFileSystem;
    whatsappWatcher = startWhatsAppWatcher({
      fs: watcherFs,
      logger,
      downloadsPath: config.whatsappDownloadsPath,
      importer: (filePath) =>
        importWhatsAppFile({
          fs: watcherFs,
          clock,
          store,
          filePath,
          account: config.whatsappAccount,
          archiveRoot: config.whatsappArchivePath,
        }),
    });
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    whatsappWatcher?.stop();
    scheduler.stop();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    if (ownsDb && db !== null) db.close();
  };

  return { config, scheduler, httpServer, whatsappWatcher, shutdown };
}

export async function runFromCli(
  opts: RunFromCliOptions = {},
): Promise<MainResult> {
  const logger =
    opts.overrides?.logger ?? createTimestampedConsoleLogger(systemClock);
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
