import { describe, it, expect } from "vitest";
import { runCli, addAccount, CliUsageError } from "./cli.js";
import { ConfigError } from "./config.js";
import { FakeAuthClient } from "./testing/fake-auth-client.js";
import { AuthError, type Account } from "./auth/types.js";

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
