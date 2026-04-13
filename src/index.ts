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
} from "./sync/sync-scheduler.js";
import { createMcpHttpServer } from "./mcp/http-server.js";
import type { Server } from "node:http";

export interface MainOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly loadDotenv?: boolean;
}

export interface MainResult {
  readonly config: Config;
  readonly scheduler: SyncScheduler;
  readonly httpServer: Server;
  readonly shutdown: () => Promise<void>;
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

export async function main(opts: MainOptions = {}): Promise<MainResult> {
  if (opts.loadDotenv !== false && !opts.env) {
    loadDotenv();
  }
  const env = opts.env ?? process.env;
  const config = loadConfig(env);

  const clock: Clock = systemClock;
  const cacheStore = new TokenCacheStore({
    fs: nodeFileSystem,
    path: path.join(config.authDir, "token-cache.json"),
  });
  const auth: AuthClient = new MsalAuthClient({
    clientId: config.msClientId,
    cacheStore,
  });
  const db = openDatabase(config.dbPath);
  const store: MessageStore = new SqliteMessageStore(db);
  const graph: GraphClient = new HttpGraphClient({
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  const teams: TeamsClient = new HttpTeamsClient({
    fetch: (input, init) => globalThis.fetch(input, init),
  });

  const scheduler = new SyncScheduler({
    auth,
    graph,
    teams,
    store,
    clock,
    setTimer: nodeSetTimer,
    intervalMs: config.syncIntervalMs,
  });

  const httpServer = createMcpHttpServer({
    bearerToken: config.bearerToken,
    store,
    clock,
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, "127.0.0.1", () => resolve());
  });

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    db.close();
  };

  return { config, scheduler, httpServer, shutdown };
}
