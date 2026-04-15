import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "./config.js";
import { MsalAuthClient } from "./auth/msal-auth-client.js";
import { TokenCacheStore } from "./auth/token-cache-store.js";
import type { AuthClient } from "./auth/auth-client.js";
import type { Account } from "./auth/types.js";
import type { FileSystem } from "./fs.js";
import { main, type MainOptions, type MainResult } from "./index.js";

export type Env = Readonly<Record<string, string | undefined>>;
export type PrintFn = (message: string) => void;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface AddAccountOptions {
  readonly env?: Env;
  readonly loadDotenv?: boolean;
  readonly auth?: AuthClient;
  readonly print?: PrintFn;
}

export interface BackfillCliResult {
  readonly processed: number;
}

export interface RunCliOptions extends AddAccountOptions {
  readonly mainImpl?: (opts: MainOptions) => Promise<MainResult>;
  readonly backfillImpl?: (dbPath: string) => Promise<BackfillCliResult>;
}

export type RunCliResult =
  | { readonly mode: "add-account"; readonly account: Account }
  | { readonly mode: "backfill"; readonly processed: number }
  | { readonly mode: "server"; readonly main: MainResult };

const KNOWN_FLAGS = new Set(["--add-account", "--backfill-bodies"]);

function resolveEnv(opts: AddAccountOptions): Env {
  /* c8 ignore next -- dotenv side-effect, loaded only in production */
  if (opts.loadDotenv !== false && !opts.env) loadDotenv();
  return opts.env ?? process.env;
}

/* c8 ignore start -- real filesystem + MSAL adapter, exercised only via live smoke */
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
    throw new Error("not implemented: FileSystem.watch (cli stub)");
  },
  async listDir(p) {
    return fs.readdir(p);
  },
};

async function realBackfill(dbPath: string): Promise<BackfillCliResult> {
  const { default: Database } = await import("better-sqlite3");
  const { applyMigrations } = await import("./store/schema.js");
  const { backfillBodyFromHtml } = await import(
    "./store/backfill-body-from-html.js"
  );
  const { htmlToText } = await import("./text/html-to-text.js");
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    applyMigrations(db);
    const started = Date.now();
    const r = backfillBodyFromHtml({
      db,
      htmlToText,
      onProgress: (n) => {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        process.stdout.write(`  backfilled ${n} rows (${secs}s)\r`);
      },
    });
    process.stdout.write("\n");
    db.pragma("wal_checkpoint(TRUNCATE)");
    return { processed: r.processed };
  } finally {
    db.close();
  }
}

function buildRealAuth(env: Env): AuthClient {
  const config = loadConfig(env);
  const cacheStore = new TokenCacheStore({
    fs: nodeFileSystem,
    path: path.join(config.authDir, "token-cache.json"),
  });
  return new MsalAuthClient({
    clientId: config.msClientId,
    cacheStore,
  });
}
/* c8 ignore stop */

export async function addAccount(
  opts: AddAccountOptions = {},
): Promise<Account> {
  const env = resolveEnv(opts);
  loadConfig(env);
  /* c8 ignore next -- default console.log path, only in production */
  const print: PrintFn = opts.print ?? ((m) => console.log(m));
  /* c8 ignore next -- real MSAL adapter only constructed outside tests */
  const auth = opts.auth ?? buildRealAuth(env);
  return auth.loginWithDeviceCode((msg) => print(msg));
}

export async function runCli(
  argv: readonly string[],
  opts: RunCliOptions = {},
): Promise<RunCliResult> {
  for (const a of argv) {
    if (!KNOWN_FLAGS.has(a)) {
      throw new CliUsageError(
        `Unknown flag: ${a}. Usage: waldo-wtf [--add-account]`,
      );
    }
  }
  if (argv.includes("--add-account")) {
    const account = await addAccount(opts);
    return { mode: "add-account", account };
  }
  if (argv.includes("--backfill-bodies")) {
    const env = resolveEnv(opts);
    const config = loadConfig(env);
    /* c8 ignore next -- default console.log only in production */
    const print: PrintFn = opts.print ?? ((m) => console.log(m));
    const impl = opts.backfillImpl ?? realBackfill;
    const result = await impl(config.dbPath);
    print(`backfill complete: ${result.processed} messages updated`);
    return { mode: "backfill", processed: result.processed };
  }
  const mainImpl = opts.mainImpl ?? main;
  const mainOpts: MainOptions = {};
  if (opts.env !== undefined) (mainOpts as { env?: Env }).env = opts.env;
  if (opts.loadDotenv !== undefined)
    (mainOpts as { loadDotenv?: boolean }).loadDotenv = opts.loadDotenv;
  const result = await mainImpl(mainOpts);
  return { mode: "server", main: result };
}

/* c8 ignore start -- process-level bootstrap, exercised only in production */
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runCli(process.argv.slice(2))
    .then((r) => {
      if (r.mode === "add-account") {
        console.log(`Added account: ${r.account.username}`);
      } else if (r.mode === "backfill") {
        console.log(`Backfill done: ${r.processed} messages updated`);
        process.exit(0);
      }
    })
    .catch((err) => {
      if (err instanceof Error) {
        console.error(err.message);
        let c: unknown = (err as { cause?: unknown }).cause;
        while (c instanceof Error) {
          console.error(`  caused by: ${c.message}`);
          c = (c as { cause?: unknown }).cause;
        }
      } else {
        console.error(String(err));
      }
      process.exit(1);
    });
}
/* c8 ignore stop */
