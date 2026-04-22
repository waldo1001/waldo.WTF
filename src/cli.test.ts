import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { runCli, addAccount, CliUsageError, realViva } from "./cli.js";
import type {
  SteerCommand,
  SteerCliResult,
  SteerImpl,
  VivaCommand,
  VivaCliResult,
  VivaImpl,
  VivaDeps,
} from "./cli.js";
import type { VivaSubscription } from "./store/types.js";
import type { Config } from "./config.js";
import { ConfigError } from "./config.js";
import { FakeAuthClient } from "./testing/fake-auth-client.js";
import { FakeVivaClient } from "./testing/fake-viva-client.js";
import { SqliteVivaSubscriptionStore } from "./store/viva-subscription-store.js";
import { applyMigrations } from "./store/schema.js";
import { AuthError, type Account } from "./auth/types.js";
import { SqliteSteeringStore } from "./store/steering-store.js";
import type { AddSteeringRuleInput, SteeringRule } from "./store/types.js";
import { FakeClock } from "./testing/fake-clock.js";
import { YAMMER_SCOPE } from "./auth/msal-auth-client.js";

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

  it("realViva --viva-discover paginates listCommunities across @odata.nextLink pages", async () => {
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
            kind: "listCommunitiesOk",
            response: {
              value: [
                {
                  id: "com-1",
                  displayName: "Alpha",
                  networkId: "net-1",
                  networkName: "Acme",
                },
                {
                  id: "com-2",
                  displayName: "Beta",
                  networkId: "net-1",
                  networkName: "Acme",
                },
              ],
              "@odata.nextLink": "https://graph.example.invalid/next-page-2",
            },
          },
          {
            kind: "listCommunitiesOk",
            response: {
              value: [
                {
                  id: "com-3",
                  displayName: "Gamma",
                  networkId: "net-1",
                  networkName: "Acme",
                },
              ],
            },
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

      const calls = viva.calls.filter((c) => c.method === "listCommunities");
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ token: "tok-123" });
      expect(calls[0]!.nextLink).toBeUndefined();
      expect(calls[1]).toMatchObject({
        token: "tok-123",
        nextLink: "https://graph.example.invalid/next-page-2",
      });
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
        steps: [{ kind: "listCommunitiesOk", response: { value: [] } }],
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
            kind: "listCommunitiesOk",
            response: {
              value: [
                {
                  id: "COM-7",
                  displayName: "Sales",
                  networkId: "net-42",
                  networkName: "Acme Corp",
                },
              ],
            },
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
            kind: "listCommunitiesOk",
            response: {
              value: [
                {
                  id: "com-real",
                  displayName: "Real",
                  networkId: "net-1",
                },
              ],
            },
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
});
