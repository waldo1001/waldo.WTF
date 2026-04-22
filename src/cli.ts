import * as path from "node:path";
import { config as loadDotenv } from "dotenv";
import { loadConfig, type Config } from "./config.js";
import { MsalAuthClient } from "./auth/msal-auth-client.js";
import { TokenCacheStore } from "./auth/token-cache-store.js";
import type { AuthClient } from "./auth/auth-client.js";
import type { Account } from "./auth/types.js";
import { main, type MainOptions, type MainResult } from "./index.js";
import { nodeFileSystem } from "./fs-node.js";
import type {
  AddSteeringRuleInput,
  MessageSource,
  SteeringRule,
  SteeringRuleType,
  VivaSubscription,
} from "./store/types.js";
import type { VivaClient, VivaCommunity } from "./sources/viva.js";
import type { VivaSubscriptionStore } from "./store/viva-subscription-store.js";

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

export interface RethreadWhatsAppCliResult {
  readonly groups: number;
  readonly mergedGroups: number;
  readonly rowsUpdated: number;
  readonly duplicatesDropped: number;
}

export interface RethreadWhatsAppCliOptions {
  readonly dryRun?: boolean;
}

export type RethreadWhatsAppImpl = (
  dbPath: string,
  opts: RethreadWhatsAppCliOptions,
) => Promise<RethreadWhatsAppCliResult>;

export interface ImportWhatsAppCliResult {
  readonly files: number;
  readonly imported: number;
}

export type ImportWhatsAppImpl = (
  config: Config,
) => Promise<ImportWhatsAppCliResult>;

export type SteerCommand =
  | { readonly action: "add"; readonly input: AddSteeringRuleInput }
  | { readonly action: "list" }
  | {
      readonly action: "setEnabled";
      readonly id: number;
      readonly enabled: boolean;
    }
  | { readonly action: "remove"; readonly id: number };

export type SteerCliResult =
  | { readonly action: "add"; readonly rule: SteeringRule }
  | { readonly action: "list"; readonly rules: readonly SteeringRule[] }
  | {
      readonly action: "setEnabled";
      readonly rule: SteeringRule | null;
    }
  | { readonly action: "remove"; readonly removed: boolean };

export type SteerImpl = (
  config: Config,
  command: SteerCommand,
) => Promise<SteerCliResult>;

export type VivaCommand =
  | { readonly action: "list"; readonly account: string }
  | { readonly action: "discover"; readonly account: string }
  | {
      readonly action: "subscribe";
      readonly account: string;
      readonly communityId: string;
    }
  | {
      readonly action: "unsubscribe";
      readonly account: string;
      readonly communityId: string;
    };

export type VivaCliResult =
  | {
      readonly action: "list";
      readonly subs: readonly VivaSubscription[];
    }
  | {
      readonly action: "discover";
      readonly communities: readonly VivaCommunity[];
    }
  | { readonly action: "subscribe"; readonly sub: VivaSubscription }
  | { readonly action: "unsubscribe"; readonly removed: boolean };

export interface VivaDeps {
  readonly auth?: AuthClient;
  readonly viva?: VivaClient;
  readonly store?: VivaSubscriptionStore;
}

export type VivaImpl = (
  config: Config,
  command: VivaCommand,
  deps?: VivaDeps,
) => Promise<VivaCliResult>;

export interface RunCliOptions extends AddAccountOptions {
  readonly mainImpl?: (opts: MainOptions) => Promise<MainResult>;
  readonly backfillImpl?: (dbPath: string) => Promise<BackfillCliResult>;
  readonly importWhatsAppImpl?: ImportWhatsAppImpl;
  readonly steerImpl?: SteerImpl;
  readonly rethreadWhatsAppImpl?: RethreadWhatsAppImpl;
  readonly vivaImpl?: VivaImpl;
}

export type RunCliResult =
  | { readonly mode: "add-account"; readonly account: Account }
  | { readonly mode: "backfill"; readonly processed: number }
  | {
      readonly mode: "rethread-whatsapp";
      readonly groups: number;
      readonly mergedGroups: number;
      readonly rowsUpdated: number;
      readonly duplicatesDropped: number;
    }
  | {
      readonly mode: "import-whatsapp";
      readonly files: number;
      readonly imported: number;
    }
  | { readonly mode: "steer"; readonly result: SteerCliResult }
  | { readonly mode: "viva"; readonly result: VivaCliResult }
  | { readonly mode: "server"; readonly main: MainResult };

const BOOLEAN_FLAGS = new Set([
  "--add-account",
  "--backfill-bodies",
  "--import-whatsapp",
  "--rethread-whatsapp",
  "--dry-run",
  "--steer-list",
  "--viva-list",
  "--viva-discover",
]);

const VIVA_VALUE_FLAGS = new Set([
  "--viva-subscribe",
  "--viva-unsubscribe",
]);

const STEER_TOGGLE_ACTIONS: Readonly<
  Record<string, { readonly action: "setEnabled" | "remove"; readonly enabled?: boolean }>
> = {
  "--steer-enable": { action: "setEnabled", enabled: true },
  "--steer-disable": { action: "setEnabled", enabled: false },
  "--steer-remove": { action: "remove" },
};

const STEER_ADD_FLAGS: Readonly<Record<string, SteeringRuleType>> = {
  "--steer-add-sender": "sender_email",
  "--steer-add-domain": "sender_domain",
  "--steer-add-thread": "thread_id",
  "--steer-add-thread-name": "thread_name_contains",
  "--steer-add-body": "body_contains",
};

const STEER_TOGGLE_FLAGS = new Set([
  "--steer-enable",
  "--steer-disable",
  "--steer-remove",
]);

const STEER_MODIFIER_FLAGS = new Set([
  "--reason",
  "--source",
  "--account",
]);

const KNOWN_SOURCES = new Set<MessageSource>([
  "outlook",
  "teams",
  "whatsapp",
  "viva-engage",
]);

function parseArgv(argv: readonly string[]): {
  readonly boolean: Set<string>;
  readonly values: Map<string, string>;
} {
  const boolean = new Set<string>();
  const values = new Map<string, string>();
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (BOOLEAN_FLAGS.has(a)) {
      boolean.add(a);
      i += 1;
      continue;
    }
    if (
      Object.prototype.hasOwnProperty.call(STEER_ADD_FLAGS, a) ||
      STEER_TOGGLE_FLAGS.has(a) ||
      STEER_MODIFIER_FLAGS.has(a) ||
      VIVA_VALUE_FLAGS.has(a)
    ) {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new CliUsageError(`${a} requires a value`);
      }
      if (values.has(a)) {
        throw new CliUsageError(`${a} given twice`);
      }
      values.set(a, v);
      i += 2;
      continue;
    }
    throw new CliUsageError(
      `Unknown flag: ${a}. Usage: waldo-wtf [--add-account | --backfill-bodies | --import-whatsapp | --steer-* | --viva-*]`,
    );
  }
  return { boolean, values };
}

function parsePositiveIntId(raw: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new CliUsageError(`${flag} expects a positive integer, got "${raw}"`);
  }
  return Number.parseInt(raw, 10);
}

function buildAddSteerCommand(
  values: Map<string, string>,
): SteerCommand | null {
  const chosen: Array<[string, SteeringRuleType, string]> = [];
  for (const [flag, ruleType] of Object.entries(STEER_ADD_FLAGS)) {
    const v = values.get(flag);
    if (v !== undefined) chosen.push([flag, ruleType, v]);
  }
  if (chosen.length === 0) return null;
  if (chosen.length > 1) {
    throw new CliUsageError(
      `only one of ${Object.keys(STEER_ADD_FLAGS).join(", ")} may be given`,
    );
  }
  const [flag, ruleType, rawPattern] = chosen[0]!;
  const pattern = rawPattern;
  if (pattern.trim() === "") {
    throw new CliUsageError(`${flag} pattern must not be empty`);
  }
  if (ruleType === "sender_domain" && pattern.includes("@")) {
    throw new CliUsageError(
      "--steer-add-domain pattern must not contain '@'",
    );
  }
  const source = values.get("--source");
  if (source !== undefined && !KNOWN_SOURCES.has(source as MessageSource)) {
    throw new CliUsageError(
      `--source must be one of: ${[...KNOWN_SOURCES].join(", ")}`,
    );
  }
  const account = values.get("--account");
  const reason = values.get("--reason");
  const input: AddSteeringRuleInput = {
    ruleType,
    pattern,
    ...(source !== undefined && { source: source as MessageSource }),
    ...(account !== undefined && { account }),
    ...(reason !== undefined && { reason }),
  };
  return { action: "add", input };
}

function formatScope(rule: SteeringRule): string {
  const parts: string[] = [];
  if (rule.source !== undefined) parts.push(`source=${rule.source}`);
  if (rule.account !== undefined) parts.push(`account=${rule.account}`);
  if (rule.reason !== undefined) parts.push(`reason=${rule.reason}`);
  return parts.length > 0 ? parts.join(" ") : "-";
}

function resolveSteerCommand(parsed: {
  readonly boolean: Set<string>;
  readonly values: Map<string, string>;
}): SteerCommand | null {
  const addCmd = buildAddSteerCommand(parsed.values);

  const toggles: Array<[string, SteerCommand]> = [];
  for (const [flag, spec] of Object.entries(STEER_TOGGLE_ACTIONS)) {
    const v = parsed.values.get(flag);
    if (v === undefined) continue;
    const id = parsePositiveIntId(v, flag);
    if (spec.action === "remove") {
      toggles.push([flag, { action: "remove", id }]);
    } else {
      toggles.push([
        flag,
        { action: "setEnabled", id, enabled: spec.enabled === true },
      ]);
    }
  }

  const listPresent = parsed.boolean.has("--steer-list");
  const activeCount =
    (addCmd !== null ? 1 : 0) + toggles.length + (listPresent ? 1 : 0);
  if (activeCount === 0) return null;
  if (activeCount > 1) {
    throw new CliUsageError(
      "only one --steer-* command may be given per invocation",
    );
  }
  if (addCmd !== null) return addCmd;
  if (listPresent) return { action: "list" };
  return toggles[0]![1];
}

function reportSteerResult(result: SteerCliResult, print: PrintFn): void {
  switch (result.action) {
    case "add": {
      const r = result.rule;
      print(
        `added steering rule #${r.id}: ${r.ruleType}=${r.pattern}${
          r.source !== undefined ? ` source=${r.source}` : ""
        }${r.account !== undefined ? ` account=${r.account}` : ""}`,
      );
      return;
    }
    case "list":
      printRuleList(result.rules, print);
      return;
    case "setEnabled":
      if (result.rule === null) {
        print("rule not found");
      } else {
        print(
          `rule #${result.rule.id} ${result.rule.enabled ? "enabled" : "disabled"}`,
        );
      }
      return;
    case "remove":
      print(result.removed ? "removed 1 rule" : "no rule removed");
      return;
  }
}

function printRuleList(
  rules: readonly SteeringRule[],
  print: PrintFn,
): void {
  if (rules.length === 0) {
    print("no steering rules");
    return;
  }
  print(
    ["id", "type", "pattern", "scope", "enabled"].join("\t"),
  );
  for (const r of rules) {
    print(
      [
        String(r.id),
        r.ruleType,
        r.pattern,
        formatScope(r),
        r.enabled ? "yes" : "no",
      ].join("\t"),
    );
  }
}

function resolveVivaCommand(parsed: {
  readonly boolean: Set<string>;
  readonly values: Map<string, string>;
}): VivaCommand | null {
  const list = parsed.boolean.has("--viva-list");
  const discover = parsed.boolean.has("--viva-discover");
  const subscribe = parsed.values.get("--viva-subscribe");
  const unsubscribe = parsed.values.get("--viva-unsubscribe");

  const activeCount =
    (list ? 1 : 0) +
    (discover ? 1 : 0) +
    (subscribe !== undefined ? 1 : 0) +
    (unsubscribe !== undefined ? 1 : 0);
  if (activeCount === 0) return null;
  if (activeCount > 1) {
    throw new CliUsageError(
      "only one --viva-* command may be given per invocation",
    );
  }

  const account = parsed.values.get("--account");
  if (account === undefined || account.trim() === "") {
    throw new CliUsageError("--viva-* commands require --account <username>");
  }

  if (list) return { action: "list", account };
  if (discover) return { action: "discover", account };
  if (subscribe !== undefined) {
    if (subscribe.trim() === "") {
      throw new CliUsageError("--viva-subscribe pattern must not be empty");
    }
    return { action: "subscribe", account, communityId: subscribe };
  }
  /* c8 ignore next 4 -- unsubscribe is the only remaining branch */
  if (unsubscribe === undefined) return null;
  if (unsubscribe.trim() === "") {
    throw new CliUsageError("--viva-unsubscribe pattern must not be empty");
  }
  return { action: "unsubscribe", account, communityId: unsubscribe };
}

function reportVivaResult(result: VivaCliResult, print: PrintFn): void {
  switch (result.action) {
    case "list":
      if (result.subs.length === 0) {
        print("no viva subscriptions");
        return;
      }
      print(["community_id", "network_id", "name", "enabled"].join("\t"));
      for (const s of result.subs) {
        print(
          [
            s.communityId,
            s.networkId,
            s.communityName ?? "-",
            s.enabled ? "yes" : "no",
          ].join("\t"),
        );
      }
      return;
    case "discover":
      if (result.communities.length === 0) {
        print("no viva communities visible to this account");
        return;
      }
      print(["community_id", "network_id", "display_name"].join("\t"));
      for (const c of result.communities) {
        print([c.id, c.networkId, c.displayName].join("\t"));
      }
      return;
    case "subscribe":
      print(
        `subscribed to viva community ${result.sub.communityId} (network=${result.sub.networkId})`,
      );
      return;
    case "unsubscribe":
      print(
        result.removed
          ? "unsubscribed 1 community"
          : "no subscription removed",
      );
      return;
  }
}

function resolveEnv(opts: AddAccountOptions): Env {
  /* c8 ignore next -- dotenv side-effect, loaded only in production */
  if (opts.loadDotenv !== false && !opts.env) loadDotenv();
  return opts.env ?? process.env;
}

/* c8 ignore start -- real MSAL adapter, exercised only via live smoke */

async function realImportWhatsApp(
  config: Config,
): Promise<ImportWhatsAppCliResult> {
  const { default: Database } = await import("better-sqlite3");
  const { applyMigrations } = await import("./store/schema.js");
  const { SqliteMessageStore } = await import("./store/sqlite-message-store.js");
  const { importWhatsAppFile } = await import("./sync/import-whatsapp.js");
  const { systemClock } = await import("./clock.js");
  const db = new Database(config.dbPath);
  try {
    db.pragma("journal_mode = WAL");
    applyMigrations(db);
    const store = new SqliteMessageStore(db);
    let files = 0;
    let imported = 0;
    const entries = await nodeFileSystem.listDir(config.whatsappDownloadsPath);
    const matches = entries.filter(
      (name) => /^WhatsApp Chat.*\.(?:txt|zip)$/.test(name),
    );
    for (const name of matches) {
      files += 1;
      const result = await importWhatsAppFile({
        fs: nodeFileSystem,
        clock: systemClock,
        store,
        filePath: `${config.whatsappDownloadsPath}/${name}`,
        account: config.whatsappAccount,
        archiveRoot: config.whatsappArchivePath,
      });
      imported += result.imported;
      process.stdout.write(
        `  imported ${result.imported}/${result.parsed} from ${name}\n`,
      );
    }
    db.pragma("wal_checkpoint(TRUNCATE)");
    return { files, imported };
  } finally {
    db.close();
  }
}

async function realRethreadWhatsApp(
  dbPath: string,
  opts: RethreadWhatsAppCliOptions,
): Promise<RethreadWhatsAppCliResult> {
  const { default: Database } = await import("better-sqlite3");
  const { applyMigrations } = await import("./store/schema.js");
  const { rethreadWhatsApp } = await import("./store/rethread-whatsapp.js");
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    applyMigrations(db);
    const r = rethreadWhatsApp(
      db,
      opts.dryRun === true ? { dryRun: true } : {},
    );
    db.pragma("wal_checkpoint(TRUNCATE)");
    return r;
  } finally {
    db.close();
  }
}

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

async function buildDefaultVivaAuth(config: Config): Promise<AuthClient> {
  const cacheStore = new TokenCacheStore({
    fs: nodeFileSystem,
    path: path.join(config.authDir, "token-cache.json"),
  });
  return new MsalAuthClient({
    clientId: config.msClientId,
    tokenCacheStore: cacheStore,
  });
}

async function buildDefaultVivaClient(): Promise<VivaClient> {
  const { HttpVivaClient } = await import("./sources/http-viva-client.js");
  return new HttpVivaClient({ fetch: globalThis.fetch.bind(globalThis) });
}

async function resolveVivaAccount(
  auth: AuthClient,
  username: string,
): Promise<Account> {
  const accounts = await auth.listAccounts();
  const target = username.toLowerCase();
  const found = accounts.find((a) => a.username.toLowerCase() === target);
  if (!found) {
    throw new CliUsageError(
      `unknown account: ${username} — run --add-account first, or check --account spelling`,
    );
  }
  return found;
}

async function discoverAllCommunities(
  viva: VivaClient,
  token: string,
): Promise<readonly VivaCommunity[]> {
  const all: VivaCommunity[] = [];
  let nextLink: string | undefined;
  do {
    const page = await viva.listCommunities(token, nextLink);
    all.push(...page.value);
    nextLink = page["@odata.nextLink"];
  } while (nextLink !== undefined);
  return all;
}

async function discoverForAccount(
  config: Config,
  deps: VivaDeps,
  accountUsername: string,
): Promise<{ readonly communities: readonly VivaCommunity[] }> {
  const auth = deps.auth ?? (await buildDefaultVivaAuth(config));
  const account = await resolveVivaAccount(auth, accountUsername);
  const accessToken = await auth.getTokenSilent(account);
  const viva = deps.viva ?? (await buildDefaultVivaClient());
  const communities = await discoverAllCommunities(viva, accessToken.token);
  return { communities };
}

export async function realViva(
  config: Config,
  command: VivaCommand,
  deps: VivaDeps = {},
): Promise<VivaCliResult> {
  const needsStore =
    command.action === "list" ||
    command.action === "unsubscribe" ||
    command.action === "subscribe";

  let db: import("better-sqlite3").Database | null = null;
  let store: VivaSubscriptionStore | null = deps.store ?? null;

  if (needsStore && store === null) {
    const { default: Database } = await import("better-sqlite3");
    const { SqliteVivaSubscriptionStore } = await import(
      "./store/viva-subscription-store.js"
    );
    db = new Database(config.dbPath);
    db.pragma("journal_mode = WAL");
    store = new SqliteVivaSubscriptionStore(db);
  }

  try {
    switch (command.action) {
      case "list": {
        const subs = await store!.listForAccount(command.account);
        return { action: "list", subs };
      }
      case "unsubscribe": {
        const r = await store!.unsubscribe(
          command.account,
          command.communityId,
        );
        return { action: "unsubscribe", removed: r.removed };
      }
      case "discover": {
        const { communities } = await discoverForAccount(
          config,
          deps,
          command.account,
        );
        return { action: "discover", communities };
      }
      case "subscribe": {
        const { communities } = await discoverForAccount(
          config,
          deps,
          command.account,
        );
        const match = communities.find(
          (c) => c.id.toLowerCase() === command.communityId.toLowerCase(),
        );
        if (!match) {
          throw new CliUsageError(
            `unknown community: ${command.communityId} — run --viva-discover --account ${command.account} to list available communities`,
          );
        }
        const sub = await store!.subscribe({
          account: command.account,
          networkId: match.networkId,
          communityId: match.id,
          ...(match.networkName !== undefined && {
            networkName: match.networkName,
          }),
          ...(match.displayName !== undefined && {
            communityName: match.displayName,
          }),
        });
        return { action: "subscribe", sub };
      }
    }
  } finally {
    if (db !== null) db.close();
  }
}

async function realSteer(
  config: Config,
  command: SteerCommand,
): Promise<SteerCliResult> {
  const { default: Database } = await import("better-sqlite3");
  const { SqliteSteeringStore } = await import("./store/steering-store.js");
  const db = new Database(config.dbPath);
  try {
    db.pragma("journal_mode = WAL");
    const store = new SqliteSteeringStore(db);
    switch (command.action) {
      case "add": {
        const rule = await store.addRule(command.input);
        return { action: "add", rule };
      }
      case "list": {
        const rules = await store.listRules();
        return { action: "list", rules };
      }
      case "setEnabled": {
        const rule = await store.setEnabled(command.id, command.enabled);
        return { action: "setEnabled", rule };
      }
      case "remove": {
        const r = await store.removeRule(command.id);
        return { action: "remove", removed: r.removed };
      }
    }
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
  const parsed = parseArgv(argv);

  if (parsed.boolean.has("--add-account")) {
    const account = await addAccount(opts);
    return { mode: "add-account", account };
  }

  const steerCmd = resolveSteerCommand(parsed);
  if (steerCmd !== null) {
    const env = resolveEnv(opts);
    const config = loadConfig(env);
    /* c8 ignore next -- default console.log only in production */
    const print: PrintFn = opts.print ?? ((m) => console.log(m));
    /* c8 ignore next -- realSteer only constructed outside tests */
    const impl = opts.steerImpl ?? realSteer;
    const result = await impl(config, steerCmd);
    reportSteerResult(result, print);
    return { mode: "steer", result };
  }

  const vivaCmd = resolveVivaCommand(parsed);
  if (vivaCmd !== null) {
    const env = resolveEnv(opts);
    const config = loadConfig(env);
    /* c8 ignore next -- default console.log only in production */
    const print: PrintFn = opts.print ?? ((m) => console.log(m));
    /* c8 ignore next -- realViva only constructed outside tests */
    const impl = opts.vivaImpl ?? realViva;
    const result = await impl(config, vivaCmd);
    reportVivaResult(result, print);
    return { mode: "viva", result };
  }

  if (parsed.boolean.has("--import-whatsapp")) {
    const env = resolveEnv(opts);
    const config = loadConfig(env);
    /* c8 ignore next -- default console.log only in production */
    const print: PrintFn = opts.print ?? ((m) => console.log(m));
    const impl = opts.importWhatsAppImpl ?? realImportWhatsApp;
    const result = await impl(config);
    print(
      `whatsapp import complete: ${result.imported} new messages from ${result.files} files`,
    );
    return {
      mode: "import-whatsapp",
      files: result.files,
      imported: result.imported,
    };
  }
  if (parsed.boolean.has("--rethread-whatsapp")) {
    const env = resolveEnv(opts);
    const config = loadConfig(env);
    /* c8 ignore next -- default console.log only in production */
    const print: PrintFn = opts.print ?? ((m) => console.log(m));
    const impl = opts.rethreadWhatsAppImpl ?? realRethreadWhatsApp;
    const dryRun = parsed.boolean.has("--dry-run");
    const result = await impl(config.dbPath, { dryRun });
    print(
      `rethread-whatsapp ${dryRun ? "(dry-run) " : ""}complete: ${result.rowsUpdated} rows updated, ${result.duplicatesDropped} duplicates dropped across ${result.mergedGroups}/${result.groups} groups`,
    );
    return {
      mode: "rethread-whatsapp",
      groups: result.groups,
      mergedGroups: result.mergedGroups,
      rowsUpdated: result.rowsUpdated,
      duplicatesDropped: result.duplicatesDropped,
    };
  }
  if (parsed.boolean.has("--backfill-bodies")) {
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
      } else if (r.mode === "import-whatsapp") {
        console.log(
          `WhatsApp import done: ${r.imported} new messages from ${r.files} files`,
        );
        process.exit(0);
      } else if (r.mode === "rethread-whatsapp") {
        console.log(
          `WhatsApp rethread done: ${r.rowsUpdated} rows updated, ${r.duplicatesDropped} duplicates dropped across ${r.mergedGroups}/${r.groups} groups`,
        );
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
