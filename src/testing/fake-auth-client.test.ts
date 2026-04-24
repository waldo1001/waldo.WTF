import { describe, expect, it } from "vitest";
import { AuthError, type AccessToken, type Account } from "../auth/types.js";
import { FakeAuthClient } from "./fake-auth-client.js";

const alice: Account = {
  username: "alice@example.invalid",
  homeAccountId: "alice-home-id",
  tenantId: "tenant-one",
};
const bob: Account = {
  username: "bob@example.invalid",
  homeAccountId: "bob-home-id",
  tenantId: "tenant-two",
};

function tokenFor(account: Account): AccessToken {
  return {
    token: `tok-${account.username}`,
    expiresOn: new Date("2026-04-13T12:00:00.000Z"),
    account,
  };
}

describe("FakeAuthClient", () => {
  it("listAccounts returns the configured accounts in order", async () => {
    const client = new FakeAuthClient({ accounts: [alice, bob] });
    expect(await client.listAccounts()).toEqual([alice, bob]);
  });

  it("getTokenSilent returns the scripted AccessToken for a known account", async () => {
    const client = new FakeAuthClient({
      accounts: [alice],
      tokens: new Map([[alice.homeAccountId, tokenFor(alice)]]),
    });
    const result = await client.getTokenSilent(alice);
    expect(result.token).toBe("tok-alice@example.invalid");
    expect(result.account).toEqual(alice);
  });

  it("getTokenSilent throws the scripted Error when mapped to an error", async () => {
    const boom = new Error("network down");
    const client = new FakeAuthClient({
      accounts: [alice],
      tokens: new Map<string, AccessToken | Error>([
        [alice.homeAccountId, boom],
      ]),
    });
    await expect(client.getTokenSilent(alice)).rejects.toBe(boom);
  });

  it("getTokenSilent records the scopes override when supplied", async () => {
    const client = new FakeAuthClient({
      accounts: [alice],
      tokens: new Map([[alice.homeAccountId, tokenFor(alice)]]),
    });
    await client.getTokenSilent(alice, {
      scopes: ["https://api.yammer.com/user_impersonation"],
    });
    await client.getTokenSilent(alice);
    expect(client.calls).toEqual([
      {
        method: "getTokenSilent",
        account: alice,
        scopes: ["https://api.yammer.com/user_impersonation"],
      },
      { method: "getTokenSilent", account: alice },
    ]);
  });

  it("records authority on the call log when provided", async () => {
    const client = new FakeAuthClient({
      accounts: [alice],
      tokens: new Map([[alice.homeAccountId, tokenFor(alice)]]),
    });
    await client.getTokenSilent(alice, {
      scopes: ["https://api.yammer.com/user_impersonation"],
      authority: "https://login.microsoftonline.com/tenant-x/",
    });
    expect(client.calls).toEqual([
      {
        method: "getTokenSilent",
        account: alice,
        scopes: ["https://api.yammer.com/user_impersonation"],
        authority: "https://login.microsoftonline.com/tenant-x/",
      },
    ]);
  });

  it("returns a different scripted token per authority", async () => {
    const defaultTok: AccessToken = {
      token: "home-tok",
      expiresOn: new Date("2099-01-01T00:00:00Z"),
      account: alice,
    };
    const msTok: AccessToken = {
      token: "ms-tok",
      expiresOn: new Date("2099-01-01T00:00:00Z"),
      account: alice,
    };
    const client = new FakeAuthClient({
      accounts: [alice],
      tokens: new Map<string, AccessToken>([
        [alice.homeAccountId, defaultTok],
        [
          `${alice.homeAccountId}|https://login.microsoftonline.com/tenant-x/`,
          msTok,
        ],
      ]),
    });
    const home = await client.getTokenSilent(alice, {
      scopes: ["https://api.yammer.com/user_impersonation"],
    });
    const external = await client.getTokenSilent(alice, {
      scopes: ["https://api.yammer.com/user_impersonation"],
      authority: "https://login.microsoftonline.com/tenant-x/",
    });
    expect(home.token).toBe("home-tok");
    expect(external.token).toBe("ms-tok");
  });

  it("getTokenSilent throws AuthError(silent-failed) for an unscripted account", async () => {
    const client = new FakeAuthClient({ accounts: [] });
    await expect(client.getTokenSilent(alice)).rejects.toBeInstanceOf(
      AuthError,
    );
    await expect(client.getTokenSilent(alice)).rejects.toMatchObject({
      kind: "silent-failed",
    });
  });

  it("loginWithDeviceCode invokes onPrompt with the canned message before resolving", async () => {
    const prompts: string[] = [];
    const client = new FakeAuthClient({
      accounts: [],
      deviceCodeResult: bob,
      deviceCodeMessage: "go to https://microsoft.com/devicelogin code=ABC123",
    });
    const account = await client.loginWithDeviceCode((msg) => prompts.push(msg));
    expect(prompts).toEqual([
      "go to https://microsoft.com/devicelogin code=ABC123",
    ]);
    expect(account).toEqual(bob);
  });

  it("loginWithDeviceCode throws AuthError(device-code-failed) when scripted with an error", async () => {
    const client = new FakeAuthClient({
      accounts: [],
      deviceCodeResult: new AuthError("device-code-failed", "user cancelled"),
    });
    await expect(client.loginWithDeviceCode(() => {})).rejects.toMatchObject({
      kind: "device-code-failed",
    });
  });

  it("loginWithDeviceCode call records scopes when provided", async () => {
    const client = new FakeAuthClient({
      accounts: [],
      deviceCodeResult: bob,
    });
    await client.loginWithDeviceCode(() => {}, {
      scopes: ["https://api.yammer.com/user_impersonation"],
    });
    expect(client.calls).toEqual([
      {
        method: "loginWithDeviceCode",
        scopes: ["https://api.yammer.com/user_impersonation"],
      },
    ]);
  });

  it("loginWithDeviceCode call omits scopes field when no options provided", async () => {
    const client = new FakeAuthClient({ accounts: [], deviceCodeResult: bob });
    await client.loginWithDeviceCode(() => {});
    expect(client.calls).toEqual([{ method: "loginWithDeviceCode" }]);
  });

  it("loginWithDeviceCode throws AuthError(device-code-failed) when not scripted at all", async () => {
    const client = new FakeAuthClient({ accounts: [] });
    await expect(client.loginWithDeviceCode(() => {})).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("calls records every invocation with method and args in order", async () => {
    const client = new FakeAuthClient({
      accounts: [alice],
      tokens: new Map([[alice.homeAccountId, tokenFor(alice)]]),
      deviceCodeResult: bob,
    });
    await client.listAccounts();
    await client.getTokenSilent(alice);
    await client.loginWithDeviceCode(() => {});
    expect(client.calls).toEqual([
      { method: "listAccounts" },
      { method: "getTokenSilent", account: alice },
      { method: "loginWithDeviceCode" },
    ]);
  });
});
