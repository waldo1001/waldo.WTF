import { describe, it, expect } from "vitest";
import { InMemoryFileSystem } from "../testing/in-memory-file-system.js";
import { VivaExternalTenantsStore } from "./viva-external-tenants-store.js";

const PATH = "/auth/viva-external-tenants.json";

const REG_A = {
  username: "a@example.invalid",
  homeAccountId: "oid-a.tenant-home",
  externalTenantId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
} as const;

const REG_B = {
  username: "a@example.invalid",
  homeAccountId: "oid-a.tenant-home",
  externalTenantId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
} as const;

const REG_OTHER_USER = {
  username: "b@example.invalid",
  homeAccountId: "oid-b.tenant-home",
  externalTenantId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
} as const;

describe("VivaExternalTenantsStore", () => {
  it("list() on an uninitialized path returns empty", async () => {
    const fs = new InMemoryFileSystem();
    const store = new VivaExternalTenantsStore({ fs, path: PATH });
    expect(await store.list()).toEqual([]);
  });

  it("add() writes the registration; a fresh instance reads it back", async () => {
    const fs = new InMemoryFileSystem();
    const first = new VivaExternalTenantsStore({ fs, path: PATH });
    await first.add(REG_A);
    const second = new VivaExternalTenantsStore({ fs, path: PATH });
    expect(await second.list()).toEqual([REG_A]);
  });

  it("adding the same (homeAccountId, tenantId) twice stores one record", async () => {
    const fs = new InMemoryFileSystem();
    const store = new VivaExternalTenantsStore({ fs, path: PATH });
    await store.add(REG_A);
    await store.add(REG_A);
    expect(await store.list()).toEqual([REG_A]);
  });

  it("registrations serialize in a stable order", async () => {
    const fs = new InMemoryFileSystem();
    const store = new VivaExternalTenantsStore({ fs, path: PATH });
    await store.add(REG_B);
    await store.add(REG_OTHER_USER);
    await store.add(REG_A);
    const written = (await fs.readFile(PATH)).toString("utf8");
    // Deterministic sort: (homeAccountId, externalTenantId) ascending.
    expect(JSON.parse(written)).toEqual({
      registrations: [
        REG_A,
        REG_B,
        REG_OTHER_USER,
      ],
    });
  });

  it("malformed JSON yields empty list with a logged warning", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile(PATH, "{");
    const warnings: string[] = [];
    const store = new VivaExternalTenantsStore({
      fs,
      path: PATH,
      warn: (m) => warnings.push(m),
    });
    expect(await store.list()).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(PATH);
  });

  it("writes the file with mode 0600 to keep registrations private", async () => {
    const fs = new InMemoryFileSystem();
    const store = new VivaExternalTenantsStore({ fs, path: PATH });
    await store.add(REG_A);
    expect(fs.modeOf(PATH)).toBe(0o600);
  });

  it("treats parsed JSON without a registrations array as empty", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile(PATH, JSON.stringify({ registrations: "not-an-array" }));
    const store = new VivaExternalTenantsStore({ fs, path: PATH });
    expect(await store.list()).toEqual([]);
  });

  it("stringifies non-Error thrown values in the warning path", async () => {
    const fs = new InMemoryFileSystem();
    fs.injectReadError(PATH, "not-an-error" as unknown as Error);
    const warnings: string[] = [];
    const store = new VivaExternalTenantsStore({
      fs,
      path: PATH,
      warn: (m) => warnings.push(m),
    });
    expect(await store.list()).toEqual([]);
    expect(warnings.some((w) => w.includes("not-an-error"))).toBe(true);
  });

  it("ignores non-ENOENT read errors by surfacing a warning and returning empty", async () => {
    const fs = new InMemoryFileSystem();
    fs.injectReadError(PATH, new Error("disk boom"));
    const warnings: string[] = [];
    const store = new VivaExternalTenantsStore({
      fs,
      path: PATH,
      warn: (m) => warnings.push(m),
    });
    expect(await store.list()).toEqual([]);
    expect(warnings.some((w) => w.includes("disk boom"))).toBe(true);
  });
});
