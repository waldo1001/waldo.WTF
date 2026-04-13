import type { FileSystem } from "../fs.js";

class ENOENTError extends Error {
  code = "ENOENT";
  constructor(path: string) {
    super(`ENOENT: no such file or directory, '${path}'`);
  }
}

type Watcher = {
  dir: string;
  matches: (name: string) => boolean;
  onEvent: (path: string) => void;
};

export class InMemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, Buffer>();
  private readonly watchers = new Set<Watcher>();

  async readFile(path: string): Promise<Buffer> {
    const buf = this.files.get(path);
    if (!buf) throw new ENOENTError(path);
    return buf;
  }

  async writeFile(
    path: string,
    data: Buffer | string,
    _mode?: number,
  ): Promise<void> {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.files.set(path, Buffer.from(buf));
  }

  async rename(from: string, to: string): Promise<void> {
    const buf = this.files.get(from);
    if (!buf) throw new ENOENTError(from);
    this.files.set(to, buf);
    this.files.delete(from);
  }

  watch(
    dir: string,
    glob: string,
    onEvent: (path: string) => void,
  ): () => void {
    const matches = compileGlob(glob);
    const watcher: Watcher = { dir, matches, onEvent };
    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  async listDir(path: string): Promise<string[]> {
    const prefix = path.endsWith("/") ? path : path + "/";
    const children: string[] = [];
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.length === 0 || rest.includes("/")) continue;
      children.push(rest);
    }
    return children.sort();
  }

  /** Test-only: drive watch() deterministically. */
  trigger(path: string): void {
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash) : "";
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    for (const w of this.watchers) {
      if (w.dir === dir && w.matches(name)) w.onEvent(path);
    }
  }
}

function compileGlob(glob: string): (name: string) => boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");
  return (name) => regex.test(name);
}
