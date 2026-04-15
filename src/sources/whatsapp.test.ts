import { describe, expect, it } from "vitest";
import {
  parseWhatsAppExport,
  WhatsAppParseError,
  type ParsedWhatsAppMessage,
} from "./whatsapp.js";

const BE_LOCALE = { locale: "mac-en-be" as const, timezone: "Europe/Brussels" as const };

describe("parseWhatsAppExport", () => {
  it("returns [] for empty input", () => {
    expect(parseWhatsAppExport("", { chatName: "Mom", ...BE_LOCALE })).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(parseWhatsAppExport("   \n\n  \n", { chatName: "Mom", ...BE_LOCALE })).toEqual([]);
  });

  it("parses a single one-line chat message", () => {
    const text = "[15/04/2026, 09:03:17] waldo: hello world";
    const out = parseWhatsAppExport(text, { chatName: "Mom", ...BE_LOCALE });
    expect(out).toHaveLength(1);
    const m = out[0] as ParsedWhatsAppMessage;
    expect(m.type).toBe("chat");
    expect(m.chat).toBe("Mom");
    expect(m.sender).toBe("waldo");
    expect(m.body).toBe("hello world");
    // 09:03:17 Europe/Brussels (CEST, +02:00) in April
    expect(m.sentAtIso).toBe("2026-04-15T07:03:17.000Z");
    expect(m.rawLine).toBe(text);
  });

  it("appends continuation lines to the previous chat message", () => {
    const text = [
      "[15/04/2026, 09:03:17] waldo: line one",
      "line two",
      "line three",
      "[15/04/2026, 09:04:00] waldo: next message",
    ].join("\n");
    const out = parseWhatsAppExport(text, { chatName: "Mom", ...BE_LOCALE });
    expect(out).toHaveLength(2);
    expect(out[0]!.body).toBe("line one\nline two\nline three");
    expect(out[1]!.body).toBe("next message");
  });

  it("classifies system messages (no ':' after the bracket) as system, not chat", () => {
    const text =
      "[15/04/2026, 09:03:17] Messages and calls are end-to-end encrypted.";
    const out = parseWhatsAppExport(text, {
      chatName: "Mom",
      ...BE_LOCALE,
      includeSystem: true,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("system");
    expect(out[0]!.sender).toBeUndefined();
    expect(out[0]!.body).toBe("Messages and calls are end-to-end encrypted.");
  });

  it("skips system messages by default", () => {
    const text =
      "[15/04/2026, 09:03:17] Messages and calls are end-to-end encrypted.";
    expect(parseWhatsAppExport(text, { chatName: "Mom", ...BE_LOCALE })).toEqual([]);
  });

  it("classifies <Media omitted> as media and skips by default", () => {
    const text = "[15/04/2026, 09:03:17] waldo: \u200e<Media omitted>";
    expect(parseWhatsAppExport(text, { chatName: "Mom", ...BE_LOCALE })).toEqual([]);
    const kept = parseWhatsAppExport(text, {
      chatName: "Mom",
      ...BE_LOCALE,
      includeMedia: true,
    });
    expect(kept).toHaveLength(1);
    expect(kept[0]!.type).toBe("media");
  });

  it("throws WhatsAppParseError on an unparseable leading line", () => {
    const text = "[99/99/9999, 25:99:99] waldo: garbage";
    expect(() =>
      parseWhatsAppExport(text, { chatName: "Mom", ...BE_LOCALE }),
    ).toThrow(WhatsAppParseError);
  });

  it("handles BOM and ZWSP at the start of the file", () => {
    const text =
      "\uFEFF\u200e[15/04/2026, 09:03:17] waldo: hello";
    const out = parseWhatsAppExport(text, { chatName: "Mom", ...BE_LOCALE });
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toBe("hello");
  });

  it("parses a Mac en-BE 24h date into the correct UTC ISO", () => {
    // January: Europe/Brussels is CET (+01:00).
    const text = "[03/01/2026, 23:15:00] waldo: winter time";
    const out = parseWhatsAppExport(text, { chatName: "Mom", ...BE_LOCALE });
    expect(out[0]!.sentAtIso).toBe("2026-01-03T22:15:00.000Z");
  });

  it("propagates chatName to every parsed row", () => {
    const text = [
      "[15/04/2026, 09:03:17] waldo: a",
      "[15/04/2026, 09:04:17] mom: b",
    ].join("\n");
    const out = parseWhatsAppExport(text, { chatName: "Mom", ...BE_LOCALE });
    expect(out.map((m) => m.chat)).toEqual(["Mom", "Mom"]);
  });

  it("throws when the first non-empty line is a continuation (no header)", () => {
    const text = "garbage line without header";
    expect(() =>
      parseWhatsAppExport(text, { chatName: "Mom", ...BE_LOCALE }),
    ).toThrow(WhatsAppParseError);
  });

  it("preserves blank lines inside a multi-line message body", () => {
    const text = [
      "[15/04/2026, 09:03:17] waldo: line one",
      "",
      "line three",
    ].join("\n");
    const out = parseWhatsAppExport(text, { chatName: "Mom", ...BE_LOCALE });
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toBe("line one\n\nline three");
  });

  it("rejects Feb 30 as an invalid calendar date", () => {
    const text = "[30/02/2026, 09:00:00] waldo: x";
    expect(() =>
      parseWhatsAppExport(text, { chatName: "Mom", ...BE_LOCALE }),
    ).toThrow(WhatsAppParseError);
  });

  it("is deterministic: parsing the same text twice yields equal objects", () => {
    const text = [
      "[15/04/2026, 09:03:17] waldo: a",
      "continuation",
      "[15/04/2026, 09:04:17] mom: b",
    ].join("\n");
    const a = parseWhatsAppExport(text, { chatName: "Mom", ...BE_LOCALE });
    const b = parseWhatsAppExport(text, { chatName: "Mom", ...BE_LOCALE });
    expect(a).toEqual(b);
  });
});
