import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ParsedWhatsAppMessage } from "../sources/whatsapp.js";
import { hashWhatsAppId, toWhatsAppMessage } from "./whatsapp-map.js";

const PARSED: ParsedWhatsAppMessage = {
  type: "chat",
  chat: "Mom",
  sender: "waldo",
  sentAtIso: "2026-04-15T07:03:17.000Z",
  body: "hello world",
  rawLine: "[15/04/2026, 09:03:17] waldo: hello world",
};

describe("hashWhatsAppId", () => {
  it("produces whatsapp:<64-hex-chars>", () => {
    const id = hashWhatsAppId({
      chat: PARSED.chat,
      sender: PARSED.sender!,
      sentAtIso: PARSED.sentAtIso,
      body: PARSED.body,
    });
    expect(id.startsWith("whatsapp:")).toBe(true);
    expect(id.slice("whatsapp:".length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches sha256(chat\\nsender\\nsentAtIso\\nbody)", () => {
    const expected =
      "whatsapp:" +
      createHash("sha256")
        .update("Mom\nwaldo\n2026-04-15T07:03:17.000Z\nhello world")
        .digest("hex");
    expect(
      hashWhatsAppId({
        chat: "Mom",
        sender: "waldo",
        sentAtIso: "2026-04-15T07:03:17.000Z",
        body: "hello world",
      }),
    ).toBe(expected);
  });

  it("is stable across calls", () => {
    const a = hashWhatsAppId({
      chat: "Mom",
      sender: "waldo",
      sentAtIso: "2026-04-15T07:03:17.000Z",
      body: "hello",
    });
    const b = hashWhatsAppId({
      chat: "Mom",
      sender: "waldo",
      sentAtIso: "2026-04-15T07:03:17.000Z",
      body: "hello",
    });
    expect(a).toBe(b);
  });

  it("changes when any component changes", () => {
    const base = { chat: "Mom", sender: "waldo", sentAtIso: "2026-04-15T07:03:17.000Z", body: "x" };
    const baseId = hashWhatsAppId(base);
    expect(hashWhatsAppId({ ...base, chat: "Mom2" })).not.toBe(baseId);
    expect(hashWhatsAppId({ ...base, sender: "eric" })).not.toBe(baseId);
    expect(hashWhatsAppId({ ...base, sentAtIso: "2026-04-15T07:03:18.000Z" })).not.toBe(baseId);
    expect(hashWhatsAppId({ ...base, body: "y" })).not.toBe(baseId);
  });

  it("treats missing sender as empty string", () => {
    const a = hashWhatsAppId({
      chat: "Mom",
      sender: undefined,
      sentAtIso: "2026-04-15T07:03:17.000Z",
      body: "x",
    });
    const b = hashWhatsAppId({
      chat: "Mom",
      sender: "",
      sentAtIso: "2026-04-15T07:03:17.000Z",
      body: "x",
    });
    expect(a).toBe(b);
  });
});

describe("toWhatsAppMessage", () => {
  const importedAt = new Date("2026-04-15T10:00:00.000Z");

  it("maps a parsed chat message to a Message", () => {
    const msg = toWhatsAppMessage(PARSED, {
      account: "waldo-phone",
      importedAt,
    });
    expect(msg.source).toBe("whatsapp");
    expect(msg.account).toBe("waldo-phone");
    expect(msg.threadId).toBe("Mom");
    expect(msg.threadName).toBe("Mom");
    expect(msg.senderName).toBe("waldo");
    expect(msg.senderEmail).toBeUndefined();
    expect(msg.body).toBe("hello world");
    expect(msg.sentAt.toISOString()).toBe(PARSED.sentAtIso);
    expect(msg.importedAt).toBe(importedAt);
    expect(msg.nativeId).toBe(msg.id);
    expect(msg.id.startsWith("whatsapp:")).toBe(true);
    expect(msg.rawJson).toBe(PARSED.rawLine);
  });

  it("assigns the hashWhatsAppId to Message.id", () => {
    const msg = toWhatsAppMessage(PARSED, {
      account: "waldo-phone",
      importedAt,
    });
    expect(msg.id).toBe(
      hashWhatsAppId({
        chat: PARSED.chat,
        sender: PARSED.sender,
        sentAtIso: PARSED.sentAtIso,
        body: PARSED.body,
      }),
    );
  });

  it("same parsed message + same account yields same id (dedup invariant)", () => {
    const a = toWhatsAppMessage(PARSED, { account: "waldo-phone", importedAt });
    const b = toWhatsAppMessage(PARSED, {
      account: "waldo-phone",
      importedAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(a.id).toBe(b.id);
  });
});
