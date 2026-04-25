import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
  runCli,
  addAccount,
  CliUsageError,
  realTeams,
  realViva,
  teamsAuthorityFor,
  vivaAuthorityFor,
} from "./cli.js";
import type {
  SteerCommand,
  SteerCliResult,
  SteerImpl,
  TeamsCliResult,
  TeamsCommand,
  TeamsImpl,
  VivaCommand,
  VivaCliResult,
  VivaImpl,
  VivaDeps,
} from "./cli.js";
import type {
  TeamsChannelSubscription,
  VivaSubscription,
} from "./store/types.js";
import type { Config } from "./config.js";
import { ConfigError } from "./config.js";
import { FakeAuthClient } from "./testing/fake-auth-client.js";
import { FakeVivaClient } from "./testing/fake-viva-client.js";
import { SqliteVivaSubscriptionStore } from "./store/viva-subscription-store.js";
import { applyMigrations } from "./store/schema.js";
import { AuthError, type AccessToken, type Account } from "./auth/types.js";
import { SqliteSteeringStore } from "./store/steering-store.js";
import type { AddSteeringRuleInput, SteeringRule } from "./store/types.js";
import { FakeClock } from "./testing/fake-clock.js";
import { YAMMER_SCOPE } from "./auth/msal-auth-client.js";
import { InMemoryFileSystem } from "./testing/in-memory-file-system.js";
import { VivaExternalTenantsStore } from "./auth/viva-external-tenants-store.js";

const VALID_TENANT = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const ACCT: Account = {
  username: "new.user@example.invalid",
  homeAccountId: "home-1",
  tenantId: "tenant-1",
};

const ENV = {
  MS_CLIENT_ID: "client-xyz",
  BEARER_TOKEN: "bearer-abc",
} as const;

describe("runCli", () => {
  it("dispatches --add-account and returns the logged-in account", async () => {
    const auth = new FakeAuthClient({
      accounts: [],
      deviceCodeResult: ACCT,
      deviceCodeMessage: "visit https://microsoft.com/devicelogin and enter ABC123",
    });
    const prints: string[] = [];
    const result = await runCli(["--add-account"], {
      env: ENV,
      loadDotenv: false,
      auth,
      print: (m) => prints.push(m),
    });
    expect(result).toEqual({ mode: "add-account", account: ACCT });
    expect(auth.calls.filter((c) => c.method === "loginWithDeviceCode")).toHaveLength(1);
  });

  it("forwards the device-code prompt to the injected print callback", async () => {
    const prompt = "visit https://microsoft.com/devicelogin and enter ABC123";
    const auth = new FakeAuthClient({
      accounts: [],
      deviceCodeResult: ACCT,
      deviceCodeMessage: prompt,
    });
    const prints: string[] = [];
    await runCli(["--add-account"], {
      env: ENV,
      loadDotenv: false,
      auth,
      print: (m) => prints.push(m),
    });
    expect(prints).toContain(prompt);
  });

  it("throws ConfigError when --add-account is used without required env", async () => {
    const auth = new FakeAuthClient({ accounts: [], deviceCodeResult: ACCT });
    await expect(
      runCli(["--add-account"], {
        env: {},
        loadDotenv: false,
        auth,
        print: () => {},
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("--add-account --tenant <guid> logs in with the Yammer scope", async () => {
    const auth = new FakeAuthClient({
      accounts: [],
      deviceCodeResult: ACCT,
      deviceCodeMessage: "device code prompt",
    });
    await runCli(
      ["--add-account", "--tenant", VALID_TENANT],
      { env: ENV, loadDotenv: false, auth, print: () => {} },
    );
    const loginCall = auth.calls.find(
      (c) => c.method === "loginWithDeviceCode",
    );
    expect(loginCall).toBeDefined();
    expect(
      (
        loginCall as Extract<
          typeof loginCall,
          { method: "loginWithDeviceCode" }
        >
      )?.scopes,
    ).toEqual([YAMMER_SCOPE]);
  });

  it("--add-account --tenant records an external-tenant registration", async () => {
    const acctWithHome: Account = {
      username: "eric@example.invalid",
      homeAccountId: "eric-oid.home",
      tenantId: "home-tenant",
    };
    const auth = new FakeAuthClient({
      accounts: [],
      deviceCodeResult: acctWithHome,
    });
    const fs = new InMemoryFileSystem();
    const externalTenantsStore = new VivaExternalTenantsStore({
      fs,
      path: "/auth/viva-external-tenants.json",
    });
    await runCli(
      ["--add-account", "--tenant", VALID_TENANT],
      {
        env: ENV,
        loadDotenv: false,
        auth,
        externalTenantsStore,
        print: () => {},
      },
    );
    const regs = await externalTenantsStore.list();
    expect(regs).toEqual([
      {
        username: acctWithHome.username,
        homeAccountId: acctWithHome.homeAccountId,
        externalTenantId: VALID_TENANT,
      },
    ]);
  });

  it("--add-account without --tenant does not request the Yammer scope", async () => {
    const auth = new FakeAuthClient({
      accounts: [],
      deviceCodeResult: ACCT,
    });
    await runCli(["--add-account"], {
      env: ENV,
      loadDotenv: false,
      auth,
      print: () => {},
    });
    const loginCall = auth.calls.find(
      (c) => c.method === "loginWithDeviceCode",
    );
    expect(
      (
        loginCall as Extract<
          typeof loginCall,
          { method: "loginWithDeviceCode" }
        >
      )?.scopes,
    ).toBeUndefined();
  });

  it("--add-account --tenant <bad-guid> rejects with CliUsageError", async () => {
    const auth = new FakeAuthClient({
      accounts: [],
      deviceCodeResult: ACCT,
    });
    await expect(
      runCli(["--add-account", "--tenant", "not-a-guid"], {
        env: ENV,
        loadDotenv: false,
        auth,
        print: () => {},
      }),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("vivaAuthorityFor builds per-tenant MSAL authority URL", () => {
    expect(vivaAuthorityFor(VALID_TENANT)).toBe(
      `https://login.microsoftonline.com/${VALID_TENANT}/`,
    );
  });

  it("--tenant without --add-account is a usage error", async () => {
    await expect(
      runCli(["--tenant", VALID_TENANT], {
        env: ENV,
        loadDotenv: false,
        print: () => {},
      }),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("throws CliUsageError on an unknown flag", async () => {
    await expect(
      runCli(["--wat"], { env: ENV, loadDotenv: false, print: () => {} }),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("surfaces ConfigError for default (server) mode with empty env", async () => {
    await expect(
      runCli([], { env: {}, loadDotenv: false, print: () => {} }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("dispatches --import-whatsapp to the injected importer impl and prints the summary", async () => {
    const prints: string[] = [];
    let capturedConfig: { whatsappDownloadsPath?: string } | undefined;
    const result = await runCli(["--import-whatsapp"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      importWhatsAppImpl: async (cfg) => {
        capturedConfig = cfg;
        return { files: 3, imported: 7 };
      },
    });
    expect(result).toEqual({ mode: "import-whatsapp", files: 3, imported: 7 });
    expect(capturedConfig?.whatsappDownloadsPath).toBeDefined();
    expect(
      prints.some((p) => p.includes("7") && p.includes("3")),
    ).toBe(true);
  });

  it("dispatches --backfill-bodies to the injected backfill impl and prints processed count", async () => {
    const prints: string[] = [];
    let captured: string | undefined;
    const result = await runCli(["--backfill-bodies"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      backfillImpl: async (dbPath) => {
        captured = dbPath;
        return { processed: 42 };
      },
    });
    expect(result).toEqual({ mode: "backfill", processed: 42 });
    expect(captured).toMatch(/lake\.db$/);
    expect(prints.some((p) => p.includes("42"))).toBe(true);
  });

  it("dispatches --rethread-whatsapp to the injected impl and prints counts", async () => {
    const prints: string[] = [];
    let captured: { dbPath: string; dryRun: boolean } | undefined;
    const result = await runCli(["--rethread-whatsapp"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      rethreadWhatsAppImpl: async (dbPath, opts) => {
        captured = { dbPath, dryRun: opts.dryRun === true };
        return {
          groups: 3,
          mergedGroups: 1,
          rowsUpdated: 7,
          duplicatesDropped: 2,
        };
      },
    });
    expect(result).toEqual({
      mode: "rethread-whatsapp",
      groups: 3,
      mergedGroups: 1,
      rowsUpdated: 7,
      duplicatesDropped: 2,
    });
    expect(captured?.dbPath).toMatch(/lake\.db$/);
    expect(captured?.dryRun).toBe(false);
    expect(prints.some((p) => p.includes("7") && p.includes("2"))).toBe(true);
  });

  it("dispatches --rethread-whatsapp --dry-run and passes dryRun:true", async () => {
    let captured: { dryRun: boolean } | undefined;
    const result = await runCli(["--rethread-whatsapp", "--dry-run"], {
      env: ENV,
      loadDotenv: false,
      print: () => {},
      rethreadWhatsAppImpl: async (_dbPath, opts) => {
        captured = { dryRun: opts.dryRun === true };
        return {
          groups: 1,
          mergedGroups: 1,
          rowsUpdated: 2,
          duplicatesDropped: 0,
        };
      },
    });
    expect(captured?.dryRun).toBe(true);
    expect(result).toMatchObject({ mode: "rethread-whatsapp", rowsUpdated: 2 });
  });

  it("dispatches --steer-add-sender: lowercases email and passes AddSteeringRuleInput", async () => {
    const calls: SteerCommand[] = [];
    const rule: SteeringRule = {
      id: 1,
      ruleType: "sender_email",
      pattern: "foo@bar.com",
      enabled: true,
      createdAt: new Date("2026-04-20T12:00:00Z"),
    };
    const steerImpl: SteerImpl = async (_cfg, cmd) => {
      calls.push(cmd);
      return { action: "add", rule };
    };
    const result = await runCli(
      ["--steer-add-sender", "Foo@Bar.COM"],
      { env: ENV, loadDotenv: false, print: () => {}, steerImpl },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      action: "add",
      input: { ruleType: "sender_email", pattern: "Foo@Bar.COM" },
    });
    expect(result).toEqual({
      mode: "steer",
      result: { action: "add", rule },
    });
  });

  it("dispatches --steer-add-domain and rejects patterns containing '@'", async () => {
    const calls: SteerCommand[] = [];
    const steerImpl: SteerImpl = async (_cfg, cmd) => {
      calls.push(cmd);
      const rule: SteeringRule = {
        id: 2,
        ruleType: "sender_domain",
        pattern: "example.com",
        enabled: true,
        createdAt: new Date("2026-04-20T12:00:00Z"),
      };
      return { action: "add", rule };
    };
    await expect(
      runCli(["--steer-add-domain", "foo@example.com"], {
        env: ENV,
        loadDotenv: false,
        print: () => {},
        steerImpl,
      }),
    ).rejects.toBeInstanceOf(CliUsageError);
    expect(calls).toHaveLength(0);

    const ok = await runCli(["--steer-add-domain", "example.com"], {
      env: ENV,
      loadDotenv: false,
      print: () => {},
      steerImpl,
    });
    expect(ok.mode).toBe("steer");
    expect(calls[0]).toEqual({
      action: "add",
      input: { ruleType: "sender_domain", pattern: "example.com" },
    });
  });

  it("rejects empty --steer-add-thread-name", async () => {
    await expect(
      runCli(["--steer-add-thread-name", "   "], {
        env: ENV,
        loadDotenv: false,
        print: () => {},
        steerImpl: async () => {
          throw new Error("should not run");
        },
      }),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("--steer-add-thread stores the id verbatim (no lowercase)", async () => {
    const calls: SteerCommand[] = [];
    const steerImpl: SteerImpl = async (_cfg, cmd) => {
      calls.push(cmd);
      const rule: SteeringRule = {
        id: 3,
        ruleType: "thread_id",
        pattern: "AAMkA-Mixed-Case-Id",
        enabled: true,
        createdAt: new Date("2026-04-20T12:00:00Z"),
      };
      return { action: "add", rule };
    };
    await runCli(["--steer-add-thread", "AAMkA-Mixed-Case-Id"], {
      env: ENV,
      loadDotenv: false,
      print: () => {},
      steerImpl,
    });
    expect(calls[0]).toEqual({
      action: "add",
      input: { ruleType: "thread_id", pattern: "AAMkA-Mixed-Case-Id" },
    });
  });

  it("--steer-add-body routes to body_contains", async () => {
    const calls: SteerCommand[] = [];
    const steerImpl: SteerImpl = async (_cfg, cmd) => {
      calls.push(cmd);
      const rule: SteeringRule = {
        id: 4,
        ruleType: "body_contains",
        pattern: "sync fail",
        enabled: true,
        createdAt: new Date("2026-04-20T12:00:00Z"),
      };
      return { action: "add", rule };
    };
    await runCli(["--steer-add-body", "sync fail"], {
      env: ENV,
      loadDotenv: false,
      print: () => {},
      steerImpl,
    });
    expect(calls[0]).toEqual({
      action: "add",
      input: { ruleType: "body_contains", pattern: "sync fail" },
    });
  });

  it("--reason / --source / --account are threaded into AddSteeringRuleInput", async () => {
    const calls: SteerCommand[] = [];
    const steerImpl: SteerImpl = async (_cfg, cmd) => {
      calls.push(cmd);
      const input = (cmd as { input: AddSteeringRuleInput }).input;
      const rule: SteeringRule = {
        id: 5,
        ruleType: input.ruleType,
        pattern: input.pattern,
        ...(input.source !== undefined && { source: input.source }),
        ...(input.account !== undefined && { account: input.account }),
        ...(input.reason !== undefined && { reason: input.reason }),
        enabled: true,
        createdAt: new Date("2026-04-20T12:00:00Z"),
      };
      return { action: "add", rule };
    };
    await runCli(
      [
        "--steer-add-sender",
        "noise@example.com",
        "--reason",
        "newsletter",
        "--source",
        "outlook",
        "--account",
        "me@example.com",
      ],
      { env: ENV, loadDotenv: false, print: () => {}, steerImpl },
    );
    expect(calls[0]).toEqual({
      action: "add",
      input: {
        ruleType: "sender_email",
        pattern: "noise@example.com",
        source: "outlook",
        account: "me@example.com",
        reason: "newsletter",
      },
    });
  });

  it("--source rejects values outside the known set", async () => {
    await expect(
      runCli(
        ["--steer-add-sender", "a@b.com", "--source", "slack"],
        {
          env: ENV,
          loadDotenv: false,
          print: () => {},
          steerImpl: async () => {
            throw new Error("should not run");
          },
        },
      ),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("--steer-list prints id / type / pattern / scope / enabled rows", async () => {
    const rules: readonly SteeringRule[] = [
      {
        id: 1,
        ruleType: "sender_domain",
        pattern: "example.com",
        enabled: true,
        createdAt: new Date("2026-04-20T12:00:00Z"),
      },
      {
        id: 2,
        ruleType: "sender_email",
        pattern: "bob@example.com",
        source: "outlook",
        account: "me@example.com",
        reason: "too chatty",
        enabled: false,
        createdAt: new Date("2026-04-20T12:05:00Z"),
      },
    ];
    const steerImpl: SteerImpl = async () => ({ action: "list", rules });
    const prints: string[] = [];
    const result = await runCli(["--steer-list"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      steerImpl,
    });
    expect(result).toEqual({
      mode: "steer",
      result: { action: "list", rules },
    });
    const out = prints.join("\n");
    expect(out).toContain("id");
    expect(out).toContain("type");
    expect(out).toContain("pattern");
    expect(out).toContain("scope");
    expect(out).toContain("enabled");
    expect(out).toContain("1");
    expect(out).toContain("sender_domain");
    expect(out).toContain("example.com");
    expect(out).toContain("2");
    expect(out).toContain("bob@example.com");
    expect(out).toContain("outlook");
    expect(out).toContain("me@example.com");
  });

  it("--steer-list prints an empty-state message when no rules exist", async () => {
    const steerImpl: SteerImpl = async () => ({ action: "list", rules: [] });
    const prints: string[] = [];
    await runCli(["--steer-list"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      steerImpl,
    });
    expect(prints.some((p) => /no steering rules/i.test(p))).toBe(true);
  });

  it("--steer-disable <id> calls setEnabled(id, false)", async () => {
    const calls: SteerCommand[] = [];
    const steerImpl: SteerImpl = async (_cfg, cmd) => {
      calls.push(cmd);
      const rule: SteeringRule = {
        id: 7,
        ruleType: "sender_email",
        pattern: "bob@example.com",
        enabled: false,
        createdAt: new Date("2026-04-20T12:00:00Z"),
      };
      return { action: "setEnabled", rule };
    };
    const result = await runCli(["--steer-disable", "7"], {
      env: ENV,
      loadDotenv: false,
      print: () => {},
      steerImpl,
    });
    expect(calls[0]).toEqual({ action: "setEnabled", id: 7, enabled: false });
    expect(result.mode).toBe("steer");
  });

  it("--steer-enable <id> calls setEnabled(id, true)", async () => {
    const calls: SteerCommand[] = [];
    const steerImpl: SteerImpl = async (_cfg, cmd) => {
      calls.push(cmd);
      const rule: SteeringRule = {
        id: 8,
        ruleType: "sender_email",
        pattern: "bob@example.com",
        enabled: true,
        createdAt: new Date("2026-04-20T12:00:00Z"),
      };
      return { action: "setEnabled", rule };
    };
    await runCli(["--steer-enable", "8"], {
      env: ENV,
      loadDotenv: false,
      print: () => {},
      steerImpl,
    });
    expect(calls[0]).toEqual({ action: "setEnabled", id: 8, enabled: true });
  });

  it("--steer-disable <id> prints a not-found message when the store returns null", async () => {
    const steerImpl: SteerImpl = async () => ({
      action: "setEnabled",
      rule: null,
    });
    const prints: string[] = [];
    await runCli(["--steer-disable", "999"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      steerImpl,
    });
    expect(prints.some((p) => /not found/i.test(p))).toBe(true);
  });

  it("--steer-remove <id> calls remove and prints the count", async () => {
    const calls: SteerCommand[] = [];
    const steerImpl: SteerImpl = async (_cfg, cmd) => {
      calls.push(cmd);
      return { action: "remove", removed: true };
    };
    const prints: string[] = [];
    const result = await runCli(["--steer-remove", "3"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      steerImpl,
    });
    expect(calls[0]).toEqual({ action: "remove", id: 3 });
    expect(result).toEqual({
      mode: "steer",
      result: { action: "remove", removed: true },
    });
    expect(prints.some((p) => /removed/i.test(p))).toBe(true);
  });

  it("--steer-remove <id> reports when no rule matched", async () => {
    const steerImpl: SteerImpl = async () => ({
      action: "remove",
      removed: false,
    });
    const prints: string[] = [];
    await runCli(["--steer-remove", "999"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      steerImpl,
    });
    expect(prints.some((p) => /no rule/i.test(p))).toBe(true);
  });

  it("rejects non-integer <id> args for enable/disable/remove", async () => {
    for (const argv of [
      ["--steer-enable", "abc"],
      ["--steer-disable", "-1"],
      ["--steer-remove", "1.5"],
      ["--steer-remove", "0"],
    ]) {
      await expect(
        runCli(argv, {
          env: ENV,
          loadDotenv: false,
          print: () => {},
          steerImpl: async () => {
            throw new Error("should not run");
          },
        }),
      ).rejects.toBeInstanceOf(CliUsageError);
    }
  });

  it("rejects combining two --steer-add-* flags at once", async () => {
    await expect(
      runCli(
        ["--steer-add-sender", "a@b.com", "--steer-add-domain", "b.com"],
        {
          env: ENV,
          loadDotenv: false,
          print: () => {},
          steerImpl: async () => {
            throw new Error("should not run");
          },
        },
      ),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("rejects combining --steer-list with --steer-remove", async () => {
    await expect(
      runCli(["--steer-list", "--steer-remove", "1"], {
        env: ENV,
        loadDotenv: false,
        print: () => {},
        steerImpl: async () => {
          throw new Error("should not run");
        },
      }),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("rejects a value-carrying flag given twice", async () => {
    await expect(
      runCli(
        ["--steer-add-sender", "a@b.com", "--steer-add-sender", "c@d.com"],
        {
          env: ENV,
          loadDotenv: false,
          print: () => {},
          steerImpl: async () => {
            throw new Error("should not run");
          },
        },
      ),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("rejects --steer-add-sender without a value", async () => {
    await expect(
      runCli(["--steer-add-sender"], {
        env: ENV,
        loadDotenv: false,
        print: () => {},
        steerImpl: async () => {
          throw new Error("should not run");
        },
      }),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("integration: add → list → disable → remove round-trips against a real sqlite DB", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-steer-"));
    const dbPath = path.join(dir, "lake.db");
    const envWithDb = { ...ENV, WALDO_DB_PATH: dbPath };
    const clock = new FakeClock(new Date("2026-04-20T10:00:00Z"));
    const prints: string[] = [];
    try {
      // Construct a real SteerImpl wired to a real SqliteSteeringStore to
      // prove CLI + store integrate end-to-end.
      const steerImpl: SteerImpl = async (_cfg, cmd) => {
        const db = new Database(dbPath);
        try {
          db.pragma("journal_mode = WAL");
          const store = new SqliteSteeringStore(db, clock);
          switch (cmd.action) {
            case "add": {
              const rule = await store.addRule(cmd.input);
              return { action: "add", rule };
            }
            case "list": {
              const rules = await store.listRules();
              return { action: "list", rules };
            }
            case "setEnabled": {
              const rule = await store.setEnabled(cmd.id, cmd.enabled);
              return { action: "setEnabled", rule };
            }
            case "remove": {
              const r = await store.removeRule(cmd.id);
              return { action: "remove", removed: r.removed };
            }
          }
        } finally {
          db.close();
        }
      };

      const add = await runCli(
        ["--steer-add-domain", "marketing.example.com", "--reason", "newsletters"],
        { env: envWithDb, loadDotenv: false, print: (m) => prints.push(m), steerImpl },
      );
      expect(add.mode).toBe("steer");
      const added = (add.result as Extract<SteerCliResult, { action: "add" }>).rule;
      expect(added.pattern).toBe("marketing.example.com");
      expect(added.reason).toBe("newsletters");

      const list1 = await runCli(["--steer-list"], {
        env: envWithDb,
        loadDotenv: false,
        print: (m) => prints.push(m),
        steerImpl,
      });
      expect(
        (list1.result as Extract<SteerCliResult, { action: "list" }>).rules,
      ).toHaveLength(1);

      const dis = await runCli(["--steer-disable", String(added.id)], {
        env: envWithDb,
        loadDotenv: false,
        print: (m) => prints.push(m),
        steerImpl,
      });
      expect(
        (dis.result as Extract<SteerCliResult, { action: "setEnabled" }>).rule
          ?.enabled,
      ).toBe(false);

      const rm = await runCli(["--steer-remove", String(added.id)], {
        env: envWithDb,
        loadDotenv: false,
        print: (m) => prints.push(m),
        steerImpl,
      });
      expect(rm.result).toEqual({ action: "remove", removed: true });

      const list2 = await runCli(["--steer-list"], {
        env: envWithDb,
        loadDotenv: false,
        print: (m) => prints.push(m),
        steerImpl,
      });
      expect(
        (list2.result as Extract<SteerCliResult, { action: "list" }>).rules,
      ).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--viva-list --account a passes account to the viva impl and returns mode=viva", async () => {
    const calls: VivaCommand[] = [];
    const subs: readonly VivaSubscription[] = [
      {
        account: "a@example.test",
        networkId: "net-1",
        communityId: "com-1",
        communityName: "Engineering",
        enabled: true,
        subscribedAt: new Date("2026-04-21T10:00:00Z"),
      },
    ];
    const vivaImpl: VivaImpl = async (_cfg, cmd) => {
      calls.push(cmd);
      return { action: "list", subs };
    };
    const prints: string[] = [];
    const result = await runCli(
      ["--viva-list", "--account", "a@example.test"],
      { env: ENV, loadDotenv: false, print: (m) => prints.push(m), vivaImpl },
    );
    expect(calls[0]).toEqual({ action: "list", account: "a@example.test" });
    expect(result.mode).toBe("viva");
    const out = prints.join("\n");
    expect(out).toContain("com-1");
    expect(out).toContain("net-1");
    expect(out).toContain("Engineering");
  });

  it("--viva-list prints empty-state message when no subs", async () => {
    const vivaImpl: VivaImpl = async () => ({ action: "list", subs: [] });
    const prints: string[] = [];
    await runCli(["--viva-list", "--account", "a@example.test"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      vivaImpl,
    });
    expect(prints.some((p) => /no viva subscriptions/i.test(p))).toBe(true);
  });

  it("--viva-discover lists communities returned by the injected impl", async () => {
    const vivaImpl: VivaImpl = async () => ({
      action: "discover",
      communities: [
        {
          id: "com-99",
          displayName: "Sales",
          networkId: "net-1",
          networkName: "Contoso",
        },
      ],
    });
    const prints: string[] = [];
    const result = await runCli(
      ["--viva-discover", "--account", "a@example.test"],
      { env: ENV, loadDotenv: false, print: (m) => prints.push(m), vivaImpl },
    );
    expect(result.mode).toBe("viva");
    const out = prints.join("\n");
    expect(out).toContain("com-99");
    expect(out).toContain("Sales");
  });

  it("--viva-discover prints empty-state when no communities", async () => {
    const vivaImpl: VivaImpl = async () => ({
      action: "discover",
      communities: [],
    });
    const prints: string[] = [];
    await runCli(["--viva-discover", "--account", "a@example.test"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      vivaImpl,
    });
    expect(prints.some((p) => /no viva communities/i.test(p))).toBe(true);
  });

  it("--viva-subscribe <id> --account <a> calls subscribe and prints confirmation", async () => {
    const calls: VivaCommand[] = [];
    const sub: VivaSubscription = {
      account: "a@example.test",
      networkId: "net-1",
      communityId: "com-7",
      enabled: true,
      subscribedAt: new Date("2026-04-21T10:00:00Z"),
    };
    const vivaImpl: VivaImpl = async (_cfg, cmd) => {
      calls.push(cmd);
      return { action: "subscribe", sub };
    };
    const prints: string[] = [];
    const result = await runCli(
      [
        "--viva-subscribe",
        "com-7",
        "--account",
        "a@example.test",
      ],
      { env: ENV, loadDotenv: false, print: (m) => prints.push(m), vivaImpl },
    );
    expect(calls[0]).toEqual({
      action: "subscribe",
      account: "a@example.test",
      communityId: "com-7",
    });
    expect((result as { result: VivaCliResult }).result).toEqual({
      action: "subscribe",
      sub,
    });
    expect(prints.some((p) => p.includes("com-7"))).toBe(true);
  });

  it("--viva-subscribe surfaces impl-thrown errors (e.g. unknown community)", async () => {
    const vivaImpl: VivaImpl = async () => {
      throw new CliUsageError("unknown community: com-bogus");
    };
    await expect(
      runCli(
        ["--viva-subscribe", "com-bogus", "--account", "a@example.test"],
        { env: ENV, loadDotenv: false, print: () => {}, vivaImpl },
      ),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("--viva-unsubscribe <id> --account <a> calls unsubscribe and prints removed=true", async () => {
    const calls: VivaCommand[] = [];
    const vivaImpl: VivaImpl = async (_cfg, cmd) => {
      calls.push(cmd);
      return { action: "unsubscribe", removed: true };
    };
    const prints: string[] = [];
    await runCli(
      ["--viva-unsubscribe", "com-7", "--account", "a@example.test"],
      { env: ENV, loadDotenv: false, print: (m) => prints.push(m), vivaImpl },
    );
    expect(calls[0]).toEqual({
      action: "unsubscribe",
      account: "a@example.test",
      communityId: "com-7",
    });
    expect(prints.some((p) => /unsubscribed/i.test(p))).toBe(true);
  });

  it("--viva-unsubscribe prints no-op message when nothing was removed", async () => {
    const vivaImpl: VivaImpl = async () => ({
      action: "unsubscribe",
      removed: false,
    });
    const prints: string[] = [];
    await runCli(
      ["--viva-unsubscribe", "com-x", "--account", "a@example.test"],
      { env: ENV, loadDotenv: false, print: (m) => prints.push(m), vivaImpl },
    );
    expect(prints.some((p) => /no subscription removed/i.test(p))).toBe(true);
  });

  it("rejects --viva-* without --account", async () => {
    await expect(
      runCli(["--viva-list"], {
        env: ENV,
        loadDotenv: false,
        print: () => {},
        vivaImpl: async () => {
          throw new Error("should not run");
        },
      }),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("rejects combining two --viva-* flags at once", async () => {
    await expect(
      runCli(
        [
          "--viva-list",
          "--viva-discover",
          "--account",
          "a@example.test",
        ],
        {
          env: ENV,
          loadDotenv: false,
          print: () => {},
          vivaImpl: async () => {
            throw new Error("should not run");
          },
        },
      ),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("rejects empty --viva-subscribe value", async () => {
    await expect(
      runCli(
        ["--viva-subscribe", "   ", "--account", "a@example.test"],
        {
          env: ENV,
          loadDotenv: false,
          print: () => {},
          vivaImpl: async () => {
            throw new Error("should not run");
          },
        },
      ),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("rejects empty --viva-unsubscribe value", async () => {
    await expect(
      runCli(
        ["--viva-unsubscribe", "   ", "--account", "a@example.test"],
        {
          env: ENV,
          loadDotenv: false,
          print: () => {},
          vivaImpl: async () => {
            throw new Error("should not run");
          },
        },
      ),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("dispatches default mode to the injected main impl", async () => {
    const fakeMainResult = { sentinel: "main" } as unknown as Awaited<
      ReturnType<typeof import("./index.js").main>
    >;
    let captured: unknown;
    const result = await runCli([], {
      env: ENV,
      loadDotenv: false,
      print: () => {},
      mainImpl: async (opts) => {
        captured = opts;
        return fakeMainResult;
      },
    });
    expect(result).toEqual({ mode: "server", main: fakeMainResult });
    expect(captured).toEqual({ env: ENV, loadDotenv: false });
  });

  it("--teams-list --account a passes account to the teams impl and prints rows", async () => {
    const calls: TeamsCommand[] = [];
    const subs: readonly TeamsChannelSubscription[] = [
      {
        account: "a@example.test",
        teamId: "team-1",
        teamName: "Engineering",
        channelId: "chan-1",
        channelName: "General",
        enabled: true,
        subscribedAt: new Date("2026-04-21T10:00:00Z"),
      },
    ];
    const teamsImpl: TeamsImpl = async (_cfg, cmd) => {
      calls.push(cmd);
      return { action: "list", subs };
    };
    const prints: string[] = [];
    const result = await runCli(
      ["--teams-list", "--account", "a@example.test"],
      { env: ENV, loadDotenv: false, print: (m) => prints.push(m), teamsImpl },
    );
    expect(calls[0]).toEqual({ action: "list", account: "a@example.test" });
    expect(result.mode).toBe("teams");
    const out = prints.join("\n");
    expect(out).toContain("team-1");
    expect(out).toContain("chan-1");
    expect(out).toContain("Engineering");
    expect(out).toContain("General");
  });

  it("--teams-list prints empty-state message when no subs", async () => {
    const teamsImpl: TeamsImpl = async () => ({ action: "list", subs: [] });
    const prints: string[] = [];
    await runCli(["--teams-list", "--account", "a@example.test"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      teamsImpl,
    });
    expect(
      prints.some((p) => /no teams channel subscriptions/i.test(p)),
    ).toBe(true);
  });

  it("--teams-discover lists channels returned by the injected impl", async () => {
    const teamsImpl: TeamsImpl = async () => ({
      action: "discover",
      channels: [
        {
          tenantId: "tenant-z",
          teamId: "team-9",
          teamName: "Sales",
          channelId: "chan-9",
          channelName: "Pipeline",
          membershipType: "standard",
        },
      ],
    });
    const prints: string[] = [];
    const result = await runCli(
      ["--teams-discover", "--account", "a@example.test"],
      { env: ENV, loadDotenv: false, print: (m) => prints.push(m), teamsImpl },
    );
    expect(result.mode).toBe("teams");
    const out = prints.join("\n");
    expect(out).toContain("team-9");
    expect(out).toContain("chan-9");
    expect(out).toContain("Pipeline");
  });

  it("reportTeamsResult discover output prints tenant_id as first column", async () => {
    const teamsImpl: TeamsImpl = async () => ({
      action: "discover",
      channels: [
        {
          tenantId: "tenant-zzz",
          teamId: "team-1",
          teamName: "Engineering",
          channelId: "chan-1",
          channelName: "General",
          membershipType: "standard",
        },
      ],
    });
    const prints: string[] = [];
    await runCli(["--teams-discover", "--account", "a@example.test"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      teamsImpl,
    });
    expect(prints[0]?.split("\t")[0]).toBe("tenant_id");
    expect(prints[1]?.split("\t")[0]).toBe("tenant-zzz");
  });

  it("--teams-discover prints empty-state when no channels", async () => {
    const teamsImpl: TeamsImpl = async () => ({
      action: "discover",
      channels: [],
    });
    const prints: string[] = [];
    await runCli(["--teams-discover", "--account", "a@example.test"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      teamsImpl,
    });
    expect(prints.some((p) => /no teams channels/i.test(p))).toBe(true);
  });

  it("--teams-subscribe team:channel calls subscribe and prints confirmation", async () => {
    const calls: TeamsCommand[] = [];
    const sub: TeamsChannelSubscription = {
      account: "a@example.test",
      teamId: "team-1",
      channelId: "chan-1",
      enabled: true,
      subscribedAt: new Date("2026-04-21T10:00:00Z"),
    };
    const teamsImpl: TeamsImpl = async (_cfg, cmd) => {
      calls.push(cmd);
      return { action: "subscribe", sub };
    };
    const prints: string[] = [];
    const result = await runCli(
      [
        "--teams-subscribe",
        "team-1:chan-1",
        "--account",
        "a@example.test",
      ],
      { env: ENV, loadDotenv: false, print: (m) => prints.push(m), teamsImpl },
    );
    expect(calls[0]).toEqual({
      action: "subscribe",
      account: "a@example.test",
      teamId: "team-1",
      channelId: "chan-1",
    });
    expect((result as { result: TeamsCliResult }).result).toEqual({
      action: "subscribe",
      sub,
    });
    expect(prints.some((p) => p.includes("team-1:chan-1"))).toBe(true);
  });

  it("--teams-subscribe surfaces impl-thrown errors (e.g. unknown channel)", async () => {
    const teamsImpl: TeamsImpl = async () => {
      throw new CliUsageError("unknown channel");
    };
    await expect(
      runCli(
        ["--teams-subscribe", "team-x:chan-x", "--account", "a@example.test"],
        { env: ENV, loadDotenv: false, print: () => {}, teamsImpl },
      ),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("--teams-unsubscribe team:channel calls unsubscribe and prints removed=true", async () => {
    const calls: TeamsCommand[] = [];
    const teamsImpl: TeamsImpl = async (_cfg, cmd) => {
      calls.push(cmd);
      return { action: "unsubscribe", removed: true };
    };
    const prints: string[] = [];
    await runCli(
      ["--teams-unsubscribe", "team-1:chan-1", "--account", "a@example.test"],
      { env: ENV, loadDotenv: false, print: (m) => prints.push(m), teamsImpl },
    );
    expect(calls[0]).toEqual({
      action: "unsubscribe",
      account: "a@example.test",
      teamId: "team-1",
      channelId: "chan-1",
    });
    expect(prints.some((p) => /unsubscribed/i.test(p))).toBe(true);
  });

  it("--teams-unsubscribe prints no-op message when nothing was removed", async () => {
    const teamsImpl: TeamsImpl = async () => ({
      action: "unsubscribe",
      removed: false,
    });
    const prints: string[] = [];
    await runCli(
      ["--teams-unsubscribe", "team-1:chan-1", "--account", "a@example.test"],
      { env: ENV, loadDotenv: false, print: (m) => prints.push(m), teamsImpl },
    );
    expect(prints.some((p) => /no subscription removed/i.test(p))).toBe(true);
  });

  it("rejects --teams-* without --account", async () => {
    await expect(
      runCli(["--teams-list"], {
        env: ENV,
        loadDotenv: false,
        print: () => {},
        teamsImpl: async () => {
          throw new Error("should not run");
        },
      }),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("rejects combining two --teams-* flags at once", async () => {
    await expect(
      runCli(
        [
          "--teams-list",
          "--teams-discover",
          "--account",
          "a@example.test",
        ],
        {
          env: ENV,
          loadDotenv: false,
          print: () => {},
          teamsImpl: async () => {
            throw new Error("should not run");
          },
        },
      ),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("rejects --teams-subscribe value without ':' separator", async () => {
    await expect(
      runCli(
        ["--teams-subscribe", "no-colon", "--account", "a@example.test"],
        {
          env: ENV,
          loadDotenv: false,
          print: () => {},
          teamsImpl: async () => {
            throw new Error("should not run");
          },
        },
      ),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it("rejects empty --teams-subscribe value", async () => {
    await expect(
      runCli(
        ["--teams-subscribe", "   ", "--account", "a@example.test"],
        {
          env: ENV,
          loadDotenv: false,
          print: () => {},
          teamsImpl: async () => {
            throw new Error("should not run");
          },
        },
      ),
    ).rejects.toBeInstanceOf(CliUsageError);
  });
});

describe("addAccount", () => {
  it("returns the account from the injected auth client", async () => {
    const auth = new FakeAuthClient({
      accounts: [],
      deviceCodeResult: ACCT,
      deviceCodeMessage: "hello",
    });
    const account = await addAccount({
      env: ENV,
      loadDotenv: false,
      auth,
      print: () => {},
    });
    expect(account).toEqual(ACCT);
  });

  it("throws ConfigError when env is missing", async () => {
    await expect(
      addAccount({ env: {}, loadDotenv: false, print: () => {} }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("surfaces AuthError when device-code login fails", async () => {
    const auth = new FakeAuthClient({
      accounts: [],
      deviceCodeResult: new AuthError("device-code-failed", "user canceled"),
    });
    await expect(
      addAccount({ env: ENV, loadDotenv: false, auth, print: () => {} }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("forwards the device-code prompt to print", async () => {
    const auth = new FakeAuthClient({
      accounts: [],
      deviceCodeResult: ACCT,
      deviceCodeMessage: "enter code XYZ",
    });
    const prints: string[] = [];
    await addAccount({
      env: ENV,
      loadDotenv: false,
      auth,
      print: (m) => prints.push(m),
    });
    expect(prints).toEqual(["enter code XYZ"]);
  });
});

describe("realViva (default Viva impl wired in cli.ts)", () => {
  function makeConfig(dbPath: string): Config {
    return {
      msClientId: "client-xyz",
      bearerToken: "bearer-abc",
      dbPath,
      authDir: path.dirname(dbPath),
      port: 18765,
      syncIntervalMs: 30_000,
      bindHost: "127.0.0.1",
      whatsappDownloadsPath: path.join(path.dirname(dbPath), "wa"),
      whatsappArchivePath: path.join(path.dirname(dbPath), "wa-archive"),
      whatsappAccount: "whatsapp@example.invalid",
      whatsappWatch: false,
    };
  }

  const VIVA_ACCOUNT: Account = {
    username: "a@example.test",
    homeAccountId: "home-a",
    tenantId: "tenant-a",
  };

  function makeAuth(token = "access-token-xyz"): FakeAuthClient {
    return new FakeAuthClient({
      accounts: [VIVA_ACCOUNT],
      tokens: new Map([
        [
          VIVA_ACCOUNT.homeAccountId,
          {
            token,
            expiresOn: new Date("2099-01-01T00:00:00Z"),
            account: VIVA_ACCOUNT,
          },
        ],
      ]),
    });
  }

  it("realViva --viva-discover discovers communities across multiple networks", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      db.close();

      const auth = makeAuth("tok-123");
      const viva = new FakeVivaClient({
        steps: [
          {
            kind: "listNetworksOk",
            response: [
              { id: "net-1", name: "Acme", permalink: "acme" },
              { id: "net-2", name: "Partner", permalink: "partner" },
            ],
          },
          {
            kind: "listCommunitiesOk",
            response: [
              { id: "com-1", displayName: "Alpha", networkId: "net-1" },
              { id: "com-2", displayName: "Beta", networkId: "net-1" },
              { id: "com-3", displayName: "Gamma", networkId: "net-2" },
            ],
          },
        ],
      });

      const config = makeConfig(dbPath);
      const deps: VivaDeps = { auth, viva };
      const result = await realViva(
        config,
        { action: "discover", account: "a@example.test" },
        deps,
      );

      expect(result.action).toBe("discover");
      const communities =
        (result as Extract<VivaCliResult, { action: "discover" }>).communities;
      expect(communities.map((c) => c.id)).toEqual(["com-1", "com-2", "com-3"]);

      const networkCall = viva.calls.find((c) => c.method === "listNetworks");
      expect(networkCall).toMatchObject({ token: "tok-123" });
      const commCalls = viva.calls.filter((c) => c.method === "listCommunities");
      expect(commCalls).toHaveLength(1);
      expect(commCalls[0]).toMatchObject({ token: "tok-123" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--viva-discover acquires token with the Yammer scope", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-scope-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      db.close();

      const auth = makeAuth("tok-scope");
      const viva = new FakeVivaClient({
        steps: [
          { kind: "listNetworksOk", response: [] },
          { kind: "listCommunitiesOk", response: [] },
        ],
      });

      const config = makeConfig(dbPath);
      await realViva(
        config,
        { action: "discover", account: "a@example.test" },
        { auth, viva },
      );

      const tokenCall = auth.calls.find((c) => c.method === "getTokenSilent");
      expect(tokenCall).toBeDefined();
      expect(
        (tokenCall as Extract<typeof tokenCall, { method: "getTokenSilent" }>)
          ?.scopes,
      ).toEqual([YAMMER_SCOPE]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("realViva --viva-subscribe inserts a row carrying networkId + names from discover", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      const store = new SqliteVivaSubscriptionStore(db);

      const auth = makeAuth("tok-sub");
      const viva = new FakeVivaClient({
        steps: [
          {
            kind: "listNetworksOk",
            response: [{ id: "net-42", name: "Acme Corp", permalink: "acme-corp" }],
          },
          {
            kind: "listCommunitiesOk",
            response: [
              {
                id: "COM-7",
                displayName: "Sales",
                networkId: "net-42",
              },
            ],
          },
        ],
      });

      const config = makeConfig(dbPath);
      const result = await realViva(
        config,
        {
          action: "subscribe",
          account: "a@example.test",
          communityId: "COM-7",
        },
        { auth, viva, store },
      );

      expect(result.action).toBe("subscribe");
      const sub = (result as Extract<VivaCliResult, { action: "subscribe" }>)
        .sub;
      expect(sub).toMatchObject({
        account: "a@example.test",
        networkId: "net-42",
        networkName: "Acme Corp",
        communityId: "COM-7",
        communityName: "Sales",
        enabled: true,
      });

      const rows = await store.listForAccount("a@example.test");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        communityId: "COM-7",
        networkId: "net-42",
        communityName: "Sales",
      });

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("realViva --viva-subscribe throws CliUsageError when communityId is not in the discover response", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      const store = new SqliteVivaSubscriptionStore(db);

      const auth = makeAuth();
      const viva = new FakeVivaClient({
        steps: [
          {
            kind: "listNetworksOk",
            response: [{ id: "net-1", name: "Acme", permalink: "acme" }],
          },
          {
            kind: "listCommunitiesOk",
            response: [{ id: "com-real", displayName: "Real", networkId: "net-1" }],
          },
        ],
      });

      const config = makeConfig(dbPath);
      await expect(
        realViva(
          config,
          {
            action: "subscribe",
            account: "a@example.test",
            communityId: "com-bogus",
          },
          { auth, viva, store },
        ),
      ).rejects.toBeInstanceOf(CliUsageError);

      expect(await store.listForAccount("a@example.test")).toEqual([]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("realViva throws CliUsageError with an add-account hint when --account is not logged in", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      const store = new SqliteVivaSubscriptionStore(db);
      db.close();

      const auth = new FakeAuthClient({ accounts: [] });
      const viva = new FakeVivaClient({ steps: [] });
      const config = makeConfig(dbPath);

      const err = await realViva(
        config,
        { action: "discover", account: "ghost@example.test" },
        { auth, viva, store },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CliUsageError);
      expect((err as Error).message).toMatch(/ghost@example\.test/);
      expect((err as Error).message).toMatch(/--add-account/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("realViva --viva-discover triggers loginWithDeviceCode for Yammer scope when silent token fails", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-fallback-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      db.close();

      const tokenResult = {
        token: "tok-ym",
        expiresOn: new Date("2099-01-01T00:00:00Z"),
        account: VIVA_ACCOUNT,
      };
      let yammerConsented = false;
      const deviceCodePrompts: string[] = [];
      const deviceCodeScopes: Array<readonly string[] | undefined> = [];
      const auth: import("./auth/auth-client.js").AuthClient = {
        listAccounts: async () => [VIVA_ACCOUNT],
        getTokenSilent: async (_account, opts) => {
          if (!yammerConsented) throw new AuthError("silent-failed", "not yet");
          return tokenResult;
        },
        loginWithDeviceCode: async (onPrompt, opts) => {
          deviceCodeScopes.push(opts?.scopes);
          yammerConsented = true;
          onPrompt("visit https://example.invalid/devicelogin");
          deviceCodePrompts.push("visited");
          return VIVA_ACCOUNT;
        },
      };
      const viva = new FakeVivaClient({
        steps: [
          { kind: "listNetworksOk", response: [] },
          { kind: "listCommunitiesOk", response: [] },
        ],
      });

      const prints: string[] = [];
      const result = await realViva(
        makeConfig(dbPath),
        { action: "discover", account: "a@example.test" },
        { auth, viva, print: (m) => prints.push(m) },
      );

      expect(result.action).toBe("discover");
      expect(deviceCodeScopes).toHaveLength(1);
      expect(deviceCodeScopes[0]).toEqual([YAMMER_SCOPE]);
      expect(prints.some((p) => /yammer/i.test(p))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("realViva --viva-discover propagates error when Yammer token still fails after device-code consent", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-fallback-err-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      db.close();

      const persistentError = new AuthError("silent-failed", "always fails");
      const auth: import("./auth/auth-client.js").AuthClient = {
        listAccounts: async () => [VIVA_ACCOUNT],
        getTokenSilent: async () => {
          throw persistentError;
        },
        loginWithDeviceCode: async () => VIVA_ACCOUNT,
      };
      const viva = new FakeVivaClient({ steps: [] });

      await expect(
        realViva(
          makeConfig(dbPath),
          { action: "discover", account: "a@example.test" },
          { auth, viva },
        ),
      ).rejects.toBe(persistentError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Slice 3: discover output + subscribe disambiguation ─────────────────

  it("reportVivaResult discover prints network_name as 4th column", async () => {
    const vivaImpl: VivaImpl = async () => ({
      action: "discover",
      communities: [
        { id: "com-1", displayName: "Engineering", networkId: "net-1", networkName: "Acme Corp" },
      ],
    });
    const prints: string[] = [];
    await runCli(["--viva-discover", "--account", "a@example.test"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      vivaImpl,
    });
    expect(prints[0]).toContain("network_name");
    expect(prints[1]).toContain("Acme Corp");
  });

  it("--viva-subscribe <networkId>:<communityId> resolves unambiguously", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-colon-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      const store = new SqliteVivaSubscriptionStore(db);

      const auth = makeAuth("tok-colon");
      const viva = new FakeVivaClient({
        steps: [
          {
            kind: "listNetworksOk",
            response: [
              { id: "net-1", name: "Acme", permalink: "acme" },
              { id: "net-2", name: "Partner", permalink: "partner" },
            ],
          },
          {
            kind: "listCommunitiesOk",
            response: [
              { id: "com-1", displayName: "Eng", networkId: "net-1" },
              { id: "com-1", displayName: "Sales", networkId: "net-2" },
            ],
          },
        ],
      });

      // Same community id in two networks — colon format picks net-2:com-1
      const result = await realViva(
        makeConfig(dbPath),
        { action: "subscribe", account: "a@example.test", communityId: "net-2:com-1" },
        { auth, viva, store },
      );
      expect(result.action).toBe("subscribe");
      const sub = (result as Extract<VivaCliResult, { action: "subscribe" }>).sub;
      expect(sub.networkId).toBe("net-2");
      expect(sub.communityId).toBe("com-1");
      expect(sub.communityName).toBe("Sales");

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--viva-subscribe throws CliUsageError when communityId is ambiguous across networks", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-ambig-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      const store = new SqliteVivaSubscriptionStore(db);

      const auth = makeAuth("tok-ambig");
      const viva = new FakeVivaClient({
        steps: [
          {
            kind: "listNetworksOk",
            response: [
              { id: "net-1", name: "Acme", permalink: "acme" },
              { id: "net-2", name: "Partner", permalink: "partner" },
            ],
          },
          {
            kind: "listCommunitiesOk",
            response: [
              { id: "com-dup", displayName: "Eng", networkId: "net-1" },
              { id: "com-dup", displayName: "Sales", networkId: "net-2" },
            ],
          },
        ],
      });

      await expect(
        realViva(
          makeConfig(dbPath),
          { action: "subscribe", account: "a@example.test", communityId: "com-dup" },
          { auth, viva, store },
        ),
      ).rejects.toBeInstanceOf(CliUsageError);

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Slice 4b-2: cross-tenant subscribe disambiguation ─────────────

  it("--viva-subscribe tenantId:networkId:communityId resolves across tenants", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-3part-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      const store = new SqliteVivaSubscriptionStore(db);

      const HOME_ACCT: Account = {
        username: "a@example.test",
        homeAccountId: "oid-1.tenant-home",
        tenantId: "tenant-home",
      };
      const GUEST_TENANT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
      const guestAuthority = vivaAuthorityFor(GUEST_TENANT);
      const auth = new FakeAuthClient({
        accounts: [HOME_ACCT],
        tokens: new Map<
          string,
          { token: string; expiresOn: Date; account: Account }
        >([
          [
            HOME_ACCT.homeAccountId,
            {
              token: "tok-home",
              expiresOn: new Date("2099-01-01T00:00:00Z"),
              account: HOME_ACCT,
            },
          ],
          [
            `${HOME_ACCT.homeAccountId}|${guestAuthority}`,
            {
              token: "tok-guest",
              expiresOn: new Date("2099-01-01T00:00:00Z"),
              account: HOME_ACCT,
            },
          ],
        ]),
      });
      const viva = new FakeVivaClient({
        steps: [
          {
            kind: "listNetworksOk",
            response: [{ id: "net-home", name: "Dynex", permalink: "dynex" }],
          },
          {
            kind: "listCommunitiesOk",
            response: [
              { id: "com-dup", displayName: "HomeDup", networkId: "net-home" },
            ],
          },
          {
            kind: "listNetworksOk",
            response: [{ id: "net-107", name: "Microsoft", permalink: "ms" }],
          },
          {
            kind: "listCommunitiesOk",
            response: [
              { id: "com-dup", displayName: "GuestDup", networkId: "net-107" },
            ],
          },
        ],
      });
      const externalTenantsStore = new VivaExternalTenantsStore({
        fs: new InMemoryFileSystem(),
        path: "/auth/viva-external-tenants.json",
      });
      await externalTenantsStore.add({
        username: HOME_ACCT.username,
        homeAccountId: HOME_ACCT.homeAccountId,
        externalTenantId: GUEST_TENANT,
      });

      const result = await realViva(
        makeConfig(dbPath),
        {
          action: "subscribe",
          account: "a@example.test",
          communityId: `${GUEST_TENANT}:net-107:com-dup`,
        },
        { auth, viva, store, externalTenantsStore },
      );
      expect(result.action).toBe("subscribe");
      const sub = (result as Extract<VivaCliResult, { action: "subscribe" }>).sub;
      expect(sub.tenantId).toBe(GUEST_TENANT);
      expect(sub.networkId).toBe("net-107");
      expect(sub.communityId).toBe("com-dup");
      expect(sub.communityName).toBe("GuestDup");

      const rows = await store.listForAccount("a@example.test");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tenantId).toBe(GUEST_TENANT);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--viva-subscribe ambiguous community across tenants throws CliUsageError", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-tambig-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      const store = new SqliteVivaSubscriptionStore(db);

      const HOME_ACCT: Account = {
        username: "a@example.test",
        homeAccountId: "oid-1.tenant-home",
        tenantId: "tenant-home",
      };
      const GUEST_TENANT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
      const guestAuthority = vivaAuthorityFor(GUEST_TENANT);
      const auth = new FakeAuthClient({
        accounts: [HOME_ACCT],
        tokens: new Map<
          string,
          { token: string; expiresOn: Date; account: Account }
        >([
          [
            HOME_ACCT.homeAccountId,
            {
              token: "tok-home",
              expiresOn: new Date("2099-01-01T00:00:00Z"),
              account: HOME_ACCT,
            },
          ],
          [
            `${HOME_ACCT.homeAccountId}|${guestAuthority}`,
            {
              token: "tok-guest",
              expiresOn: new Date("2099-01-01T00:00:00Z"),
              account: HOME_ACCT,
            },
          ],
        ]),
      });
      const viva = new FakeVivaClient({
        steps: [
          {
            kind: "listNetworksOk",
            response: [{ id: "net-home", name: "Dynex", permalink: "dynex" }],
          },
          {
            kind: "listCommunitiesOk",
            response: [
              { id: "com-dup", displayName: "HomeDup", networkId: "net-home" },
            ],
          },
          {
            kind: "listNetworksOk",
            response: [{ id: "net-107", name: "Microsoft", permalink: "ms" }],
          },
          {
            kind: "listCommunitiesOk",
            response: [
              { id: "com-dup", displayName: "GuestDup", networkId: "net-107" },
            ],
          },
        ],
      });
      const externalTenantsStore = new VivaExternalTenantsStore({
        fs: new InMemoryFileSystem(),
        path: "/auth/viva-external-tenants.json",
      });
      await externalTenantsStore.add({
        username: HOME_ACCT.username,
        homeAccountId: HOME_ACCT.homeAccountId,
        externalTenantId: GUEST_TENANT,
      });

      const err = await realViva(
        makeConfig(dbPath),
        {
          action: "subscribe",
          account: "a@example.test",
          communityId: "com-dup",
        },
        { auth, viva, store, externalTenantsStore },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CliUsageError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/tenant-home/);
      expect(msg).toMatch(new RegExp(GUEST_TENANT));
      expect(msg).toContain("<tenantId>:<networkId>:<communityId>");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--viva-subscribe persists tenantId on single-tenant auto-resolve", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-1tenant-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      const store = new SqliteVivaSubscriptionStore(db);

      const auth = makeAuth("tok-1tenant");
      const viva = new FakeVivaClient({
        steps: [
          {
            kind: "listNetworksOk",
            response: [{ id: "net-1", name: "Acme", permalink: "acme" }],
          },
          {
            kind: "listCommunitiesOk",
            response: [{ id: "com-7", displayName: "Eng", networkId: "net-1" }],
          },
        ],
      });

      const result = await realViva(
        makeConfig(dbPath),
        { action: "subscribe", account: "a@example.test", communityId: "com-7" },
        { auth, viva, store },
      );
      const sub = (result as Extract<VivaCliResult, { action: "subscribe" }>).sub;
      expect(sub.tenantId).toBe(VIVA_ACCOUNT.tenantId);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--viva-discover prints network count and names", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-netlog-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      db.close();

      const auth = makeAuth("tok-netlog");
      const viva = new FakeVivaClient({
        steps: [
          {
            kind: "listNetworksOk",
            response: [
              { id: "net-1", name: "Acme Corp", permalink: "acme" },
              { id: "net-2", name: "Partner Net", permalink: "partner" },
            ],
          },
          { kind: "listCommunitiesOk", response: [] },
        ],
      });
      const prints: string[] = [];
      await realViva(
        makeConfig(dbPath),
        { action: "discover", account: "a@example.test" },
        { auth, viva, print: (m) => prints.push(m) },
      );
      const out = prints.join("\n");
      expect(out).toContain("Found 2 network(s)");
      expect(out).toContain("Acme Corp");
      expect(out).toContain("Partner Net");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Slice 4b-4: per-tenant authority fan-out ─────────────────

  it("--viva-discover fans out across registered external tenants with per-tenant authority", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-ext-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      db.close();

      const HOME_TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const EXT_TENANT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
      const HOME_ACCT: Account = {
        username: "eric@example.invalid",
        homeAccountId: `eric-oid.${HOME_TENANT}`,
        tenantId: HOME_TENANT,
      };
      const HOME_AUTHORITY = vivaAuthorityFor(HOME_TENANT);
      const EXT_AUTHORITY = vivaAuthorityFor(EXT_TENANT);
      const auth = new FakeAuthClient({
        accounts: [HOME_ACCT],
        tokens: new Map<
          string,
          { token: string; expiresOn: Date; account: Account }
        >([
          [
            `${HOME_ACCT.homeAccountId}|${HOME_AUTHORITY}`,
            {
              token: "home-token",
              expiresOn: new Date("2099-01-01T00:00:00Z"),
              account: HOME_ACCT,
            },
          ],
          [
            `${HOME_ACCT.homeAccountId}|${EXT_AUTHORITY}`,
            {
              token: "ms-token",
              expiresOn: new Date("2099-01-01T00:00:00Z"),
              account: HOME_ACCT,
            },
          ],
        ]),
      });
      const viva = new FakeVivaClient({
        steps: [
          {
            kind: "listNetworksOk",
            response: [{ id: "net-home", name: "Example Home", permalink: "home" }],
          },
          {
            kind: "listCommunitiesOk",
            response: [
              { id: "com-home-1", displayName: "Home Net", networkId: "net-home" },
            ],
          },
          {
            kind: "listNetworksOk",
            response: [{ id: "net-107", name: "BC Partners", permalink: "bcp" }],
          },
          {
            kind: "listCommunitiesOk",
            response: [
              { id: "com-bcp-1", displayName: "BC Partners | MVPs", networkId: "net-107" },
              { id: "com-bcp-2", displayName: "BC Partners | Dev", networkId: "net-107" },
            ],
          },
        ],
      });

      const externalTenantsStore = new VivaExternalTenantsStore({
        fs: new InMemoryFileSystem(),
        path: "/auth/viva-external-tenants.json",
      });
      await externalTenantsStore.add({
        username: HOME_ACCT.username,
        homeAccountId: HOME_ACCT.homeAccountId,
        externalTenantId: EXT_TENANT,
      });

      const result = await realViva(
        makeConfig(dbPath),
        { action: "discover", account: HOME_ACCT.username },
        { auth, viva, externalTenantsStore },
      );
      expect(result.action).toBe("discover");
      const communities = (
        result as Extract<VivaCliResult, { action: "discover" }>
      ).communities;
      expect(communities.map((c) => c.id).sort()).toEqual(
        ["com-bcp-1", "com-bcp-2", "com-home-1"].sort(),
      );
      const byId = new Map(communities.map((c) => [c.id, c] as const));
      expect(byId.get("com-home-1")?.tenantId).toBe(HOME_TENANT);
      expect(byId.get("com-bcp-1")?.tenantId).toBe(EXT_TENANT);
      expect(byId.get("com-bcp-2")?.tenantId).toBe(EXT_TENANT);

      const silentCalls = auth.calls.filter(
        (c) => c.method === "getTokenSilent",
      );
      expect(silentCalls).toHaveLength(2);
      const authorities = silentCalls.map((c) =>
        (c as Extract<typeof silentCalls[number], { method: "getTokenSilent" }>)
          .authority,
      );
      expect(authorities).toEqual([HOME_AUTHORITY, EXT_AUTHORITY]);

      const tokens = viva.calls
        .filter((c) => c.method === "listCommunities")
        .map((c) => c.token)
        .sort();
      expect(tokens).toEqual(["home-token", "ms-token"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--viva-discover passes explicit account-tenant authority on home fetch", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-home-only-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      db.close();

      const auth = makeAuth("home-only");
      const viva = new FakeVivaClient({
        steps: [
          {
            kind: "listNetworksOk",
            response: [{ id: "net-home", name: "Home", permalink: "home" }],
          },
          {
            kind: "listCommunitiesOk",
            response: [
              { id: "com-home-1", displayName: "Home", networkId: "net-home" },
            ],
          },
        ],
      });
      const externalTenantsStore = new VivaExternalTenantsStore({
        fs: new InMemoryFileSystem(),
        path: "/auth/viva-external-tenants.json",
      });

      const result = await realViva(
        makeConfig(dbPath),
        { action: "discover", account: "a@example.test" },
        { auth, viva, externalTenantsStore },
      );
      const communities = (
        result as Extract<VivaCliResult, { action: "discover" }>
      ).communities;
      expect(communities.map((c) => c.id)).toEqual(["com-home-1"]);
      expect(communities[0]?.tenantId).toBe("tenant-a");

      const silent = auth.calls.filter((c) => c.method === "getTokenSilent");
      expect(silent).toHaveLength(1);
      expect(
        (silent[0] as Extract<typeof silent[number], { method: "getTokenSilent" }>)
          .authority,
      ).toBe(vivaAuthorityFor("tenant-a"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failing external-tenant silent acquisition is logged and skipped", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-skip-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      db.close();

      const HOME_TENANT = "aaaaaaaa-1111-1111-1111-111111111111";
      const GOOD_TENANT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
      const BAD_TENANT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
      const HOME_ACCT: Account = {
        username: "eric@example.invalid",
        homeAccountId: `eric-oid.${HOME_TENANT}`,
        tenantId: HOME_TENANT,
      };
      const homeAuthority = vivaAuthorityFor(HOME_TENANT);
      const goodAuthority = vivaAuthorityFor(GOOD_TENANT);
      const badAuthority = vivaAuthorityFor(BAD_TENANT);
      const auth = new FakeAuthClient({
        accounts: [HOME_ACCT],
        tokens: new Map<
          string,
          { token: string; expiresOn: Date; account: Account } | Error
        >([
          [
            `${HOME_ACCT.homeAccountId}|${homeAuthority}`,
            {
              token: "home-tok",
              expiresOn: new Date("2099-01-01T00:00:00Z"),
              account: HOME_ACCT,
            },
          ],
          [
            `${HOME_ACCT.homeAccountId}|${goodAuthority}`,
            {
              token: "good-tok",
              expiresOn: new Date("2099-01-01T00:00:00Z"),
              account: HOME_ACCT,
            },
          ],
          [
            `${HOME_ACCT.homeAccountId}|${badAuthority}`,
            new AuthError("silent-failed", "consent revoked"),
          ],
        ]),
      });
      const viva = new FakeVivaClient({
        steps: [
          { kind: "listNetworksOk", response: [] },
          { kind: "listCommunitiesOk", response: [] },
          {
            kind: "listNetworksOk",
            response: [{ id: "net-good", name: "Good", permalink: "good" }],
          },
          {
            kind: "listCommunitiesOk",
            response: [
              { id: "com-good-1", displayName: "Good", networkId: "net-good" },
            ],
          },
        ],
      });
      const externalTenantsStore = new VivaExternalTenantsStore({
        fs: new InMemoryFileSystem(),
        path: "/auth/viva-external-tenants.json",
      });
      await externalTenantsStore.add({
        username: HOME_ACCT.username,
        homeAccountId: HOME_ACCT.homeAccountId,
        externalTenantId: BAD_TENANT,
      });
      await externalTenantsStore.add({
        username: HOME_ACCT.username,
        homeAccountId: HOME_ACCT.homeAccountId,
        externalTenantId: GOOD_TENANT,
      });

      const prints: string[] = [];
      const result = await realViva(
        makeConfig(dbPath),
        { action: "discover", account: HOME_ACCT.username },
        {
          auth,
          viva,
          externalTenantsStore,
          print: (m) => prints.push(m),
        },
      );
      const communities = (
        result as Extract<VivaCliResult, { action: "discover" }>
      ).communities;
      expect(communities.map((c) => c.id)).toEqual(["com-good-1"]);
      expect(communities[0]?.tenantId).toBe(GOOD_TENANT);
      expect(
        prints.some(
          (p) => p.includes(BAD_TENANT) && /skip/i.test(p),
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--viva-discover matches registrations by username, not homeAccountId", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-match-username-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      db.close();

      const HOME_TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const EXT_TENANT = "cccccccc-cccc-cccc-cccc-cccccccccccc";
      const HOME_ACCT: Account = {
        username: "Eric@Example.invalid",
        homeAccountId: `eric-oid.${HOME_TENANT}`,
        tenantId: HOME_TENANT,
      };
      const homeAuthority = vivaAuthorityFor(HOME_TENANT);
      const extAuthority = vivaAuthorityFor(EXT_TENANT);
      const auth = new FakeAuthClient({
        accounts: [HOME_ACCT],
        tokens: new Map<
          string,
          { token: string; expiresOn: Date; account: Account }
        >([
          [
            `${HOME_ACCT.homeAccountId}|${homeAuthority}`,
            {
              token: "home-tok",
              expiresOn: new Date("2099-01-01T00:00:00Z"),
              account: HOME_ACCT,
            },
          ],
          [
            `${HOME_ACCT.homeAccountId}|${extAuthority}`,
            {
              token: "ext-tok",
              expiresOn: new Date("2099-01-01T00:00:00Z"),
              account: HOME_ACCT,
            },
          ],
        ]),
      });
      const viva = new FakeVivaClient({
        steps: [
          { kind: "listNetworksOk", response: [] },
          { kind: "listCommunitiesOk", response: [] },
          {
            kind: "listNetworksOk",
            response: [{ id: "net-ext", name: "Ext", permalink: "ext" }],
          },
          {
            kind: "listCommunitiesOk",
            response: [
              { id: "com-ext-1", displayName: "Ext C1", networkId: "net-ext" },
            ],
          },
        ],
      });
      const externalTenantsStore = new VivaExternalTenantsStore({
        fs: new InMemoryFileSystem(),
        path: "/auth/viva-external-tenants.json",
      });
      // Registration's homeAccountId differs from the resolved account's
      // (MSAL cache shuffled — the guest-tenant login minted a different
      // homeAccountId). Username matches case-insensitively; that's what
      // we key on now.
      await externalTenantsStore.add({
        username: "eric@example.invalid",
        homeAccountId: "different-oid.different-home",
        externalTenantId: EXT_TENANT,
      });

      const result = await realViva(
        makeConfig(dbPath),
        { action: "discover", account: HOME_ACCT.username },
        { auth, viva, externalTenantsStore },
      );
      const communities = (
        result as Extract<VivaCliResult, { action: "discover" }>
      ).communities;
      expect(communities.map((c) => c.id)).toEqual(["com-ext-1"]);
      expect(communities[0]?.tenantId).toBe(EXT_TENANT);

      const silent = auth.calls.filter((c) => c.method === "getTokenSilent");
      expect(silent).toHaveLength(2);
      const authorities = silent.map(
        (c) =>
          (c as Extract<typeof silent[number], { method: "getTokenSilent" }>)
            .authority,
      );
      expect(authorities).toEqual([homeAuthority, extAuthority]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--viva-discover skips registrations that duplicate the home tenant", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-cli-viva-dedupe-"));
    try {
      const dbPath = path.join(dir, "lake.db");
      const db = new Database(dbPath);
      applyMigrations(db);
      db.close();

      const HOME_TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const HOME_ACCT: Account = {
        username: "eric@example.invalid",
        homeAccountId: `eric-oid.${HOME_TENANT}`,
        tenantId: HOME_TENANT,
      };
      const homeAuthority = vivaAuthorityFor(HOME_TENANT);
      const auth = new FakeAuthClient({
        accounts: [HOME_ACCT],
        tokens: new Map<
          string,
          { token: string; expiresOn: Date; account: Account }
        >([
          [
            `${HOME_ACCT.homeAccountId}|${homeAuthority}`,
            {
              token: "home-tok",
              expiresOn: new Date("2099-01-01T00:00:00Z"),
              account: HOME_ACCT,
            },
          ],
        ]),
      });
      const viva = new FakeVivaClient({
        steps: [
          {
            kind: "listNetworksOk",
            response: [{ id: "net-home", name: "Home", permalink: "home" }],
          },
          {
            kind: "listCommunitiesOk",
            response: [
              { id: "com-home-1", displayName: "Home C1", networkId: "net-home" },
            ],
          },
        ],
      });
      const externalTenantsStore = new VivaExternalTenantsStore({
        fs: new InMemoryFileSystem(),
        path: "/auth/viva-external-tenants.json",
      });
      // Registration's externalTenantId equals the home tenant — the user
      // accidentally ran --add-account --tenant <their-own-home>. Already
      // covered by home discover, so skip.
      await externalTenantsStore.add({
        username: HOME_ACCT.username,
        homeAccountId: HOME_ACCT.homeAccountId,
        externalTenantId: HOME_TENANT,
      });

      const prints: string[] = [];
      const result = await realViva(
        makeConfig(dbPath),
        { action: "discover", account: HOME_ACCT.username },
        { auth, viva, externalTenantsStore, print: (m) => prints.push(m) },
      );
      const communities = (
        result as Extract<VivaCliResult, { action: "discover" }>
      ).communities;
      expect(communities.map((c) => c.id)).toEqual(["com-home-1"]);

      // Only one silent call (home fetch) — the dupe registration is skipped.
      const silent = auth.calls.filter((c) => c.method === "getTokenSilent");
      expect(silent).toHaveLength(1);
      // And only one "Found N network(s)" line — no duplicate discovery.
      expect(prints.filter((p) => /Found \d+ network/.test(p))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reportVivaResult discover output prints tenant_id column", async () => {
    const vivaImpl: VivaImpl = async () => ({
      action: "discover",
      communities: [
        {
          id: "com-1",
          displayName: "Engineering",
          networkId: "net-1",
          networkName: "Acme Corp",
          tenantId: "tenant-abc",
        },
      ],
    });
    const prints: string[] = [];
    await runCli(["--viva-discover", "--account", "a@example.test"], {
      env: ENV,
      loadDotenv: false,
      print: (m) => prints.push(m),
      vivaImpl,
    });
    expect(prints[0]).toContain("tenant_id");
    expect(prints[1]).toContain("tenant-abc");
  });
});

describe("realTeams (default Teams Channels impl wired in cli.ts)", () => {
  const ACCT_T: Account = {
    username: "alice@example.test",
    homeAccountId: "home-a",
    tenantId: "tenant-a",
  };

  function makeConfig(dbPath: string): Config {
    return {
      msClientId: "client-xyz",
      bearerToken: "bearer-abc",
      dbPath,
      authDir: path.dirname(dbPath),
      port: 18765,
      syncIntervalMs: 30_000,
      bindHost: "127.0.0.1",
      whatsappDownloadsPath: path.join(path.dirname(dbPath), "wa"),
      whatsappArchivePath: path.join(path.dirname(dbPath), "wa-archive"),
      whatsappAccount: "whatsapp@example.invalid",
      whatsappWatch: false,
    };
  }

  function withTmpDb<T>(fn: (cfg: Config) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(path.join(tmpdir(), "waldo-realteams-"));
    const dbPath = path.join(dir, "lake.db");
    const dbInit = new Database(dbPath);
    try {
      dbInit.pragma("journal_mode = WAL");
      applyMigrations(dbInit);
    } finally {
      dbInit.close();
    }
    const cfg = makeConfig(dbPath);
    return fn(cfg).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  it("realTeams --teams-discover requests TEAMS_CHANNEL_SCOPES and returns channels per team", async () => {
    await withTmpDb(async (cfg) => {
      const auth = new FakeAuthClient({
        accounts: [ACCT_T],
        tokens: new Map([
          [
            ACCT_T.homeAccountId,
            {
              token: "tok-tch",
              expiresOn: new Date("2026-04-30"),
              account: ACCT_T,
            },
          ],
        ]),
      });
      const { FakeTeamsChannelClient } = await import(
        "./testing/fake-teams-channel-client.js"
      );
      const client = new FakeTeamsChannelClient({
        steps: [
          {
            kind: "listJoinedTeamsOk",
            response: [
              { id: "team-1", displayName: "Engineering" },
              { id: "team-2", displayName: "Sales" },
            ],
          },
          {
            kind: "listChannelsOk",
            teamId: "team-1",
            response: [
              {
                id: "chan-1",
                displayName: "General",
                membershipType: "standard",
              },
            ],
          },
          {
            kind: "listChannelsOk",
            teamId: "team-2",
            response: [
              {
                id: "chan-2",
                displayName: "Pipeline",
                membershipType: "private",
              },
            ],
          },
        ],
      });
      const result = await realTeams(
        cfg,
        { action: "discover", account: ACCT_T.username },
        { auth, client, print: () => {} },
      );
      expect(result.action).toBe("discover");
      const channels = (result as Extract<
        TeamsCliResult,
        { action: "discover" }
      >).channels;
      expect(channels).toHaveLength(2);
      expect(channels[0]).toEqual({
        tenantId: "tenant-a",
        teamId: "team-1",
        teamName: "Engineering",
        channelId: "chan-1",
        channelName: "General",
        membershipType: "standard",
      });
      const tokenCall = auth.calls.find((c) => c.method === "getTokenSilent");
      expect(tokenCall).toBeDefined();
      expect(
        (tokenCall as Extract<typeof tokenCall, { method: "getTokenSilent" }>)
          ?.scopes,
      ).toEqual([
        "Team.ReadBasic.All",
        "Channel.ReadBasic.All",
        "ChannelMessage.Read.All",
      ]);
    });
  });

  it("realTeams --teams-discover isolates per-tenant consent-required errors and surfaces them as skip lines", async () => {
    await withTmpDb(async (cfg) => {
      const ACCT_GOOD: Account = {
        username: "alice@example.test",
        homeAccountId: "home-good",
        tenantId: "tenant-good",
      };
      const ACCT_BAD: Account = {
        username: "alice@example.test",
        homeAccountId: "home-bad",
        tenantId: "tenant-bad",
      };
      const consentError = new AuthError(
        "silent-failed",
        "MSAL silent token acquisition failed",
        {
          cause: new Error(
            "AADSTS65001: The user or administrator has not consented to use the application.",
          ),
        },
      );
      const auth = new FakeAuthClient({
        accounts: [ACCT_GOOD, ACCT_BAD],
        tokens: new Map<string, AccessToken | Error>([
          [
            `${ACCT_GOOD.homeAccountId}|${teamsAuthorityFor(ACCT_GOOD.tenantId)}`,
            {
              token: "tok-good",
              expiresOn: new Date("2026-04-30"),
              account: ACCT_GOOD,
            },
          ],
          [
            `${ACCT_BAD.homeAccountId}|${teamsAuthorityFor(ACCT_BAD.tenantId)}`,
            consentError,
          ],
        ]),
      });
      const { FakeTeamsChannelClient } = await import(
        "./testing/fake-teams-channel-client.js"
      );
      const client = new FakeTeamsChannelClient({
        steps: [
          {
            kind: "listJoinedTeamsOk",
            response: [{ id: "team-g", displayName: "Good Eng" }],
          },
          {
            kind: "listChannelsOk",
            teamId: "team-g",
            response: [{ id: "chan-g", displayName: "General" }],
          },
        ],
      });
      const prints: string[] = [];
      const result = await realTeams(
        cfg,
        { action: "discover", account: "alice@example.test" },
        { auth, client, print: (m) => prints.push(m) },
      );
      const channels = (result as Extract<
        TeamsCliResult,
        { action: "discover" }
      >).channels;
      expect(channels.map((c) => c.channelId)).toEqual(["chan-g"]);
      expect(channels[0]?.tenantId).toBe("tenant-good");
      expect(prints).toContain(
        `skipped tenant tenant-bad: admin-consent required`,
      );
    });
  });

  it("realTeams --teams-subscribe with tenantId:teamId:channelId resolves the right tenant and persists tenantId", async () => {
    await withTmpDb(async (cfg) => {
      const ACCT_X: Account = {
        username: "alice@example.test",
        homeAccountId: "home-x",
        tenantId: "tenant-x",
      };
      const ACCT_Y: Account = {
        username: "alice@example.test",
        homeAccountId: "home-y",
        tenantId: "tenant-y",
      };
      const auth = new FakeAuthClient({
        accounts: [ACCT_X, ACCT_Y],
        tokens: new Map<string, AccessToken | Error>([
          [
            `${ACCT_X.homeAccountId}|${teamsAuthorityFor(ACCT_X.tenantId)}`,
            {
              token: "tok-x",
              expiresOn: new Date("2026-04-30"),
              account: ACCT_X,
            },
          ],
          [
            `${ACCT_Y.homeAccountId}|${teamsAuthorityFor(ACCT_Y.tenantId)}`,
            {
              token: "tok-y",
              expiresOn: new Date("2026-04-30"),
              account: ACCT_Y,
            },
          ],
        ]),
      });
      const { FakeTeamsChannelClient } = await import(
        "./testing/fake-teams-channel-client.js"
      );
      const client = new FakeTeamsChannelClient({
        steps: [
          {
            kind: "listJoinedTeamsOk",
            response: [{ id: "team-shared", displayName: "Shared X" }],
          },
          {
            kind: "listChannelsOk",
            teamId: "team-shared",
            response: [
              { id: "chan-shared", displayName: "General X" },
            ],
          },
          {
            kind: "listJoinedTeamsOk",
            response: [{ id: "team-shared", displayName: "Shared Y" }],
          },
          {
            kind: "listChannelsOk",
            teamId: "team-shared",
            response: [
              { id: "chan-shared", displayName: "General Y" },
            ],
          },
        ],
      });
      const result = await realTeams(
        cfg,
        {
          action: "subscribe",
          account: "alice@example.test",
          tenantId: "tenant-y",
          teamId: "team-shared",
          channelId: "chan-shared",
        },
        { auth, client, print: () => {} },
      );
      const sub = (result as Extract<TeamsCliResult, { action: "subscribe" }>)
        .sub;
      expect(sub.tenantId).toBe("tenant-y");
      expect(sub.teamId).toBe("team-shared");
      expect(sub.channelId).toBe("chan-shared");
    });
  });

  it("realTeams --teams-subscribe ambiguous teamId:channelId across tenants throws CliUsageError naming candidates", async () => {
    await withTmpDb(async (cfg) => {
      const ACCT_X: Account = {
        username: "alice@example.test",
        homeAccountId: "home-x",
        tenantId: "tenant-x",
      };
      const ACCT_Y: Account = {
        username: "alice@example.test",
        homeAccountId: "home-y",
        tenantId: "tenant-y",
      };
      const auth = new FakeAuthClient({
        accounts: [ACCT_X, ACCT_Y],
        tokens: new Map<string, AccessToken | Error>([
          [
            `${ACCT_X.homeAccountId}|${teamsAuthorityFor(ACCT_X.tenantId)}`,
            {
              token: "tok-x",
              expiresOn: new Date("2026-04-30"),
              account: ACCT_X,
            },
          ],
          [
            `${ACCT_Y.homeAccountId}|${teamsAuthorityFor(ACCT_Y.tenantId)}`,
            {
              token: "tok-y",
              expiresOn: new Date("2026-04-30"),
              account: ACCT_Y,
            },
          ],
        ]),
      });
      const { FakeTeamsChannelClient } = await import(
        "./testing/fake-teams-channel-client.js"
      );
      const client = new FakeTeamsChannelClient({
        steps: [
          {
            kind: "listJoinedTeamsOk",
            response: [{ id: "team-shared", displayName: "Shared X" }],
          },
          {
            kind: "listChannelsOk",
            teamId: "team-shared",
            response: [{ id: "chan-shared", displayName: "General X" }],
          },
          {
            kind: "listJoinedTeamsOk",
            response: [{ id: "team-shared", displayName: "Shared Y" }],
          },
          {
            kind: "listChannelsOk",
            teamId: "team-shared",
            response: [{ id: "chan-shared", displayName: "General Y" }],
          },
        ],
      });
      let caught: unknown;
      try {
        await realTeams(
          cfg,
          {
            action: "subscribe",
            account: "alice@example.test",
            teamId: "team-shared",
            channelId: "chan-shared",
          },
          { auth, client, print: () => {} },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CliUsageError);
      const msg = (caught as Error).message;
      expect(msg).toContain("tenant-x");
      expect(msg).toContain("tenant-y");
    });
  });

  it("realTeams --teams-discover with every tenant failing returns no channels and prints one skip line per tenant", async () => {
    await withTmpDb(async (cfg) => {
      const ACCT_X: Account = {
        username: "alice@example.test",
        homeAccountId: "home-x",
        tenantId: "tenant-x",
      };
      const ACCT_Y: Account = {
        username: "alice@example.test",
        homeAccountId: "home-y",
        tenantId: "tenant-y",
      };
      const consentError = new AuthError(
        "silent-failed",
        "MSAL silent token acquisition failed",
        {
          cause: new Error("AADSTS65001: consent required"),
        },
      );
      const auth = new FakeAuthClient({
        accounts: [ACCT_X, ACCT_Y],
        tokens: new Map<string, AccessToken | Error>([
          [
            `${ACCT_X.homeAccountId}|${teamsAuthorityFor(ACCT_X.tenantId)}`,
            consentError,
          ],
          [
            `${ACCT_Y.homeAccountId}|${teamsAuthorityFor(ACCT_Y.tenantId)}`,
            consentError,
          ],
        ]),
      });
      const { FakeTeamsChannelClient } = await import(
        "./testing/fake-teams-channel-client.js"
      );
      const client = new FakeTeamsChannelClient({ steps: [] });
      const prints: string[] = [];
      const result = await realTeams(
        cfg,
        { action: "discover", account: "alice@example.test" },
        { auth, client, print: (m) => prints.push(m) },
      );
      const channels = (result as Extract<
        TeamsCliResult,
        { action: "discover" }
      >).channels;
      expect(channels).toEqual([]);
      const skipLines = prints.filter((p) => p.startsWith("skipped tenant "));
      expect(skipLines).toHaveLength(2);
      expect(skipLines).toContain(
        "skipped tenant tenant-x: admin-consent required",
      );
      expect(skipLines).toContain(
        "skipped tenant tenant-y: admin-consent required",
      );
    });
  });

  it("realTeams --teams-subscribe inserts a row carrying team/channel names from discover", async () => {
    await withTmpDb(async (cfg) => {
      const auth = new FakeAuthClient({
        accounts: [ACCT_T],
        tokens: new Map([
          [
            ACCT_T.homeAccountId,
            {
              token: "tok-tch",
              expiresOn: new Date("2026-04-30"),
              account: ACCT_T,
            },
          ],
        ]),
      });
      const { FakeTeamsChannelClient } = await import(
        "./testing/fake-teams-channel-client.js"
      );
      const client = new FakeTeamsChannelClient({
        steps: [
          {
            kind: "listJoinedTeamsOk",
            response: [{ id: "team-1", displayName: "Engineering" }],
          },
          {
            kind: "listChannelsOk",
            teamId: "team-1",
            response: [
              {
                id: "chan-1",
                displayName: "General",
                membershipType: "standard",
              },
            ],
          },
        ],
      });
      const result = await realTeams(
        cfg,
        {
          action: "subscribe",
          account: ACCT_T.username,
          teamId: "team-1",
          channelId: "chan-1",
        },
        { auth, client, print: () => {} },
      );
      const sub = (result as Extract<TeamsCliResult, { action: "subscribe" }>)
        .sub;
      expect(sub.teamId).toBe("team-1");
      expect(sub.channelId).toBe("chan-1");
      expect(sub.teamName).toBe("Engineering");
      expect(sub.channelName).toBe("General");
      expect(sub.enabled).toBe(true);

      const list = await realTeams(
        cfg,
        { action: "list", account: ACCT_T.username },
        {},
      );
      const subs = (list as Extract<TeamsCliResult, { action: "list" }>).subs;
      expect(subs).toHaveLength(1);
    });
  });

  it("realTeams --teams-subscribe throws CliUsageError when channel is not in discover", async () => {
    await withTmpDb(async (cfg) => {
      const auth = new FakeAuthClient({
        accounts: [ACCT_T],
        tokens: new Map([
          [
            ACCT_T.homeAccountId,
            {
              token: "tok-tch",
              expiresOn: new Date("2026-04-30"),
              account: ACCT_T,
            },
          ],
        ]),
      });
      const { FakeTeamsChannelClient } = await import(
        "./testing/fake-teams-channel-client.js"
      );
      const client = new FakeTeamsChannelClient({
        steps: [
          {
            kind: "listJoinedTeamsOk",
            response: [{ id: "team-1", displayName: "Engineering" }],
          },
          {
            kind: "listChannelsOk",
            teamId: "team-1",
            response: [
              { id: "chan-1", displayName: "General" },
            ],
          },
        ],
      });
      await expect(
        realTeams(
          cfg,
          {
            action: "subscribe",
            account: ACCT_T.username,
            teamId: "team-1",
            channelId: "chan-bogus",
          },
          { auth, client, print: () => {} },
        ),
      ).rejects.toBeInstanceOf(CliUsageError);
    });
  });

  it("realTeams --teams-unsubscribe removes a previously subscribed channel", async () => {
    await withTmpDb(async (cfg) => {
      const db = new Database(cfg.dbPath);
      try {
        db.pragma("journal_mode = WAL");
        const { SqliteTeamsChannelSubscriptionStore } = await import(
          "./store/teams-channel-subscription-store.js"
        );
        const store = new SqliteTeamsChannelSubscriptionStore(db);
        await store.subscribe({
          account: ACCT_T.username,
          teamId: "team-1",
          channelId: "chan-1",
        });
      } finally {
        db.close();
      }
      const result = await realTeams(
        cfg,
        {
          action: "unsubscribe",
          account: ACCT_T.username,
          teamId: "team-1",
          channelId: "chan-1",
        },
        {},
      );
      expect(
        (result as Extract<TeamsCliResult, { action: "unsubscribe" }>).removed,
      ).toBe(true);
    });
  });

  it("realTeams --teams-discover throws CliUsageError when account is unknown", async () => {
    await withTmpDb(async (cfg) => {
      const auth = new FakeAuthClient({ accounts: [] });
      const { FakeTeamsChannelClient } = await import(
        "./testing/fake-teams-channel-client.js"
      );
      const client = new FakeTeamsChannelClient({ steps: [] });
      await expect(
        realTeams(
          cfg,
          { action: "discover", account: "ghost@example.test" },
          { auth, client, print: () => {} },
        ),
      ).rejects.toBeInstanceOf(CliUsageError);
    });
  });

  it("realTeams --teams-discover fans out across cached tenants and tags channels with tenantId", async () => {
    await withTmpDb(async (cfg) => {
      const ACCT_DYNEX: Account = {
        username: "alice@example.test",
        homeAccountId: "home-dynex",
        tenantId: "tenant-dynex",
      };
      const ACCT_MS: Account = {
        username: "alice@example.test",
        homeAccountId: "home-ms",
        tenantId: "tenant-ms",
      };
      const auth = new FakeAuthClient({
        accounts: [ACCT_DYNEX, ACCT_MS],
        tokens: new Map<string, AccessToken | Error>([
          [
            `${ACCT_DYNEX.homeAccountId}|${teamsAuthorityFor(ACCT_DYNEX.tenantId)}`,
            {
              token: "tok-dynex",
              expiresOn: new Date("2026-04-30"),
              account: ACCT_DYNEX,
            },
          ],
          [
            `${ACCT_MS.homeAccountId}|${teamsAuthorityFor(ACCT_MS.tenantId)}`,
            {
              token: "tok-ms",
              expiresOn: new Date("2026-04-30"),
              account: ACCT_MS,
            },
          ],
        ]),
      });
      const { FakeTeamsChannelClient } = await import(
        "./testing/fake-teams-channel-client.js"
      );
      const client = new FakeTeamsChannelClient({
        steps: [
          {
            kind: "listJoinedTeamsOk",
            response: [{ id: "team-d", displayName: "Dynex Eng" }],
          },
          {
            kind: "listChannelsOk",
            teamId: "team-d",
            response: [{ id: "chan-d", displayName: "General" }],
          },
          {
            kind: "listJoinedTeamsOk",
            response: [{ id: "team-m", displayName: "MS Eng" }],
          },
          {
            kind: "listChannelsOk",
            teamId: "team-m",
            response: [{ id: "chan-m", displayName: "All Hands" }],
          },
        ],
      });
      const result = await realTeams(
        cfg,
        { action: "discover", account: "alice@example.test" },
        { auth, client, print: () => {} },
      );
      const channels = (result as Extract<
        TeamsCliResult,
        { action: "discover" }
      >).channels;
      const byChan = new Map(channels.map((c) => [c.channelId, c] as const));
      expect(byChan.get("chan-d")?.tenantId).toBe("tenant-dynex");
      expect(byChan.get("chan-m")?.tenantId).toBe("tenant-ms");
      const silent = auth.calls.filter((c) => c.method === "getTokenSilent");
      const authorities = silent
        .map(
          (c) =>
            (c as Extract<typeof silent[number], { method: "getTokenSilent" }>)
              .authority,
        )
        .filter((a): a is string => a !== undefined);
      expect(new Set(authorities)).toEqual(
        new Set([
          teamsAuthorityFor("tenant-dynex"),
          teamsAuthorityFor("tenant-ms"),
        ]),
      );
    });
  });
});
