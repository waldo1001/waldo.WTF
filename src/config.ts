export const DEFAULT_DB_PATH = "./data/lake.db";
export const DEFAULT_AUTH_DIR = "./data/auth";

export type Config = Readonly<{
  msClientId: string;
  bearerToken: string;
  dbPath: string;
  authDir: string;
}>;

export class ConfigError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(`Missing required config: ${missing.join(", ")}`);
    this.name = "ConfigError";
    this.missing = missing;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const present = (v: string | undefined): v is string => v !== undefined && v !== "";

export function loadConfig(env: Env): Config {
  const required = ["MS_CLIENT_ID", "BEARER_TOKEN"] as const;
  const missing = required.filter((k) => !present(env[k]));
  if (missing.length > 0) throw new ConfigError(missing);

  return {
    msClientId: env.MS_CLIENT_ID as string,
    bearerToken: env.BEARER_TOKEN as string,
    dbPath: present(env.WALDO_DB_PATH) ? env.WALDO_DB_PATH : DEFAULT_DB_PATH,
    authDir: present(env.WALDO_AUTH_DIR) ? env.WALDO_AUTH_DIR : DEFAULT_AUTH_DIR,
  };
}
