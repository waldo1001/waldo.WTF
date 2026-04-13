import type { FileSystem } from "../fs.js";
import { AuthError } from "./types.js";

export interface TokenCacheStoreOptions {
  fs: FileSystem;
  path: string;
}

export class TokenCacheStore {
  constructor(private readonly opts: TokenCacheStoreOptions) {}

  async load(): Promise<string | null> {
    try {
      const buf = await this.opts.fs.readFile(this.opts.path);
      return buf.toString("utf8");
    } catch (err) {
      if (isENOENT(err)) return null;
      throw new AuthError(
        "cache-corrupt",
        `failed to read token cache at ${this.opts.path}`,
        { cause: err },
      );
    }
  }

  async save(serialized: string): Promise<void> {
    const tmp = `${this.opts.path}.tmp`;
    await this.opts.fs.writeFile(tmp, serialized, 0o600);
    await this.opts.fs.rename(tmp, this.opts.path);
  }
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
