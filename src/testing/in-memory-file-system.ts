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

export type InMemoryFsOp =
  | { kind: "readFile"; path: string }
  | { kind: "writeFile"; path: string; mode?: number }
  | { kind: "rename"; from: string; to: string };

export class InMemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, Buffer>();
  private readonly modes = new Map<string, number>();
  private readonly readErrors = new Map<string, Error>();
  private readonly watchers = new Set<Watcher>();
  readonly ops: InMemoryFsOp[] = [];

  async readFile(path: string): Promise<Buffer> {
    this.ops.push({ kind: "readFile", path });
    const injected = this.readErrors.get(path);
    if (injected) throw injected;
    const buf = this.files.get(path);
    if (!buf) throw new ENOENTError(path);
    return buf;
  }

  async writeFile(
    path: string,
    data: Buffer | string,
    mode?: number,
  ): Promise<void> {
    this.ops.push(
      mode === undefined
        ? { kind: "writeFile", path }
        : { kind: "writeFile", path, mode },
    );
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.files.set(path, Buffer.from(buf));
    if (mode !== undefined) this.modes.set(path, mode);
  }

  async mkdir(_path: string): Promise<void> {
    // flat namespace — nothing to create
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async rename(from: string, to: string): Promise<void> {
    this.ops.push({ kind: "rename", from, to });
    const buf = this.files.get(from);
    if (!buf) throw new ENOENTError(from);
    this.files.set(to, buf);
    this.files.delete(from);
    const mode = this.modes.get(from);
    if (mode !== undefined) {
      this.modes.set(to, mode);
      this.modes.delete(from);
    }
  }

  /** Test-only: read back the mode last written for a path. */
  modeOf(path: string): number | undefined {
    return this.modes.get(path);
  }

  /** Test-only: make readFile at `path` throw the given error. */
  injectReadError(path: string, error: Error): void {
    this.readErrors.set(path, error);
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
