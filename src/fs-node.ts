import * as fs from "node:fs/promises";
import * as path from "node:path";
import chokidar from "chokidar";
import type { FileSystem } from "./fs.js";

function compileGlob(glob: string): (name: string) => boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");
  return (name) => regex.test(name);
}

export const nodeFileSystem: FileSystem = {
  async readFile(p) {
    return fs.readFile(p);
  },
  async writeFile(p, data, mode) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data, { mode });
  },
  async rename(from, to) {
    await fs.rename(from, to);
  },
  async mkdir(p) {
    await fs.mkdir(p, { recursive: true });
  },
  async exists(p) {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  },
  watch(dir, glob, onEvent) {
    const matches = compileGlob(glob);
    const watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });
    const handle = (fullPath: string): void => {
      const name = path.basename(fullPath);
      if (matches(name)) onEvent(fullPath);
    };
    watcher.on("add", handle);
    return () => {
      void watcher.close();
    };
  },
  async listDir(p) {
    return fs.readdir(p);
  },
};
