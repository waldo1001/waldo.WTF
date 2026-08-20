import { describe, expect, it } from "vitest";
import type { Account } from "../auth/types.js";
import { FakeClock } from "../testing/fake-clock.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { FakeTranscriptClient } from "../testing/fake-transcript-client.js";
import {
  TranscriptNotAvailableError,
  TranscriptQuotaExhaustedError,
  type TranscriptClient,
  type TranscriptHandle,
} from "../sources/transcript.js";
import type { CalendarEvent } from "../store/types.js";
import {
  MAX_TRANSCRIPT_EVENTS_PER_TICK,
  NO_TRANSCRIPT_FOUND_MARKER,
  TRANSCRIPT_ELIGIBILITY_DAYS,
  syncTranscripts,
} from "./sync-transcripts.js";

const account: Account = {
  username: "a@example.test",
  homeAccountId: "home-1",
  tenantId: "tenant-1",
};

const NOW = new Date("2026-08-12T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_JOIN_URL = "https://join/default";

function event(
  overrides: Partial<CalendarEvent> & Pick<CalendarEvent, "eventId">,
): CalendarEvent {
  return {
    account: "a@example.test",
    startAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    endAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    isAllDay: false,
    isCancelled: false,
    onlineMeetingUrl: DEFAULT_JOIN_URL,
    // Deliberately present AND deliberately wrong: this column holds the
    // audio dial-in number, which 404s against the transcript API. Keeping
    // it in the default fixture means every test would catch a regression
    // back to gating/keying on it.
    onlineMeetingId: "dial-in-99999",
    attendees: [],
    ...overrides,
  };
}

function handle(
  overrides: Partial<TranscriptHandle> & Pick<TranscriptHandle, "transcriptId">,
): TranscriptHandle {
  return { createdAt: NOW.toISOString(), ...overrides };
}

class ScriptedTranscriptClient implements TranscriptClient {
  readonly calls: Array<
    | { method: "resolveOnlineMeetingId"; joinWebUrl: string }
    | { method: "listTranscripts"; onlineMeetingId: string }
    | { method: "fetchVttContent"; onlineMeetingId: string; transcriptId: string }
  > = [];

  constructor(
    private readonly listResults: Readonly<
      Record<string, readonly TranscriptHandle[] | Error>
    >,
    private readonly contentResults: Readonly<
      Record<string, { vtt: string } | Error>
    > = {},
    // Default maps the fixture joinUrl to the meeting id the listResults
    // keys use, so tests that don't care about resolution stay readable.
    private readonly resolveResults: Readonly<
      Record<string, string | null | Error>
    > = { [DEFAULT_JOIN_URL]: "meeting-default" },
  ) {}

  async resolveOnlineMeetingId(
    _account: string,
    joinWebUrl: string,
  ): Promise<string | null> {
    this.calls.push({ method: "resolveOnlineMeetingId", joinWebUrl });
    const result = this.resolveResults[joinWebUrl];
    if (result === undefined) {
      throw new Error(
        `ScriptedTranscriptClient: no resolve script for ${joinWebUrl}`,
      );
    }
    if (result instanceof Error) throw result;
    return result;
  }

  async listTranscripts(
    _account: string,
    onlineMeetingId: string,
  ): Promise<readonly TranscriptHandle[]> {
    this.calls.push({ method: "listTranscripts", onlineMeetingId });
    const result = this.listResults[onlineMeetingId];
    if (result === undefined) {
      throw new Error(`ScriptedTranscriptClient: no script for ${onlineMeetingId}`);
    }
    if (result instanceof Error) throw result;
    return result;
  }

  async fetchVttContent(
    _account: string,
    onlineMeetingId: string,
    h: TranscriptHandle,
  ): Promise<{ readonly vtt: string }> {
    this.calls.push({
      method: "fetchVttContent",
      onlineMeetingId,
      transcriptId: h.transcriptId,
    });
    const result = this.contentResults[h.transcriptId];
    if (result === undefined) {
      throw new Error(`ScriptedTranscriptClient: no content script for ${h.transcriptId}`);
    }
    if (result instanceof Error) throw result;
    return result;
  }
}

const SAMPLE_VTT = [
  "WEBVTT",
  "",
  "00:00:01.000 --> 00:00:04.000",
  "<v Kristof>Hello everyone.",
].join("\n");

describe("syncTranscripts", () => {
  it("fetches and stores a transcript for an eligible, ended online-meeting event", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const clock = new FakeClock(NOW);
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: { "meeting-default": [handle({ transcriptId: "tr-1" })] },
      vttByTranscriptId: { "tr-1": SAMPLE_VTT },
      meetingIdByJoinUrl: { [DEFAULT_JOIN_URL]: "meeting-default" },
    });
    const result = await syncTranscripts({ account, store, transcripts: client, clock });
    expect(result).toEqual({ fetched: 1 });

    const got = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: "tr-1",
    });
    expect(got?.transcript.status).toBe("ok");
    expect(got?.segments).toHaveLength(1);
    expect(got?.segments[0]).toMatchObject({
      speakerDisplayName: "Kristof",
      text: "Hello everyone.",
    });
    expect(got?.segments[0]).not.toHaveProperty("speakerEmail");
  });

  it("persists speakerEmail on a segment when the voice tag class is email-shaped", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const clock = new FakeClock(NOW);
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "<v.kristof@example.test Kristof Peeters>Hello everyone.",
    ].join("\n");
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: { "meeting-default": [handle({ transcriptId: "tr-1" })] },
      vttByTranscriptId: { "tr-1": vtt },
      meetingIdByJoinUrl: { [DEFAULT_JOIN_URL]: "meeting-default" },
    });
    await syncTranscripts({ account, store, transcripts: client, clock });

    const got = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: "tr-1",
    });
    expect(got?.segments[0]).toMatchObject({
      speakerDisplayName: "Kristof Peeters",
      speakerEmail: "kristof@example.test",
      text: "Hello everyone.",
    });
  });

  it("omits speakerDisplayName on a segment when the cue has no voice tag at all", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const clock = new FakeClock(NOW);
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "Hello everyone.",
    ].join("\n");
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: { "meeting-default": [handle({ transcriptId: "tr-1" })] },
      vttByTranscriptId: { "tr-1": vtt },
      meetingIdByJoinUrl: { [DEFAULT_JOIN_URL]: "meeting-default" },
    });
    await syncTranscripts({ account, store, transcripts: client, clock });

    const got = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: "tr-1",
    });
    expect(got?.segments[0]?.text).toBe("Hello everyone.");
    expect(got?.segments[0]).not.toHaveProperty("speakerDisplayName");
  });

  it("an event with a joinUrl but no onlineMeetingId is eligible (the id column is the wrong identifier)", async () => {
    // Production reality: 401 of ~1264 ifacto events carry a joinUrl,
    // only 9 carry a conferenceId. Gating on the id made the feature dead.
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({ eventId: "evt-url-only", onlineMeetingId: undefined }),
    ]);
    const clock = new FakeClock(NOW);
    const client = new ScriptedTranscriptClient({
      "meeting-default": [handle({ transcriptId: "tr-1" })],
    }, { "tr-1": { vtt: SAMPLE_VTT } });
    const result = await syncTranscripts({ account, store, transcripts: client, clock });
    expect(result).toEqual({ fetched: 1 });
  });

  it("an event without a joinUrl is skipped even if it has an onlineMeetingId", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({
        eventId: "evt-no-url",
        onlineMeetingUrl: undefined,
        onlineMeetingId: "dial-in-12345",
      }),
    ]);
    const clock = new FakeClock(NOW);
    const client = new ScriptedTranscriptClient({});
    const result = await syncTranscripts({ account, store, transcripts: client, clock });
    expect(result).toEqual({ fetched: 0 });
    expect(client.calls).toEqual([]);
  });

  it("the resolved onlineMeeting id, not events.online_meeting_id, is passed to listTranscripts and fetchVttContent", async () => {
    // The regression this whole fix exists for: the stored column must
    // never reach the transcript endpoints.
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({
        eventId: "evt-1",
        onlineMeetingUrl: "https://join/real",
        onlineMeetingId: "dial-in-99999",
      }),
    ]);
    const clock = new FakeClock(NOW);
    const client = new ScriptedTranscriptClient(
      { "MSp-resolved-id": [handle({ transcriptId: "tr-1" })] },
      { "tr-1": { vtt: SAMPLE_VTT } },
      { "https://join/real": "MSp-resolved-id" },
    );
    await syncTranscripts({ account, store, transcripts: client, clock });

    expect(client.calls).toEqual([
      { method: "resolveOnlineMeetingId", joinWebUrl: "https://join/real" },
      { method: "listTranscripts", onlineMeetingId: "MSp-resolved-id" },
      {
        method: "fetchVttContent",
        onlineMeetingId: "MSp-resolved-id",
        transcriptId: "tr-1",
      },
    ]);
    const seenIds = client.calls.map((c) =>
      "onlineMeetingId" in c ? c.onlineMeetingId : undefined,
    );
    expect(seenIds).not.toContain("dial-in-99999");
  });

  it("a joinUrl that resolves to null records a not-available marker and never lists transcripts", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const clock = new FakeClock(NOW);
    const client = new ScriptedTranscriptClient({}, {}, {
      [DEFAULT_JOIN_URL]: null,
    });
    const result = await syncTranscripts({ account, store, transcripts: client, clock });
    expect(result).toEqual({ fetched: 0 });
    expect(client.calls).toEqual([
      { method: "resolveOnlineMeetingId", joinWebUrl: DEFAULT_JOIN_URL },
    ]);
    const got = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: NO_TRANSCRIPT_FOUND_MARKER,
    });
    expect(got?.transcript.status).toBe("not-available");
  });

  it("a resolution-null marker is not retried on a later tick", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const client = new ScriptedTranscriptClient({}, {}, {
      [DEFAULT_JOIN_URL]: null,
    });
    await syncTranscripts({ account, store, transcripts: client, clock: new FakeClock(NOW) });
    expect(client.calls).toHaveLength(1);

    // Still inside the eligibility window, so only the marker can stop it.
    await syncTranscripts({
      account,
      store,
      transcripts: client,
      clock: new FakeClock(new Date(NOW.getTime() + 3 * 60 * 60 * 1000)),
    });
    expect(client.calls).toHaveLength(1);
  });

  it("a consent-required error from resolveOnlineMeetingId propagates and records no status row", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const consentError = new Error(
      "AADSTS65001: user or admin has not consented",
    );
    const client = new ScriptedTranscriptClient({}, {}, {
      [DEFAULT_JOIN_URL]: consentError,
    });
    await expect(
      syncTranscripts({ account, store, transcripts: client, clock: new FakeClock(NOW) }),
    ).rejects.toThrow(consentError);
    const got = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: NO_TRANSCRIPT_FOUND_MARKER,
    });
    expect(got).toBeNull();
  });

  it("skips events that haven't ended yet", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({
        eventId: "evt-ongoing",
        startAt: new Date(NOW.getTime() - 30 * 60 * 1000),
        endAt: new Date(NOW.getTime() + 30 * 60 * 1000),
      }),
    ]);
    const clock = new FakeClock(NOW);
    const client = new ScriptedTranscriptClient({});
    const result = await syncTranscripts({ account, store, transcripts: client, clock });
    expect(result).toEqual({ fetched: 0 });
    expect(client.calls).toEqual([]);
  });

  it("skips an event ending at exactly now (not yet fully ended)", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([
      event({
        eventId: "evt-boundary",
        startAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        endAt: NOW,
      }),
    ]);
    const clock = new FakeClock(NOW);
    const client = new ScriptedTranscriptClient({});
    const result = await syncTranscripts({ account, store, transcripts: client, clock });
    expect(result).toEqual({ fetched: 0 });
    expect(client.calls).toEqual([]);
  });

  it("skips events that ended before the eligibility window", async () => {
    const store = new InMemoryMessageStore();
    const tooOld = new Date(
      NOW.getTime() - (TRANSCRIPT_ELIGIBILITY_DAYS + 1) * DAY_MS,
    );
    await store.upsertEvents([
      event({
        eventId: "evt-old",
        startAt: new Date(tooOld.getTime() - 60 * 60 * 1000),
        endAt: tooOld,
      }),
    ]);
    const clock = new FakeClock(NOW);
    const client = new ScriptedTranscriptClient({});
    const result = await syncTranscripts({ account, store, transcripts: client, clock });
    expect(result).toEqual({ fetched: 0 });
    expect(client.calls).toEqual([]);
  });

  it("includes an event right at the eligibility boundary", async () => {
    const store = new InMemoryMessageStore();
    const boundary = new Date(
      NOW.getTime() - TRANSCRIPT_ELIGIBILITY_DAYS * DAY_MS + 60_000,
    );
    await store.upsertEvents([
      event({
        eventId: "evt-boundary",
        startAt: new Date(boundary.getTime() - 60 * 60 * 1000),
        endAt: boundary,
        onlineMeetingId: "meeting-boundary",
      }),
    ]);
    const clock = new FakeClock(NOW);
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: { "meeting-boundary": [] },
      vttByTranscriptId: {},
      meetingIdByJoinUrl: { [DEFAULT_JOIN_URL]: "meeting-default" },
    });
    await syncTranscripts({ account, store, transcripts: client, clock });
    expect(client.calls).toEqual([
      {
        method: "resolveOnlineMeetingId",
        account: "a@example.test",
        joinWebUrl: DEFAULT_JOIN_URL,
      },
      {
        method: "listTranscripts",
        account: "a@example.test",
        onlineMeetingId: "meeting-default",
      },
    ]);
  });

  it("caps eligible events at MAX_TRANSCRIPT_EVENTS_PER_TICK per tick", async () => {
    const store = new InMemoryMessageStore();
    const events = Array.from({ length: MAX_TRANSCRIPT_EVENTS_PER_TICK + 5 }, (_, i) =>
      event({
        eventId: `evt-${i}`,
        onlineMeetingUrl: `https://join/${i}`,
        startAt: new Date(NOW.getTime() - (i + 2) * 60 * 60 * 1000),
        endAt: new Date(NOW.getTime() - (i + 1) * 60 * 60 * 1000),
      }),
    );
    await store.upsertEvents(events);
    const clock = new FakeClock(NOW);
    const listResults: Record<string, readonly TranscriptHandle[]> = {};
    const resolveResults: Record<string, string> = {};
    for (let i = 0; i < events.length; i++) {
      listResults[`meeting-${i}`] = [];
      resolveResults[`https://join/${i}`] = `meeting-${i}`;
    }
    const client = new ScriptedTranscriptClient(listResults, {}, resolveResults);
    await syncTranscripts({ account, store, transcripts: client, clock });
    // One resolve + one list per capped event.
    expect(client.calls).toHaveLength(MAX_TRANSCRIPT_EVENTS_PER_TICK * 2);
    expect(
      client.calls.filter((c) => c.method === "listTranscripts"),
    ).toHaveLength(MAX_TRANSCRIPT_EVENTS_PER_TICK);
  });

  it("persists a not-available marker row when Graph reports zero transcripts", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const clock = new FakeClock(NOW);
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: { "meeting-default": [] },
      vttByTranscriptId: {},
      meetingIdByJoinUrl: { [DEFAULT_JOIN_URL]: "meeting-default" },
    });
    await syncTranscripts({ account, store, transcripts: client, clock });
    const got = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: NO_TRANSCRIPT_FOUND_MARKER,
    });
    expect(got?.transcript.status).toBe("not-available");
  });

  it("a not-available marker is never retried on a later tick, even while the event is still in-window", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const clock = new FakeClock(NOW);
    const client = new ScriptedTranscriptClient({ "meeting-default": [] });
    await syncTranscripts({ account, store, transcripts: client, clock });
    expect(client.calls).toHaveLength(2); // resolve + list

    // A few hours later — event is still well inside the 60-day
    // eligibility window, so this exercises isEligible's actual
    // not-available branch rather than the event just aging out.
    const laterClock = new FakeClock(new Date(NOW.getTime() + 3 * 60 * 60 * 1000));
    await syncTranscripts({ account, store, transcripts: client, clock: laterClock });
    expect(client.calls).toHaveLength(2);

    // Much later still (past the window entirely) — still never retried.
    const muchLaterClock = new FakeClock(new Date(NOW.getTime() + 100 * DAY_MS));
    await syncTranscripts({ account, store, transcripts: client, clock: muchLaterClock });
    expect(client.calls).toHaveLength(2);
  });

  it("persists quota-exhausted status and retries only after the 7-day cooldown", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const client = new ScriptedTranscriptClient({
      "meeting-default": new TranscriptQuotaExhaustedError(),
    });
    await syncTranscripts({
      account,
      store,
      transcripts: client,
      clock: new FakeClock(NOW),
    });
    const got = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: NO_TRANSCRIPT_FOUND_MARKER,
    });
    expect(got?.transcript.status).toBe("quota-exhausted");
    expect(client.calls).toHaveLength(2); // resolve + list

    // Before the cooldown: not retried.
    await syncTranscripts({
      account,
      store,
      transcripts: client,
      clock: new FakeClock(new Date(NOW.getTime() + 6 * DAY_MS)),
    });
    expect(client.calls).toHaveLength(2); // unchanged: still in cooldown

    // After the cooldown: retried.
    await syncTranscripts({
      account,
      store,
      transcripts: client,
      clock: new FakeClock(new Date(NOW.getTime() + 7 * DAY_MS)),
    });
    expect(client.calls).toHaveLength(4); // resolve + list again
  });

  it("persists fetch-failed status and retries only after the 24h cooldown", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const client = new ScriptedTranscriptClient({
      "meeting-default": new Error("network blip"),
    });
    await syncTranscripts({
      account,
      store,
      transcripts: client,
      clock: new FakeClock(NOW),
    });
    const got = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: NO_TRANSCRIPT_FOUND_MARKER,
    });
    expect(got?.transcript.status).toBe("fetch-failed");

    await syncTranscripts({
      account,
      store,
      transcripts: client,
      clock: new FakeClock(new Date(NOW.getTime() + 23 * 60 * 60 * 1000)),
    });
    expect(client.calls).toHaveLength(2); // unchanged: still in cooldown

    await syncTranscripts({
      account,
      store,
      transcripts: client,
      clock: new FakeClock(new Date(NOW.getTime() + 24 * 60 * 60 * 1000)),
    });
    expect(client.calls).toHaveLength(4); // cooldown elapsed: resolve + list again
  });

  it("when multiple rows exist for one event, the most-recently-fetched row governs even if it wasn't inserted last", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    // Insert an OLDER not-available row (never retried) AFTER a NEWER
    // quota-exhausted row, so array/insertion order disagrees with
    // fetchedAt order — only a real fetchedAt sort picks the newer row.
    await store.markTranscriptStatus(
      { account: "a@example.test", eventId: "evt-1", transcriptId: "tr-quota" },
      "quota-exhausted",
      new Date(NOW.getTime() - 8 * DAY_MS),
    );
    await store.markTranscriptStatus(
      { account: "a@example.test", eventId: "evt-1", transcriptId: NO_TRANSCRIPT_FOUND_MARKER },
      "not-available",
      new Date(NOW.getTime() - 90 * DAY_MS),
    );
    const client = new ScriptedTranscriptClient({});
    // If the older not-available row wrongly governed, this would stay
    // ineligible forever; the real (newer) quota-exhausted row's 7-day
    // cooldown has already elapsed, so it must be retried.
    const result = await syncTranscripts({ account, store, transcripts: client, clock: new FakeClock(NOW) });
    expect(result).toEqual({ fetched: 0 });
    expect(client.calls).toHaveLength(2); // resolve + list
  });

  it("an event with an OLDER ok row is permanently done even when a NEWER row for it isn't ok", async () => {
    // Distinguishes the "any row is ok" rule from a naive "only look at
    // the latest row" rule: a recording restart could produce a second,
    // failed transcript attempt after the first one already succeeded —
    // the event must stay done, not re-enter the fetch-failed retry cycle.
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    await store.markTranscriptStatus(
      { account: "a@example.test", eventId: "evt-1", transcriptId: "tr-ok" },
      "ok",
      new Date(NOW.getTime() - 10 * DAY_MS),
    );
    await store.markTranscriptStatus(
      { account: "a@example.test", eventId: "evt-1", transcriptId: "tr-retry" },
      "fetch-failed",
      new Date(NOW.getTime() - 1 * DAY_MS),
    );
    const client = new ScriptedTranscriptClient({});
    const result = await syncTranscripts({ account, store, transcripts: client, clock: new FakeClock(NOW) });
    expect(result).toEqual({ fetched: 0 });
    expect(client.calls).toEqual([]);
  });

  it("an event with an already-ok transcript is never re-checked", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const client = new FakeTranscriptClient({
      transcriptsByMeeting: { "meeting-default": [handle({ transcriptId: "tr-1" })] },
      vttByTranscriptId: { "tr-1": SAMPLE_VTT },
      meetingIdByJoinUrl: { [DEFAULT_JOIN_URL]: "meeting-default" },
    });
    await syncTranscripts({ account, store, transcripts: client, clock: new FakeClock(NOW) });
    expect(client.calls).toHaveLength(3); // resolve + list + fetch content

    await syncTranscripts({
      account,
      store,
      transcripts: client,
      clock: new FakeClock(new Date(NOW.getTime() + 100 * DAY_MS)),
    });
    expect(client.calls).toHaveLength(3); // unchanged — not re-checked
  });

  it("marks the real transcriptId (not the marker) when content fetch fails for a listed transcript", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const client = new ScriptedTranscriptClient(
      { "meeting-default": [handle({ transcriptId: "tr-1" })] },
      { "tr-1": new TranscriptNotAvailableError() },
    );
    await syncTranscripts({ account, store, transcripts: client, clock: new FakeClock(NOW) });
    const marker = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: NO_TRANSCRIPT_FOUND_MARKER,
    });
    expect(marker).toBeNull();
    const real = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: "tr-1",
    });
    expect(real?.transcript.status).toBe("not-available");
  });

  it("handles multiple transcripts for one event independently — one succeeds, one fails", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const client = new ScriptedTranscriptClient(
      {
        "meeting-default": [
          handle({ transcriptId: "tr-1" }),
          handle({ transcriptId: "tr-2" }),
        ],
      },
      {
        "tr-1": { vtt: SAMPLE_VTT },
        "tr-2": new TranscriptQuotaExhaustedError(),
      },
    );
    const result = await syncTranscripts({
      account,
      store,
      transcripts: client,
      clock: new FakeClock(NOW),
    });
    expect(result).toEqual({ fetched: 1 });
    const tr1 = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: "tr-1",
    });
    const tr2 = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: "tr-2",
    });
    expect(tr1?.transcript.status).toBe("ok");
    expect(tr2?.transcript.status).toBe("quota-exhausted");
  });

  it("an unscripted listTranscripts throw maps to fetch-failed by default", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const client = new ScriptedTranscriptClient({
      "meeting-default": new Error("boom"),
    });
    await syncTranscripts({ account, store, transcripts: client, clock: new FakeClock(NOW) });
    const got = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: NO_TRANSCRIPT_FOUND_MARKER,
    });
    expect(got?.transcript.status).toBe("fetch-failed");
  });

  it("propagates a consent-required error instead of recording it as a per-event status", async () => {
    // Unlike a genuine per-meeting failure, "scope not consented" is an
    // account-level condition — swallowing it into a fetch-failed marker
    // would silently retry-loop every 24h and never surface the
    // actionable admin-consent hint. Mirrors syncCalendarEvents, which
    // likewise lets consent errors propagate to the scheduler's catch
    // block instead of persisting a misleading per-event status.
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const consentError = new Error(
      "AADSTS65001: user or admin has not consented",
    );
    const client = new ScriptedTranscriptClient({
      "meeting-default": consentError,
    });
    await expect(
      syncTranscripts({ account, store, transcripts: client, clock: new FakeClock(NOW) }),
    ).rejects.toThrow(consentError);
    const got = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: NO_TRANSCRIPT_FOUND_MARKER,
    });
    expect(got).toBeNull();
  });

  it("propagates a consent-required error from fetchVttContent too, without marking the real transcriptId", async () => {
    const store = new InMemoryMessageStore();
    await store.upsertEvents([event({ eventId: "evt-1" })]);
    const consentError = new Error("interaction_required");
    const client = new ScriptedTranscriptClient(
      { "meeting-default": [handle({ transcriptId: "tr-1" })] },
      { "tr-1": consentError },
    );
    await expect(
      syncTranscripts({ account, store, transcripts: client, clock: new FakeClock(NOW) }),
    ).rejects.toThrow(consentError);
    const got = await store.getTranscriptByKey({
      account: "a@example.test",
      eventId: "evt-1",
      transcriptId: "tr-1",
    });
    expect(got).toBeNull();
  });
});
