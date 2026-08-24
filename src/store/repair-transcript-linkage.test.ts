import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { repairTranscriptLinkage } from "./repair-transcript-linkage.js";

const JOIN_URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0?context=%7b%22Tid%22%3a%22ff451c7f%22%7d";
const JOIN_URL_THREAD_ID = "19:meeting_ABC@thread.v2";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

function insertEvent(
  db: Database.Database,
  row: {
    eventId: string;
    onlineMeetingUrl?: string | null;
    chatId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO events (account, event_id, start_at, end_at, chat_id, online_meeting_url)
     VALUES ('a@example.test', ?, '2026-04-13T10:00:00Z', '2026-04-13T11:00:00Z', ?, ?)`,
  ).run(row.eventId, row.chatId ?? null, row.onlineMeetingUrl ?? null);
}

function insertTranscript(
  db: Database.Database,
  row: { eventId: string; transcriptId: string; status: string },
): void {
  db.prepare(
    `INSERT INTO transcripts
       (account, event_id, transcript_id, fetched_at, segment_count, status)
     VALUES ('a@example.test', ?, ?, '2026-04-13T11:05:00Z', 0, ?)`,
  ).run(row.eventId, row.transcriptId, row.status);
}

describe("repairTranscriptLinkage", () => {
  it("clears bogus not-found markers so events get re-checked with a real meeting id", () => {
    // Every marker in production was written from a 404 caused by passing
    // the dial-in id to the transcript API — they are lies, and because
    // not-available is never retried they would suppress re-checks forever.
    const db = freshDb();
    insertEvent(db, { eventId: "evt-1", onlineMeetingUrl: JOIN_URL });
    insertTranscript(db, {
      eventId: "evt-1",
      transcriptId: "__no-transcript-found__",
      status: "not-available",
    });

    const result = repairTranscriptLinkage(db);

    expect(result.markersCleared).toBe(1);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM transcripts").get() as {
      n: number;
    };
    expect(remaining.n).toBe(0);
  });

  it("leaves genuine transcript rows alone", () => {
    const db = freshDb();
    insertEvent(db, { eventId: "evt-1", onlineMeetingUrl: JOIN_URL });
    insertTranscript(db, {
      eventId: "evt-1",
      transcriptId: "real-transcript-id",
      status: "ok",
    });

    const result = repairTranscriptLinkage(db);

    expect(result.markersCleared).toBe(0);
    const rows = db
      .prepare("SELECT transcript_id FROM transcripts")
      .all() as { transcript_id: string }[];
    expect(rows.map((r) => r.transcript_id)).toEqual(["real-transcript-id"]);
  });

  it("backfills chat_id from the joinUrl for events that have none", () => {
    const db = freshDb();
    insertEvent(db, { eventId: "evt-1", onlineMeetingUrl: JOIN_URL, chatId: null });

    const result = repairTranscriptLinkage(db);

    expect(result.chatIdsBackfilled).toBe(1);
    const row = db
      .prepare("SELECT chat_id FROM events WHERE event_id = 'evt-1'")
      .get() as { chat_id: string };
    expect(row.chat_id).toBe(JOIN_URL_THREAD_ID);
  });

  it("does not overwrite an existing chat_id", () => {
    const db = freshDb();
    insertEvent(db, {
      eventId: "evt-1",
      onlineMeetingUrl: JOIN_URL,
      chatId: "19:already-there@thread.v2",
    });

    const result = repairTranscriptLinkage(db);

    expect(result.chatIdsBackfilled).toBe(0);
    const row = db
      .prepare("SELECT chat_id FROM events WHERE event_id = 'evt-1'")
      .get() as { chat_id: string };
    expect(row.chat_id).toBe("19:already-there@thread.v2");
  });

  it("counts events whose joinUrl yields no chat id as skipped", () => {
    const db = freshDb();
    insertEvent(db, {
      eventId: "evt-odd",
      onlineMeetingUrl: "https://teams.microsoft.com/l/broadcast/xyz",
      chatId: null,
    });

    const result = repairTranscriptLinkage(db);

    expect(result.chatIdsBackfilled).toBe(0);
    expect(result.chatIdsSkipped).toBe(1);
    const row = db
      .prepare("SELECT chat_id FROM events WHERE event_id = 'evt-odd'")
      .get() as { chat_id: string | null };
    expect(row.chat_id).toBeNull();
  });

  it("removes transcript rows belonging to cancelled meetings", () => {
    // Pre-fix, syncTranscripts had no isCancelled guard, so cancelled
    // occurrences got the recurring series' transcripts attached.
    const db = freshDb();
    insertEvent(db, { eventId: "evt-cancelled", onlineMeetingUrl: JOIN_URL });
    db.prepare("UPDATE events SET is_cancelled = 1 WHERE event_id = 'evt-cancelled'").run();
    insertTranscript(db, {
      eventId: "evt-cancelled",
      transcriptId: "tr-series",
      status: "ok",
    });

    const result = repairTranscriptLinkage(db);

    expect(result.cancelledTranscriptsRemoved).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM transcripts").get() as { n: number }).n,
    ).toBe(0);
  });

  it("leaves transcripts for meetings that are not cancelled", () => {
    const db = freshDb();
    insertEvent(db, { eventId: "evt-live", onlineMeetingUrl: JOIN_URL });
    insertTranscript(db, {
      eventId: "evt-live",
      transcriptId: "tr-real",
      status: "ok",
    });

    const result = repairTranscriptLinkage(db);

    expect(result.cancelledTranscriptsRemoved).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM transcripts").get() as { n: number }).n,
    ).toBe(1);
  });

  it("dry-run reports counts without writing", () => {
    const db = freshDb();
    insertEvent(db, { eventId: "evt-1", onlineMeetingUrl: JOIN_URL, chatId: null });
    insertTranscript(db, {
      eventId: "evt-1",
      transcriptId: "__no-transcript-found__",
      status: "not-available",
    });

    db.prepare("UPDATE events SET is_cancelled = 1 WHERE event_id = 'evt-1'").run();
    insertTranscript(db, {
      eventId: "evt-1",
      transcriptId: "tr-series",
      status: "ok",
    });

    const result = repairTranscriptLinkage(db, { dryRun: true });

    expect(result.markersCleared).toBe(1);
    expect(result.chatIdsBackfilled).toBe(1);
    expect(result.cancelledTranscriptsRemoved).toBe(1);
    // ...but the lake is untouched.
    const transcripts = db
      .prepare("SELECT COUNT(*) AS n FROM transcripts")
      .get() as { n: number };
    expect(transcripts.n).toBe(2);
    const row = db
      .prepare("SELECT chat_id FROM events WHERE event_id = 'evt-1'")
      .get() as { chat_id: string | null };
    expect(row.chat_id).toBeNull();
  });
});
