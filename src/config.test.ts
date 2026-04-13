import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError, DEFAULT_DB_PATH, DEFAULT_AUTH_DIR } from "./config.js";

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
    });
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

  it("does not mutate the input env object", () => {
    const env = { ...validEnv() };
    const snapshot = JSON.stringify(env);
    loadConfig(env);
    expect(JSON.stringify(env)).toBe(snapshot);
  });
});
