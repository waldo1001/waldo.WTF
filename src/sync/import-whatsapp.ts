import AdmZip from "adm-zip";
import type { Clock } from "../clock.js";
import type { FileSystem } from "../fs.js";
import { parseWhatsAppExport } from "../sources/whatsapp.js";
import type { MessageStore } from "../store/message-store.js";
import { toWhatsAppMessage } from "./whatsapp-map.js";

export interface ImportWhatsAppFileOptions {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly store: MessageStore;
  readonly filePath: string;
  readonly account: string;
  readonly archiveRoot: string;
}

export interface ImportWhatsAppFileResult {
  readonly chat: string;
  readonly parsed: number;
  readonly imported: number;
  readonly archivedTo: string;
}

export class WhatsAppImportError extends Error {
  constructor(
    message: string,
    readonly filePath: string,
    options?: { cause?: unknown },
  ) {
    super(`${message}: ${filePath}`, options);
    this.name = "WhatsAppImportError";
  }
}

export class WhatsAppParseError extends WhatsAppImportError {
  constructor(
    message: string,
    filePath: string,
    options?: { cause?: unknown },
  ) {
    super(message, filePath, options);
    this.name = "WhatsAppParseError";
  }
}

export class WhatsAppArchiveError extends WhatsAppImportError {
  constructor(
    message: string,
    filePath: string,
    options?: { cause?: unknown },
  ) {
    super(message, filePath, options);
    this.name = "WhatsAppArchiveError";
  }
}

const CHAT_FILENAME_RE = /^WhatsApp Chat - (.+)\.(?:txt|zip)$/;

function extractChatTextFromZip(buffer: Buffer, filePath: string): string {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new WhatsAppParseError(
      `failed to open WhatsApp zip export`,
      filePath,
      { cause: err },
    );
  }
  const entry = zip.getEntry("_chat.txt");
  if (!entry) {
    throw new WhatsAppParseError(
      `WhatsApp zip export is missing _chat.txt`,
      filePath,
    );
  }
  return entry.getData().toString("utf8");
}

function basename(p: string): string {
  /* c8 ignore next */
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function splitExt(filename: string): { stem: string; ext: string } {
  const dot = filename.lastIndexOf(".");
  /* c8 ignore next */
  if (dot <= 0) return { stem: filename, ext: "" };
  return { stem: filename.slice(0, dot), ext: filename.slice(dot) };
}

function deriveChatName(filename: string): string {
  const m = CHAT_FILENAME_RE.exec(filename);
  if (m) return m[1]!;
  return splitExt(filename).stem;
}

function yearMonth(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

async function resolveArchiveTarget(
  fs: FileSystem,
  dir: string,
  filename: string,
): Promise<string> {
  const { stem: base, ext } = splitExt(filename);
  let candidate = `${dir}/${filename}`;
  let n = 0;
  while (await fs.exists(candidate)) {
    n += 1;
    candidate = `${dir}/${base}-${n}${ext}`;
  }
  return candidate;
}

export async function importWhatsAppFile(
  opts: ImportWhatsAppFileOptions,
): Promise<ImportWhatsAppFileResult> {
  const { fs, clock, store, filePath, account, archiveRoot } = opts;
  const filename = basename(filePath);
  const chat = deriveChatName(filename);
  const isZip = filename.toLowerCase().endsWith(".zip");

  const fileBuf = await fs.readFile(filePath);
  const raw = isZip
    ? extractChatTextFromZip(fileBuf, filePath)
    : fileBuf.toString("utf8");

  let parsed;
  try {
    parsed = parseWhatsAppExport(raw, {
      chatName: chat,
      locale: "mac-en-be",
      timezone: "Europe/Brussels",
    });
  } catch (err) {
    throw new WhatsAppParseError(
      `failed to parse WhatsApp export`,
      filePath,
      { cause: err },
    );
  }

  const importedAt = clock.now();
  const messages = parsed.map((p) => toWhatsAppMessage(p, { account, importedAt }));
  const upsert = await store.upsertMessages(messages);

  const archiveDir = `${archiveRoot}/${yearMonth(importedAt)}`;
  let archivedTo: string;
  try {
    await fs.mkdir(archiveDir);
    archivedTo = await resolveArchiveTarget(fs, archiveDir, filename);
    await fs.rename(filePath, archivedTo);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new WhatsAppArchiveError(
      `failed to archive WhatsApp export (${cause})`,
      filePath,
      { cause: err },
    );
  }

  return {
    chat,
    parsed: parsed.length,
    imported: upsert.added,
    archivedTo,
  };
}
