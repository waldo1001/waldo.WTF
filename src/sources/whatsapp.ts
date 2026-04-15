export type WhatsAppLocale = "mac-en-be";
export type WhatsAppTimezone = "Europe/Brussels";

export type ParsedWhatsAppMessageType = "chat" | "system" | "media";

export interface ParsedWhatsAppMessage {
  readonly type: ParsedWhatsAppMessageType;
  readonly chat: string;
  readonly sender?: string;
  readonly sentAtIso: string;
  readonly body: string;
  readonly rawLine: string;
}

export interface ParseWhatsAppOptions {
  readonly chatName: string;
  readonly locale: WhatsAppLocale;
  readonly timezone: WhatsAppTimezone;
  readonly includeSystem?: boolean;
  readonly includeMedia?: boolean;
}

export class WhatsAppParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly rawLine: string,
  ) {
    super(`${message} (line ${line}): ${rawLine}`);
    this.name = "WhatsAppParseError";
  }
}

// [dd/mm/yyyy, HH:MM:SS] rest
const HEADER_RE =
  /^\[(\d{2})\/(\d{2})\/(\d{4}),\s(\d{2}):(\d{2}):(\d{2})\]\s(.*)$/;

const MEDIA_MARKER = "<Media omitted>";

// Strip byte-order mark + left/right-to-left marks WhatsApp injects.
function stripInvisible(s: string): string {
  return s.replace(/[\uFEFF\u200E\u200F]/g, "");
}

function zonedWallclockToUtcIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: WhatsAppTimezone,
): string {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(asIfUtc));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`Intl part ${type} missing`);
    return Number.parseInt(p.value, 10);
  };
  const zonedHour = get("hour") === 24 ? 0 : get("hour");
  const zonedAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    zonedHour,
    get("minute"),
    get("second"),
  );
  const offset = zonedAsUtc - asIfUtc;
  return new Date(asIfUtc - offset).toISOString();
}

function isValidDateTime(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): boolean {
  const inRange =
    mo >= 1 && mo <= 12 &&
    d >= 1 && d <= 31 &&
    h <= 23 &&
    mi <= 59 &&
    s <= 59;
  if (!inRange) return false;
  // Round-trip catches things like Feb 30.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

interface MutableParsed {
  type: ParsedWhatsAppMessageType;
  chat: string;
  sender?: string;
  sentAtIso: string;
  body: string;
  rawLine: string;
}

export function parseWhatsAppExport(
  text: string,
  opts: ParseWhatsAppOptions,
): readonly ParsedWhatsAppMessage[] {
  const includeSystem = opts.includeSystem ?? false;
  const includeMedia = opts.includeMedia ?? false;
  const lines = text.split(/\r?\n/);
  const out: MutableParsed[] = [];
  let current: MutableParsed | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] as string;
    const cleaned = stripInvisible(rawLine);
    if (cleaned.trim() === "" && !current) continue;

    const header = HEADER_RE.exec(cleaned);
    if (!header) {
      if (!current) {
        throw new WhatsAppParseError(
          "continuation line without a preceding header",
          i + 1,
          rawLine,
        );
      }
      current.body = current.body + "\n" + rawLine;
      continue;
    }

    const [, ddS, mmS, yyyyS, hhS, miS, ssS, rest] = header;
    const dd = Number.parseInt(ddS!, 10);
    const mm = Number.parseInt(mmS!, 10);
    const yyyy = Number.parseInt(yyyyS!, 10);
    const hh = Number.parseInt(hhS!, 10);
    const mi = Number.parseInt(miS!, 10);
    const ss = Number.parseInt(ssS!, 10);

    if (!isValidDateTime(yyyy, mm, dd, hh, mi, ss)) {
      throw new WhatsAppParseError(
        "invalid date/time in header",
        i + 1,
        rawLine,
      );
    }

    const sentAtIso = zonedWallclockToUtcIso(
      yyyy,
      mm,
      dd,
      hh,
      mi,
      ss,
      opts.timezone,
    );

    if (current) out.push(current);

    const restStr = rest ?? "";
    const colonIdx = restStr.indexOf(": ");
    if (colonIdx === -1) {
      current = {
        type: "system",
        chat: opts.chatName,
        sentAtIso,
        body: restStr,
        rawLine,
      };
      continue;
    }

    const sender = restStr.slice(0, colonIdx);
    const bodyRaw = restStr.slice(colonIdx + 2);
    const bodyClean = stripInvisible(bodyRaw);

    if (bodyClean === MEDIA_MARKER) {
      current = {
        type: "media",
        chat: opts.chatName,
        sender,
        sentAtIso,
        body: MEDIA_MARKER,
        rawLine,
      };
      continue;
    }

    current = {
      type: "chat",
      chat: opts.chatName,
      sender,
      sentAtIso,
      body: bodyClean,
      rawLine,
    };
  }

  if (current) out.push(current);

  return out.filter((m) => {
    if (m.type === "system" && !includeSystem) return false;
    if (m.type === "media" && !includeMedia) return false;
    return true;
  });
}
