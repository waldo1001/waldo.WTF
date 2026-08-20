import { describe, expect, it } from "vitest";
import type { TranscriptHandle } from "../sources/transcript.js";
import {
  FakeTranscriptClient,
  UnknownTranscriptContentError,
  UnknownTranscriptMeetingError,
} from "./fake-transcript-client.js";

function handle(
  overrides: Partial<TranscriptHandle> & Pick<TranscriptHandle, "transcriptId">,
): TranscriptHandle {
  return { createdAt: "2026-04-13T12:00:00Z", ...overrides };
}

describe("FakeTranscriptClient", () => {
  it("resolveOnlineMeetingId returns the fixture id and records the call", async () => {
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: {},
      vttByTranscriptId: {},
      meetingIdByJoinUrl: { "https://join/1": "meeting-1" },
    });
    const id = await client.resolveOnlineMeetingId(
      "a@example.test",
      "https://join/1",
    );
    expect(id).toBe("meeting-1");
    expect(client.calls).toEqual([
      {
        method: "resolveOnlineMeetingId",
        account: "a@example.test",
        joinWebUrl: "https://join/1",
      },
    ]);
  });

  it("resolveOnlineMeetingId returns null for a joinUrl scripted as unresolvable", async () => {
    // null models Graph matching no meeting — expired, or not visible to
    // this account — which the sync job treats as not-available, not error.
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: {},
      vttByTranscriptId: {},
      meetingIdByJoinUrl: { "https://join/gone": null },
    });
    expect(
      await client.resolveOnlineMeetingId("a@example.test", "https://join/gone"),
    ).toBeNull();
  });

  it("resolveOnlineMeetingId throws on an unscripted joinUrl so loop bugs surface early", async () => {
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: {},
      vttByTranscriptId: {},
      meetingIdByJoinUrl: {},
    });
    await expect(
      client.resolveOnlineMeetingId("a@example.test", "https://join/bogus"),
    ).rejects.toThrow(UnknownTranscriptMeetingError);
  });

  it("listTranscripts returns the scripted handles for a known onlineMeetingId", async () => {
    const h = handle({ transcriptId: "tr-1" });
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: { "meeting-1": [h] },
      vttByTranscriptId: {},
    });
    const handles = await client.listTranscripts("a@example.test", "meeting-1");
    expect(handles).toEqual([h]);
  });

  it("listTranscripts throws on an unknown onlineMeetingId so loop bugs surface early", async () => {
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: { "meeting-1": [] },
      vttByTranscriptId: {},
    });
    await expect(
      client.listTranscripts("a@example.test", "meeting-bogus"),
    ).rejects.toThrow(/no scripted transcripts for onlineMeetingId "meeting-bogus"/);
    await expect(
      client.listTranscripts("a@example.test", "meeting-bogus"),
    ).rejects.toThrow(UnknownTranscriptMeetingError);
  });

  it("listTranscripts returns an empty array for a meeting scripted with zero transcripts (not an error)", async () => {
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: { "meeting-1": [] },
      vttByTranscriptId: {},
    });
    await expect(
      client.listTranscripts("a@example.test", "meeting-1"),
    ).resolves.toEqual([]);
  });

  it("fetchVttContent returns the scripted VTT for a known transcriptId", async () => {
    const h = handle({ transcriptId: "tr-1" });
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: {},
      vttByTranscriptId: { "tr-1": "WEBVTT\n\nhello" },
    });
    const result = await client.fetchVttContent("a@example.test", "meeting-1", h);
    expect(result).toEqual({ vtt: "WEBVTT\n\nhello" });
  });

  it("fetchVttContent throws on an unknown transcriptId", async () => {
    const h = handle({ transcriptId: "tr-bogus" });
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: {},
      vttByTranscriptId: { "tr-1": "WEBVTT\n\nhello" },
    });
    await expect(
      client.fetchVttContent("a@example.test", "meeting-1", h),
    ).rejects.toThrow(/no scripted VTT content for transcriptId "tr-bogus"/);
    await expect(
      client.fetchVttContent("a@example.test", "meeting-1", h),
    ).rejects.toThrow(UnknownTranscriptContentError);
  });

  it("records every call in order, with method-specific fields including account", async () => {
    const h = handle({ transcriptId: "tr-1" });
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: { "meeting-1": [h] },
      vttByTranscriptId: { "tr-1": "WEBVTT\n\nhi" },
    });
    await client.listTranscripts("a@example.test", "meeting-1");
    await client.fetchVttContent("a@example.test", "meeting-1", h);
    expect(client.calls).toEqual([
      {
        method: "listTranscripts",
        account: "a@example.test",
        onlineMeetingId: "meeting-1",
      },
      {
        method: "fetchVttContent",
        account: "a@example.test",
        onlineMeetingId: "meeting-1",
        handle: h,
      },
    ]);
  });

  it("keeps fixtures for different meetings isolated", async () => {
    const h1 = handle({ transcriptId: "tr-1" });
    const h2 = handle({ transcriptId: "tr-2" });
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: {
        "meeting-1": [h1],
        "meeting-2": [h2],
      },
      vttByTranscriptId: {},
    });
    await expect(
      client.listTranscripts("a@example.test", "meeting-1"),
    ).resolves.toEqual([h1]);
    await expect(
      client.listTranscripts("a@example.test", "meeting-2"),
    ).resolves.toEqual([h2]);
  });
});
