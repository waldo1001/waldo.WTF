import {
  TranscriptNotAvailableError,
  TranscriptQuotaExhaustedError,
  type TranscriptClient,
  type TranscriptHandle,
} from "./transcript.js";
import { GraphRateLimitedError, TokenExpiredError } from "./graph.js";
import type { FetchLike } from "./http-graph-client.js";

// Mirrors HttpCalendarClient's GetCalendarAccessToken shape — the client
// resolves its own token per call via this callback, keyed by account, with
// forceRefresh threaded through for the same same-tick 401 self-heal.
export type GetTranscriptAccessToken = (
  account: string,
  scope: string,
  forceRefresh: boolean,
) => Promise<string>;

export interface HttpTranscriptClientOptions {
  readonly fetch: FetchLike;
  readonly getAccessToken: GetTranscriptAccessToken;
  readonly scope?: string;
  readonly baseUrl?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly maxRetries?: number;
}

interface GraphTranscriptListEntry {
  readonly id: string;
  readonly createdDateTime: string;
  readonly transcriptContentUrl?: string;
}

interface GraphTranscriptListResponse {
  readonly value: readonly GraphTranscriptListEntry[];
}

const DEFAULT_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_SCOPE =
  "https://graph.microsoft.com/OnlineMeetingTranscript.Read.All";
const RETRY_BACKOFF_MS = [250, 750] as const;
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export class HttpTranscriptClient implements TranscriptClient {
  readonly #fetch: FetchLike;
  readonly #getAccessToken: GetTranscriptAccessToken;
  readonly #scope: string;
  readonly #baseUrl: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #maxRetries: number;

  constructor(opts: HttpTranscriptClientOptions) {
    this.#fetch = opts.fetch;
    this.#getAccessToken = opts.getAccessToken;
    this.#scope = opts.scope ?? DEFAULT_SCOPE;
    this.#baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.#sleep =
      opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#random = opts.random ?? Math.random;
    this.#maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async listTranscripts(
    account: string,
    onlineMeetingId: string,
  ): Promise<readonly TranscriptHandle[]> {
    const url = `${this.#baseUrl}/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts`;
    const raw = await this.#requestWithTokenRetry<GraphTranscriptListResponse>(
      url,
      account,
      "application/json",
    );
    return raw.value.map((e) => ({
      transcriptId: e.id,
      createdAt: e.createdDateTime,
      ...(e.transcriptContentUrl !== undefined && {
        contentUrl: e.transcriptContentUrl,
      }),
    }));
  }

  async fetchVttContent(
    account: string,
    onlineMeetingId: string,
    handle: TranscriptHandle,
  ): Promise<{ readonly vtt: string }> {
    const url =
      handle.contentUrl ??
      `${this.#baseUrl}/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts/${encodeURIComponent(handle.transcriptId)}/content?$format=text/vtt`;
    const vtt = await this.#requestWithTokenRetry<string>(
      url,
      account,
      "text/vtt",
    );
    return { vtt };
  }

  // 401 → force-refresh the token once and retry the same request. A
  // second 401 surfaces as TokenExpiredError — mirrors
  // HttpCalendarClient's #requestWithTokenRetry exactly.
  async #requestWithTokenRetry<T>(
    url: string,
    account: string,
    accept: "application/json" | "text/vtt",
  ): Promise<T> {
    const token = await this.#getAccessToken(account, this.#scope, false);
    try {
      return await this.#request<T>(url, token, accept);
    } catch (err) {
      if (!(err instanceof TokenExpiredError)) throw err;
      const freshToken = await this.#getAccessToken(account, this.#scope, true);
      return this.#request<T>(url, freshToken, accept);
    }
  }

  async #request<T>(
    url: string,
    token: string,
    accept: "application/json" | "text/vtt",
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.#fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept,
        },
      });

      if (res.status === 401) throw new TokenExpiredError();
      if (res.status === 402) throw new TranscriptQuotaExhaustedError();
      if (res.status === 403 || res.status === 404) {
        throw new TranscriptNotAvailableError();
      }
      if (res.status === 429) {
        const header = res.headers.get("Retry-After");
        const parsed = header ? Number.parseInt(header, 10) : Number.NaN;
        const retryAfterSeconds =
          Number.isFinite(parsed) && parsed >= 0 ? parsed : 60;
        throw new GraphRateLimitedError(retryAfterSeconds);
      }
      if (res.status < 200 || res.status >= 300) {
        const raw = (await res.text()).slice(0, 200);
        const body = raw.split(token).join("[redacted]");
        if (
          TRANSIENT_STATUSES.has(res.status) &&
          attempt < this.#maxRetries
        ) {
          const base = RETRY_BACKOFF_MS[attempt]!;
          await this.#sleep(base + this.#random() * base);
          continue;
        }
        throw new Error(
          `transcript request failed: HTTP ${res.status}: ${body}`,
        );
      }

      const text = await res.text();
      return (accept === "text/vtt" ? text : JSON.parse(text)) as T;
    }
  }
}

export interface VttCue {
  readonly sequence: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerName?: string;
  readonly speakerEmail?: string;
  readonly text: string;
}

const TIMESTAMP_RE = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/;
const CUE_TIMING_RE = /-->/;
// WebVTT voice tag: `<v Name>` or `<v.class Name>` (the class slot is
// formally for styling, e.g. loudness — some Teams tenants repurpose it to
// carry the speaker's email; we only treat it as an email when it looks
// like one, otherwise it's ignored rather than misreported as a name).
const VOICE_TAG_RE = /^<v(?:\.([^ >]+))?\s+([^>]*)>/;
const EMAIL_LIKE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseTimestampMs(raw: string): number | null {
  const m = TIMESTAMP_RE.exec(raw.trim());
  if (m === null) return null;
  const hours = m[1] !== undefined ? Number.parseInt(m[1], 10) : 0;
  const minutes = Number.parseInt(m[2]!, 10);
  const seconds = Number.parseInt(m[3]!, 10);
  const millis = Number.parseInt(m[4]!, 10);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

// Small, in-tree WebVTT parser — just enough to turn a Teams transcript
// into cues. Tolerates an optional cue-identifier line before the timing
// line, a voice tag with or without an email-shaped class, and overlapping
// cue times (Teams sometimes emits these; this parser doesn't validate
// ordering, just position). `sequence` is the 0-based order cues appear in
// the file, not any identifier embedded in the VTT itself — cue identifier
// lines are optional and not guaranteed to be sequential integers.
export function parseVtt(text: string): readonly VttCue[] {
  const lines = text.split(/\r\n|\r|\n/);
  const cues: VttCue[] = [];
  let i = 0;
  // Skip the "WEBVTT" header line and anything before the first blank line.
  if (lines[0]?.trim().startsWith("WEBVTT") === true) {
    i = 1;
  }

  while (i < lines.length) {
    while (i < lines.length && lines[i]!.trim() === "") i++;
    if (i >= lines.length) break;

    let timingLine = lines[i]!;
    if (!CUE_TIMING_RE.test(timingLine)) {
      // This was a cue-identifier line — the next one should be timing.
      i++;
      if (i >= lines.length) break;
      timingLine = lines[i]!;
    }
    if (!CUE_TIMING_RE.test(timingLine)) {
      // Not a cue we understand — skip to the next blank line and retry.
      while (i < lines.length && lines[i]!.trim() !== "") i++;
      continue;
    }
    const [startRaw, endRaw] = timingLine.split("-->").map((s) => s.trim());
    const startMs = startRaw !== undefined ? parseTimestampMs(startRaw) : null;
    const endMs =
      endRaw !== undefined ? parseTimestampMs(endRaw.split(" ")[0]!) : null;
    i++;

    const textLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "") {
      textLines.push(lines[i]!);
      i++;
    }
    const rawText = textLines.join(" ").trim();
    if (startMs === null || endMs === null || rawText === "") continue;

    const voiceMatch = VOICE_TAG_RE.exec(rawText);
    let speakerName: string | undefined;
    let speakerEmail: string | undefined;
    let cueText = rawText;
    if (voiceMatch !== null) {
      const cls = voiceMatch[1];
      const name = voiceMatch[2]!.trim();
      if (name !== "") speakerName = name;
      if (cls !== undefined && EMAIL_LIKE_RE.test(cls)) speakerEmail = cls;
      cueText = rawText.slice(voiceMatch[0].length).replace(/<\/v>\s*$/, "").trim();
    }

    cues.push({
      sequence: cues.length,
      startMs,
      endMs,
      ...(speakerName !== undefined && { speakerName }),
      ...(speakerEmail !== undefined && { speakerEmail }),
      text: cueText,
    });
  }

  return cues;
}
