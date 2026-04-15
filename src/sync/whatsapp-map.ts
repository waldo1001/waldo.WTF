import { createHash } from "node:crypto";
import type { ParsedWhatsAppMessage } from "../sources/whatsapp.js";
import type { Message } from "../store/types.js";

export interface HashWhatsAppIdInput {
  readonly chat: string;
  readonly sender?: string;
  readonly sentAtIso: string;
  readonly body: string;
}

export function hashWhatsAppId(input: HashWhatsAppIdInput): string {
  const sender = input.sender ?? "";
  const payload = `${input.chat}\n${sender}\n${input.sentAtIso}\n${input.body}`;
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
    threadId: parsed.chat,
    threadName: parsed.chat,
    senderName: parsed.sender,
    sentAt: new Date(parsed.sentAtIso),
    importedAt: opts.importedAt,
    body: parsed.body,
    rawJson: parsed.rawLine,
  };
}
