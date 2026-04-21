import { createHash } from "node:crypto";
import type { ParsedWhatsAppMessage } from "../sources/whatsapp.js";
import type { Message } from "../store/types.js";

const COUNTER_SUFFIX_RE = /^(.+?)\s*\(\d+\)$/;
const PLACEHOLDER_UNWRAP_RE = /^General chat\s*\(([^()]+)\)$/;

export function normalizeWhatsAppChatName(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  let match: RegExpExecArray | null;
  while ((match = COUNTER_SUFFIX_RE.exec(s)) !== null) {
    s = match[1].trimEnd();
  }
  const unwrap = PLACEHOLDER_UNWRAP_RE.exec(s);
  if (unwrap !== null) {
    const inner = unwrap[1].trim().replace(/\s+/g, " ");
    if (inner.length > 0 && !/^\d+$/.test(inner)) {
      s = inner;
    }
  }
  return s;
}

export interface HashWhatsAppIdInput {
  readonly chat: string;
  readonly sender?: string;
  readonly sentAtIso: string;
  readonly body: string;
}

export function hashWhatsAppId(input: HashWhatsAppIdInput): string {
  const sender = input.sender ?? "";
  const chat = normalizeWhatsAppChatName(input.chat);
  const payload = `${chat}\n${sender}\n${input.sentAtIso}\n${input.body}`;
  const hex = createHash("sha256").update(payload).digest("hex");
  return `whatsapp:${hex}`;
}

export interface ToWhatsAppMessageOptions {
  readonly account: string;
  readonly importedAt: Date;
}

export function toWhatsAppMessage(
  parsed: ParsedWhatsAppMessage,
  opts: ToWhatsAppMessageOptions,
): Message {
  const id = hashWhatsAppId({
    chat: parsed.chat,
    sender: parsed.sender,
    sentAtIso: parsed.sentAtIso,
    body: parsed.body,
  });
  return {
    id,
    source: "whatsapp",
    account: opts.account,
    nativeId: id,
    threadId: normalizeWhatsAppChatName(parsed.chat),
    threadName: parsed.chat,
    senderName: parsed.sender,
    sentAt: new Date(parsed.sentAtIso),
    importedAt: opts.importedAt,
    body: parsed.body,
    rawJson: parsed.rawLine,
  };
}
