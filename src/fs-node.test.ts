import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moveAcrossDevices, nodeFileSystem } from "./fs-node.js";

describe("nodeFileSystem passthrough methods", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "waldo-fs-node-io-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writeFile + readFile round-trips bytes, creating parent dirs", async () => {
    const target = path.join(tmpDir, "nested", "deep", "file.txt");
    await nodeFileSystem.writeFile(target, "hello world");
    const buf = await nodeFileSystem.readFile(target);
    expect(buf.toString("utf8")).toBe("hello world");
  });

  it("writeFile honors the mode argument", async () => {
    const target = path.join(tmpDir, "mode.txt");
    await nodeFileSystem.writeFile(target, "x", 0o600);
    const stat = await fs.stat(target);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("exists returns true for a created file and false for missing", async () => {
    const target = path.join(tmpDir, "here.txt");
    await nodeFileSystem.writeFile(target, "x");
    expect(await nodeFileSystem.exists(target)).toBe(true);
    expect(await nodeFileSystem.exists(path.join(tmpDir, "nope.txt"))).toBe(
      false,
    );
  });

  it("mkdir is recursive and idempotent", async () => {
    const target = path.join(tmpDir, "a", "b", "c");
    await nodeFileSystem.mkdir(target);
    await nodeFileSystem.mkdir(target);
    expect(await nodeFileSystem.exists(target)).toBe(true);
  });

  it("rename moves a file", async () => {
    const from = path.join(tmpDir, "old.txt");
    const to = path.join(tmpDir, "new.txt");
    await nodeFileSystem.writeFile(from, "x");
    await nodeFileSystem.rename(from, to);
    expect(await nodeFileSystem.exists(from)).toBe(false);
    expect(await nodeFileSystem.exists(to)).toBe(true);
  });

  it("moveAcrossDevices falls back to copy+unlink on EXDEV", async () => {
    const from = path.join(tmpDir, "payload.bin");
    const to = path.join(tmpDir, "moved.bin");
    await fs.writeFile(from, "cross-device-bytes");

    let calls = 0;
    const fakeRename = async (): Promise<void> => {
      calls++;
      const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    };

    await moveAcrossDevices(from, to, fakeRename);

    expect(calls).toBe(1);
    await expect(fs.stat(from)).rejects.toThrow();
    const buf = await fs.readFile(to);
    expect(buf.toString("utf8")).toBe("cross-device-bytes");
  });

  it("listDir returns filenames in the directory", async () => {
    await nodeFileSystem.writeFile(path.join(tmpDir, "a.txt"), "x");
    await nodeFileSystem.writeFile(path.join(tmpDir, "b.txt"), "x");
    const entries = await nodeFileSystem.listDir(tmpDir);
    expect(entries.sort()).toEqual(["a.txt", "b.txt"]);
  });
});

describe("nodeFileSystem.watch (chokidar integration)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "waldo-fs-node-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("fires the callback when a matching file is created", async () => {
    const seen: string[] = [];
    const stop = nodeFileSystem.watch(tmpDir, "WhatsApp Chat*", (p) => {
      seen.push(p);
    });

    // Give chokidar a moment to become ready.
    await new Promise((r) => setTimeout(r, 200));

    const target = path.join(tmpDir, "WhatsApp Chat - Mom.txt");
    await fs.writeFile(target, "[15/04/2026, 09:03:17] waldo: hi\n");

    // Wait for awaitWriteFinish (500ms stability) + buffer.
    await new Promise((r) => setTimeout(r, 1500));

    stop();
    expect(seen).toContain(target);
  }, 10000);

  it("ignores files that do not match the glob", async () => {
    const seen: string[] = [];
    const stop = nodeFileSystem.watch(tmpDir, "WhatsApp Chat*", (p) => {
      seen.push(p);
    });
    await new Promise((r) => setTimeout(r, 200));

    await fs.writeFile(path.join(tmpDir, "something-else.txt"), "x");
    await new Promise((r) => setTimeout(r, 1500));

    stop();
    expect(seen).toEqual([]);
  }, 10000);

  it("stop() unsubscribes — no more events after close", async () => {
    const seen: string[] = [];
    const stop = nodeFileSystem.watch(tmpDir, "WhatsApp Chat*", (p) => {
      seen.push(p);
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    await new Promise((r) => setTimeout(r, 100));

    await fs.writeFile(path.join(tmpDir, "WhatsApp Chat - Late.txt"), "x");
    await new Promise((r) => setTimeout(r, 1500));

    expect(seen).toEqual([]);
  }, 10000);
});
