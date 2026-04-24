import type { FileSystem } from "../fs.js";

export interface VivaExternalTenantRegistration {
  readonly username: string;
  readonly homeAccountId: string;
  readonly externalTenantId: string;
}

export interface VivaExternalTenantsStoreOptions {
  readonly fs: FileSystem;
  readonly path: string;
  readonly warn?: (message: string) => void;
}

interface SerializedShape {
  readonly registrations: readonly VivaExternalTenantRegistration[];
}

export class VivaExternalTenantsStore {
  constructor(private readonly opts: VivaExternalTenantsStoreOptions) {}

  async list(): Promise<readonly VivaExternalTenantRegistration[]> {
    return this.readAll();
  }

  async add(reg: VivaExternalTenantRegistration): Promise<void> {
    const current = await this.readAll();
    const exists = current.some(
      (r) =>
        r.homeAccountId === reg.homeAccountId &&
        r.externalTenantId === reg.externalTenantId,
    );
    const next = exists
      ? current
      : [...current, reg];
    const sorted = sortRegistrations(next);
    const payload: SerializedShape = { registrations: sorted };
    await this.opts.fs.writeFile(
      this.opts.path,
      JSON.stringify(payload, null, 2),
      0o600,
    );
  }

  private async readAll(): Promise<readonly VivaExternalTenantRegistration[]> {
    let raw: string;
    try {
      const buf = await this.opts.fs.readFile(this.opts.path);
      raw = buf.toString("utf8");
    } catch (err) {
      if (isENOENT(err)) return [];
      this.warn(
        `viva-external-tenants: failed to read ${this.opts.path}: ${errMsg(err)} — treating as empty`,
      );
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SerializedShape>;
      const list = Array.isArray(parsed.registrations)
        ? parsed.registrations
        : [];
      return sortRegistrations(list);
    } catch (err) {
      this.warn(
        `viva-external-tenants: malformed JSON at ${this.opts.path} (${errMsg(err)}) — treating as empty`,
      );
      return [];
    }
  }

  private warn(message: string): void {
    /* c8 ignore next -- default warn is console in production */
    const fn = this.opts.warn ?? ((m: string) => console.warn(m));
    fn(message);
  }
}

function sortRegistrations(
  regs: readonly VivaExternalTenantRegistration[],
): readonly VivaExternalTenantRegistration[] {
  return [...regs].sort((a, b) => {
    if (a.homeAccountId !== b.homeAccountId) {
      return a.homeAccountId < b.homeAccountId ? -1 : 1;
    }
    if (a.externalTenantId !== b.externalTenantId) {
      return a.externalTenantId < b.externalTenantId ? -1 : 1;
    }
    return 0;
  });
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
