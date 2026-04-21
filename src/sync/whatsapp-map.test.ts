import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ParsedWhatsAppMessage } from "../sources/whatsapp.js";
import {
  hashWhatsAppId,
  normalizeWhatsAppChatName,
  toWhatsAppMessage,
} from "./whatsapp-map.js";

const PARSED: ParsedWhatsAppMessage = {
  type: "chat",
  chat: "Mom",
  sender: "waldo",
  sentAtIso: "2026-04-15T07:03:17.000Z",
  body: "hello world",
  rawLine: "[15/04/2026, 09:03:17] waldo: hello world",
};

describe("normalizeWhatsAppChatName", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeWhatsAppChatName("  General chat  ")).toBe("General chat");
  });

  it("collapses internal whitespace runs to a single space", () => {
    expect(normalizeWhatsAppChatName("General    chat\t\tclub")).toBe(
      "General chat club",
    );
  });

  it("strips a trailing numeric counter suffix", () => {
    expect(normalizeWhatsAppChatName("BC Dev Talk (2)")).toBe("BC Dev Talk");
  });

  it("strips multiple chained numeric counters", () => {
    expect(normalizeWhatsAppChatName("BC Dev Talk (2) (3)")).toBe("BC Dev Talk");
  });

  it("preserves a non-numeric parenthetical suffix on a normal name", () => {
    expect(normalizeWhatsAppChatName("BC Dev Talk (Belgium)")).toBe(
      "BC Dev Talk (Belgium)",
    );
  });

  it("unwraps 'General chat (<name>)' to the inner group name", () => {
    expect(normalizeWhatsAppChatName("General chat (BC Dev Talk)")).toBe(
      "BC Dev Talk",
    );
  });

  it("unwraps placeholder and strips trailing counter", () => {
    expect(
      normalizeWhatsAppChatName("General chat (BC Dev Talk) (2)"),
    ).toBe("BC Dev Talk");
  });

  it("collapses whitespace inside the unwrapped placeholder content", () => {
    expect(
      normalizeWhatsAppChatName("General chat (  BC  Dev  Talk  )"),
    ).toBe("BC Dev Talk");
  });

  it("leaves bare 'General chat' (unnamed group) unchanged", () => {
    expect(normalizeWhatsAppChatName("General chat")).toBe("General chat");
  });

  it("strips re-export counter on the bare placeholder", () => {
    expect(normalizeWhatsAppChatName("General chat (2)")).toBe("General chat");
  });

  it("leaves a whole-parenthetical name untouched", () => {
    expect(normalizeWhatsAppChatName("(Family)")).toBe("(Family)");
  });

  it("is idempotent on a clean name", () => {
    const clean = "General chat";
    expect(normalizeWhatsAppChatName(clean)).toBe(clean);
    expect(
      normalizeWhatsAppChatName(normalizeWhatsAppChatName(clean)),
    ).toBe(clean);
  });

  it("preserves case", () => {
    expect(normalizeWhatsAppChatName("Dad")).toBe("Dad");
    expect(normalizeWhatsAppChatName("dad")).toBe("dad");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeWhatsAppChatName("")).toBe("");
  });
});

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

  it("hashWhatsAppId hashes on the normalized chat name", () => {
    const base = {
      sender: "waldo",
      sentAtIso: "2026-04-15T07:03:17.000Z",
      body: "x",
    };
    const counter = hashWhatsAppId({ ...base, chat: "BC Dev Talk (2)" });
    const bare = hashWhatsAppId({ ...base, chat: "BC Dev Talk" });
    const placeholder = hashWhatsAppId({
      ...base,
      chat: "General chat (BC Dev Talk)",
    });
    expect(counter).toBe(bare);
    expect(placeholder).toBe(bare);
  });

  it("hashWhatsAppId keeps unrelated chats separate", () => {
    const base = {
      sender: "waldo",
      sentAtIso: "2026-04-15T07:03:17.000Z",
      body: "x",
    };
    const unnamed = hashWhatsAppId({ ...base, chat: "General chat" });
    const named = hashWhatsAppId({
      ...base,
      chat: "General chat (BC Dev Talk)",
    });
    expect(unnamed).not.toBe(named);
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

  it("toWhatsAppMessage sets threadId=normalized and threadName=raw", () => {
    const raw: ParsedWhatsAppMessage = {
      ...PARSED,
      chat: "General chat (BC Dev Talk)",
    };
    const msg = toWhatsAppMessage(raw, { account: "waldo-phone", importedAt });
    expect(msg.threadId).toBe("BC Dev Talk");
    expect(msg.threadName).toBe("General chat (BC Dev Talk)");
  });

  it("re-imports of the same logical chat converge on id and threadId", () => {
    const bare = toWhatsAppMessage(
      { ...PARSED, chat: "BC Dev Talk" },
      { account: "waldo-phone", importedAt },
    );
    const counter = toWhatsAppMessage(
      { ...PARSED, chat: "BC Dev Talk (2)" },
      { account: "waldo-phone", importedAt },
    );
    const placeholder = toWhatsAppMessage(
      { ...PARSED, chat: "General chat (BC Dev Talk)" },
      { account: "waldo-phone", importedAt },
    );
    expect(counter.id).toBe(bare.id);
    expect(placeholder.id).toBe(bare.id);
    expect(counter.threadId).toBe("BC Dev Talk");
    expect(placeholder.threadId).toBe("BC Dev Talk");
    expect(bare.threadName).toBe("BC Dev Talk");
    expect(counter.threadName).toBe("BC Dev Talk (2)");
    expect(placeholder.threadName).toBe("General chat (BC Dev Talk)");
  });

  it("keeps unnamed-group 'General chat' distinct from named chats", () => {
    const unnamed = toWhatsAppMessage(
      { ...PARSED, chat: "General chat" },
      { account: "waldo-phone", importedAt },
    );
    const named = toWhatsAppMessage(
      { ...PARSED, chat: "General chat (BC Dev Talk)" },
      { account: "waldo-phone", importedAt },
    );
    expect(unnamed.threadId).toBe("General chat");
    expect(named.threadId).toBe("BC Dev Talk");
    expect(unnamed.id).not.toBe(named.id);
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
