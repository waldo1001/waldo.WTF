import type {
  TranscriptClient,
  TranscriptHandle,
} from "../sources/transcript.js";

// Thrown when a call is made for an onlineMeetingId the fixture never
// scripted transcripts for — surfaces loop bugs (wrong id threaded
// through) immediately instead of silently returning nothing.
export class UnknownTranscriptMeetingError extends Error {}

// Thrown when fetchVttContent is called for a transcriptId the fixture
// never scripted VTT content for.
export class UnknownTranscriptContentError extends Error {}

export type FakeTranscriptClientCall =
  | {
      readonly method: "listTranscripts";
      readonly account: string;
      readonly onlineMeetingId: string;
    }
  | {
      readonly method: "fetchVttContent";
      readonly account: string;
      readonly onlineMeetingId: string;
      readonly handle: TranscriptHandle;
    };

export interface FakeTranscriptClientOptions {
  // Keyed by onlineMeetingId.
  readonly transcriptsByMeeting: Readonly<
    Record<string, readonly TranscriptHandle[]>
  >;
  // Keyed by transcriptId.
  readonly vttByTranscriptId: Readonly<Record<string, string>>;
}

export class FakeTranscriptClient implements TranscriptClient {
  readonly calls: FakeTranscriptClientCall[] = [];
  private readonly transcriptsByMeeting: Readonly<
    Record<string, readonly TranscriptHandle[]>
  >;
  private readonly vttByTranscriptId: Readonly<Record<string, string>>;

  constructor(opts: FakeTranscriptClientOptions) {
    this.transcriptsByMeeting = opts.transcriptsByMeeting;
    this.vttByTranscriptId = opts.vttByTranscriptId;
  }

  async listTranscripts(
    account: string,
    onlineMeetingId: string,
  ): Promise<readonly TranscriptHandle[]> {
    this.calls.push({ method: "listTranscripts", account, onlineMeetingId });
    const handles = this.transcriptsByMeeting[onlineMeetingId];
    if (handles === undefined) {
      throw new UnknownTranscriptMeetingError(
        `FakeTranscriptClient: no scripted transcripts for onlineMeetingId "${onlineMeetingId}"`,
      );
    }
    return handles;
  }

  async fetchVttContent(
    account: string,
    onlineMeetingId: string,
    handle: TranscriptHandle,
  ): Promise<{ readonly vtt: string }> {
    this.calls.push({
      method: "fetchVttContent",
      account,
      onlineMeetingId,
      handle,
    });
    const vtt = this.vttByTranscriptId[handle.transcriptId];
    if (vtt === undefined) {
      throw new UnknownTranscriptContentError(
        `FakeTranscriptClient: no scripted VTT content for transcriptId "${handle.transcriptId}"`,
      );
    }
    return { vtt };
  }
}
