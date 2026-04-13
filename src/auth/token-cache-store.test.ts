import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryFileSystem } from "../testing/in-memory-file-system.js";
import { AuthError } from "./types.js";
import { TokenCacheStore } from "./token-cache-store.js";

const CACHE_PATH = "/data/auth/token-cache.json";

describe("TokenCacheStore", () => {
  let fs: InMemoryFileSystem;
  let store: TokenCacheStore;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    store = new TokenCacheStore({ fs, path: CACHE_PATH });
  });

  it("load returns null when the cache file does not exist", async () => {
    expect(await store.load()).toBeNull();
  });

  it("load returns the serialized string when the file exists", async () => {
    await fs.writeFile(CACHE_PATH, '{"Account":{}}');
    expect(await store.load()).toBe('{"Account":{}}');
  });

  it("load throws AuthError(cache-corrupt) on non-ENOENT read errors", async () => {
    const boom = new Error("EIO: hardware on fire");
    fs.injectReadError(CACHE_PATH, boom);
    await expect(store.load()).rejects.toBeInstanceOf(AuthError);
    await expect(store.load()).rejects.toMatchObject({ kind: "cache-corrupt" });
  });

  it("save writes the serialized string to the configured path with mode 0o600", async () => {
    await store.save('{"cache":"v1"}');
    expect((await fs.readFile(CACHE_PATH)).toString("utf8")).toBe(
      '{"cache":"v1"}',
    );
    expect(fs.modeOf(CACHE_PATH)).toBe(0o600);
  });

  it("save writes atomically: temp path first, then rename", async () => {
    await store.save("payload");
    const writes = fs.ops.filter((op) => op.kind === "writeFile");
    const renames = fs.ops.filter((op) => op.kind === "rename");
    expect(writes).toHaveLength(1);
    expect(renames).toHaveLength(1);
    expect(writes[0]!.path).not.toBe(CACHE_PATH);
    expect(writes[0]!.path.startsWith(CACHE_PATH)).toBe(true);
    expect(renames[0]).toMatchObject({ from: writes[0]!.path, to: CACHE_PATH });
    const writeIdx = fs.ops.indexOf(writes[0]!);
    const renameIdx = fs.ops.indexOf(renames[0]!);
    expect(writeIdx).toBeLessThan(renameIdx);
  });

  it("save then load round-trips the exact string", async () => {
    const serialized = '{"Account":{"abc":{"username":"a@b.c"}}}';
    await store.save(serialized);
    expect(await store.load()).toBe(serialized);
  });

  it("two sequential saves leave only the final content and no temp lingering", async () => {
    await store.save("first");
    await store.save("second");
    expect((await fs.readFile(CACHE_PATH)).toString("utf8")).toBe("second");
    const children = await fs.listDir("/data/auth");
    expect(children).toEqual(["token-cache.json"]);
  });
});
