export const DEFAULT_DB_PATH = "./data/lake.db";
export const DEFAULT_AUTH_DIR = "./data/auth";
export const DEFAULT_PORT = 8765;
export const DEFAULT_SYNC_INTERVAL_MS = 300_000;
export const DEFAULT_BIND_HOST = "127.0.0.1";

export type Config = Readonly<{
  msClientId: string;
  bearerToken: string;
  dbPath: string;
  authDir: string;
  port: number;
  syncIntervalMs: number;
  bindHost: string;
  backfillDays?: number;
}>;

export class ConfigError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[], message?: string) {
    super(message ?? `Missing required config: ${missing.join(", ")}`);
    this.name = "ConfigError";
    this.missing = missing;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const present = (v: string | undefined): v is string => v !== undefined && v !== "";

const parsePositiveInt = (raw: string, name: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError([name], `${name} must be a positive integer, got "${raw}"`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError([name], `${name} must be a positive integer, got "${raw}"`);
  }
  return n;
};

export function loadConfig(env: Env): Config {
  const required = ["MS_CLIENT_ID", "BEARER_TOKEN"] as const;
  const missing = required.filter((k) => !present(env[k]));
  if (missing.length > 0) throw new ConfigError(missing);

  const port = present(env.WALDO_PORT)
    ? parsePositiveInt(env.WALDO_PORT, "WALDO_PORT")
    : DEFAULT_PORT;
  const syncIntervalMs = present(env.WALDO_SYNC_INTERVAL_MS)
    ? parsePositiveInt(env.WALDO_SYNC_INTERVAL_MS, "WALDO_SYNC_INTERVAL_MS")
    : DEFAULT_SYNC_INTERVAL_MS;

  const backfillDays = present(env.WALDO_BACKFILL_DAYS)
    ? parsePositiveInt(env.WALDO_BACKFILL_DAYS, "WALDO_BACKFILL_DAYS")
    : undefined;

  return {
    msClientId: env.MS_CLIENT_ID as string,
    bearerToken: env.BEARER_TOKEN as string,
    dbPath: present(env.WALDO_DB_PATH) ? env.WALDO_DB_PATH : DEFAULT_DB_PATH,
    authDir: present(env.WALDO_AUTH_DIR) ? env.WALDO_AUTH_DIR : DEFAULT_AUTH_DIR,
    port,
    syncIntervalMs,
    bindHost: present(env.WALDO_BIND_HOST) ? env.WALDO_BIND_HOST : DEFAULT_BIND_HOST,
    ...(backfillDays !== undefined ? { backfillDays } : {}),
  };
}
