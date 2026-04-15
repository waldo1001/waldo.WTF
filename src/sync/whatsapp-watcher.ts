import type { FileSystem } from "../fs.js";
import type { Logger } from "../logger.js";

export interface WhatsAppWatcherOptions {
  readonly fs: FileSystem;
  readonly logger: Logger;
  readonly downloadsPath: string;
  readonly importer: (path: string) => Promise<unknown>;
}

export interface WhatsAppWatcherHandle {
  stop(): void;
}

export const WHATSAPP_EXPORT_GLOB = "WhatsApp Chat*";

export function startWhatsAppWatcher(
  opts: WhatsAppWatcherOptions,
): WhatsAppWatcherHandle {
  const { fs, logger, downloadsPath, importer } = opts;
  logger.info(
    `whatsapp-watcher: watching ${downloadsPath} for ${WHATSAPP_EXPORT_GLOB}`,
  );
  const unsubscribe = fs.watch(downloadsPath, WHATSAPP_EXPORT_GLOB, (path) => {
    void (async () => {
      try {
        await importer(path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`whatsapp-watcher: import failed for ${path}: ${msg}`);
      }
    })();
  });
  return { stop: unsubscribe };
}
