import { describe, it, expect } from "vitest";
import {
  loadConfig,
  ConfigError,
  DEFAULT_DB_PATH,
  DEFAULT_AUTH_DIR,
  DEFAULT_PORT,
  DEFAULT_SYNC_INTERVAL_MS,
  DEFAULT_BIND_HOST,
  DEFAULT_WHATSAPP_ACCOUNT,
  DEFAULT_WHATSAPP_ARCHIVE_PATH,
  DEFAULT_WHATSAPP_DOWNLOADS_PATH,
} from "./config.js";

const validEnv = () => ({
  MS_CLIENT_ID: "client-abc",
  BEARER_TOKEN: "bearer-xyz",
});

describe("loadConfig", () => {
  it("returns populated Config when all required env vars are set", () => {
    const cfg = loadConfig({
      ...validEnv(),
      WALDO_DB_PATH: "/tmp/lake.db",
      WALDO_AUTH_DIR: "/tmp/auth",
    });
    expect(cfg).toEqual({
      msClientId: "client-abc",
      bearerToken: "bearer-xyz",
      dbPath: "/tmp/lake.db",
      authDir: "/tmp/auth",
      port: DEFAULT_PORT,
      syncIntervalMs: DEFAULT_SYNC_INTERVAL_MS,
      bindHost: DEFAULT_BIND_HOST,
      whatsappDownloadsPath: DEFAULT_WHATSAPP_DOWNLOADS_PATH,
      whatsappArchivePath: DEFAULT_WHATSAPP_ARCHIVE_PATH,
      whatsappAccount: DEFAULT_WHATSAPP_ACCOUNT,
      whatsappWatch: false,
    });
  });

  it("honors WALDO_WHATSAPP_* env vars", () => {
    const cfg = loadConfig({
      ...validEnv(),
      WALDO_WHATSAPP_DOWNLOADS_PATH: "/tmp/dl",
      WALDO_WHATSAPP_ARCHIVE_PATH: "/tmp/archive",
      WALDO_WHATSAPP_ACCOUNT: "whatsapp-eric",
      WALDO_WHATSAPP_WATCH: "true",
    });
    expect(cfg.whatsappDownloadsPath).toBe("/tmp/dl");
    expect(cfg.whatsappArchivePath).toBe("/tmp/archive");
    expect(cfg.whatsappAccount).toBe("whatsapp-eric");
    expect(cfg.whatsappWatch).toBe(true);
  });

  it("treats any WALDO_WHATSAPP_WATCH value other than 'true' as false", () => {
    expect(loadConfig({ ...validEnv(), WALDO_WHATSAPP_WATCH: "false" }).whatsappWatch).toBe(false);
    expect(loadConfig({ ...validEnv(), WALDO_WHATSAPP_WATCH: "1" }).whatsappWatch).toBe(false);
    expect(loadConfig(validEnv()).whatsappWatch).toBe(false);
  });

  it("defaults bindHost to 127.0.0.1", () => {
    expect(DEFAULT_BIND_HOST).toBe("127.0.0.1");
    expect(loadConfig(validEnv()).bindHost).toBe("127.0.0.1");
  });

  it("uses WALDO_BIND_HOST when provided", () => {
    expect(
      loadConfig({ ...validEnv(), WALDO_BIND_HOST: "0.0.0.0" }).bindHost,
    ).toBe("0.0.0.0");
  });

  it("treats empty WALDO_BIND_HOST as unset", () => {
    expect(
      loadConfig({ ...validEnv(), WALDO_BIND_HOST: "" }).bindHost,
    ).toBe(DEFAULT_BIND_HOST);
  });

  it("port defaults to 8765 when WALDO_PORT is unset", () => {
    expect(loadConfig(validEnv()).port).toBe(8765);
  });

  it("port reads WALDO_PORT as an integer when set", () => {
    expect(loadConfig({ ...validEnv(), WALDO_PORT: "9090" }).port).toBe(9090);
  });

  it("throws ConfigError when WALDO_PORT is not a positive integer", () => {
    expect(() =>
      loadConfig({ ...validEnv(), WALDO_PORT: "not-a-number" }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv(), WALDO_PORT: "0" })).toThrow(
      ConfigError,
    );
  });

  it("syncIntervalMs defaults to DEFAULT_SYNC_INTERVAL_MS", () => {
    expect(loadConfig(validEnv()).syncIntervalMs).toBe(DEFAULT_SYNC_INTERVAL_MS);
  });

  it("syncIntervalMs reads WALDO_SYNC_INTERVAL_MS when set", () => {
    expect(
      loadConfig({ ...validEnv(), WALDO_SYNC_INTERVAL_MS: "60000" }).syncIntervalMs,
    ).toBe(60_000);
  });

  it("applies default dbPath when WALDO_DB_PATH is unset", () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.dbPath).toBe(DEFAULT_DB_PATH);
  });

  it("applies default authDir when WALDO_AUTH_DIR is unset", () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.authDir).toBe(DEFAULT_AUTH_DIR);
  });

  it("honors WALDO_DB_PATH override when set", () => {
    const cfg = loadConfig({ ...validEnv(), WALDO_DB_PATH: "/custom/lake.db" });
    expect(cfg.dbPath).toBe("/custom/lake.db");
  });

  it("honors WALDO_AUTH_DIR override when set", () => {
    const cfg = loadConfig({ ...validEnv(), WALDO_AUTH_DIR: "/custom/auth" });
    expect(cfg.authDir).toBe("/custom/auth");
  });

  it("throws ConfigError listing MS_CLIENT_ID when missing", () => {
    try {
      loadConfig({ BEARER_TOKEN: "bearer-xyz" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).missing).toContain("MS_CLIENT_ID");
      expect((err as ConfigError).missing).not.toContain("BEARER_TOKEN");
    }
  });

  it("throws ConfigError listing BEARER_TOKEN when missing", () => {
    try {
      loadConfig({ MS_CLIENT_ID: "client-abc" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).missing).toContain("BEARER_TOKEN");
      expect((err as ConfigError).missing).not.toContain("MS_CLIENT_ID");
    }
  });

  it("ConfigError.missing lists both keys when both absent", () => {
    try {
      loadConfig({});
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).missing).toEqual(
        expect.arrayContaining(["MS_CLIENT_ID", "BEARER_TOKEN"]),
      );
      expect((err as ConfigError).missing).toHaveLength(2);
    }
  });

  it("treats empty-string values as missing", () => {
    try {
      loadConfig({ MS_CLIENT_ID: "", BEARER_TOKEN: "" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).missing).toEqual(
        expect.arrayContaining(["MS_CLIENT_ID", "BEARER_TOKEN"]),
      );
    }
  });

  it("backfillDays is undefined when WALDO_BACKFILL_DAYS is unset", () => {
    expect(loadConfig(validEnv()).backfillDays).toBeUndefined();
  });

  it("backfillDays parses WALDO_BACKFILL_DAYS as a positive integer", () => {
    expect(
      loadConfig({ ...validEnv(), WALDO_BACKFILL_DAYS: "30" }).backfillDays,
    ).toBe(30);
  });

  it("throws ConfigError when WALDO_BACKFILL_DAYS is zero", () => {
    expect(() =>
      loadConfig({ ...validEnv(), WALDO_BACKFILL_DAYS: "0" }),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError when WALDO_BACKFILL_DAYS is negative", () => {
    expect(() =>
      loadConfig({ ...validEnv(), WALDO_BACKFILL_DAYS: "-5" }),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError when WALDO_BACKFILL_DAYS is non-numeric", () => {
    expect(() =>
      loadConfig({ ...validEnv(), WALDO_BACKFILL_DAYS: "abc" }),
    ).toThrow(ConfigError);
  });

  it("does not mutate the input env object", () => {
    const env = { ...validEnv() };
    const snapshot = JSON.stringify(env);
    loadConfig(env);
    expect(JSON.stringify(env)).toBe(snapshot);
  });
});
