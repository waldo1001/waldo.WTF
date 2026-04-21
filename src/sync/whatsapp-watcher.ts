import type { FileSystem } from "../fs.js";
import type { Logger } from "../logger.js";
import {
  WhatsAppArchiveError,
  WhatsAppParseError,
} from "./import-whatsapp.js";

export interface WhatsAppWatcherOptions {
  readonly fs: FileSystem;
  readonly logger: Logger;
  readonly downloadsPath: string;
  readonly importer: (path: string) => Promise<unknown>;
}

export interface WhatsAppWatcherHandle {
  stop(): void;
  readonly sweepComplete: Promise<void>;
}

const WHATSAPP_EXPORT_PREFIX = "WhatsApp Chat";
export const WHATSAPP_EXPORT_GLOB = `${WHATSAPP_EXPORT_PREFIX}*`;

function matchesExportGlob(name: string): boolean {
  return name.startsWith(WHATSAPP_EXPORT_PREFIX);
}

async function runImporter(
  importer: (path: string) => Promise<unknown>,
  logger: Logger,
  path: string,
): Promise<boolean> {
  try {
    await importer(path);
    return true;
  } catch (err) {
    logger.error(describeImportError(err, path));
    return false;
  }
}

function describeImportError(err: unknown, path: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof WhatsAppParseError) {
    return `whatsapp_parse_failed: ${path}: ${msg}`;
  }
  if (err instanceof WhatsAppArchiveError) {
    return `whatsapp_archive_failed: ${path}: ${msg}`;
  }
  return `whatsapp_import_failed: ${path}: ${msg}`;
}

export function startWhatsAppWatcher(
  opts: WhatsAppWatcherOptions,
): WhatsAppWatcherHandle {
  const { fs, logger, downloadsPath, importer } = opts;
  logger.info(
    `whatsapp-watcher: watching ${downloadsPath} for ${WHATSAPP_EXPORT_GLOB}`,
  );
  const unsubscribe = fs.watch(downloadsPath, WHATSAPP_EXPORT_GLOB, (path) => {
    void runImporter(importer, logger, path);
  });
  const sweepComplete = sweepInbox({ fs, logger, downloadsPath, importer });
  return { stop: unsubscribe, sweepComplete };
}

async function sweepInbox(opts: WhatsAppWatcherOptions): Promise<void> {
  const { fs, logger, downloadsPath, importer } = opts;
  const entries = await fs.listDir(downloadsPath);
  const matches = entries.filter(matchesExportGlob);
  let imported = 0;
  for (const name of matches) {
    const filePath = `${downloadsPath}/${name}`;
    if (!(await fs.exists(filePath))) continue;
    const ok = await runImporter(importer, logger, filePath);
    if (ok) imported += 1;
  }
  logger.info(
    `whatsapp_sweep_complete: files=${matches.length} imported=${imported}`,
  );
}
