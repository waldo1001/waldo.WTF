import type { Database } from "better-sqlite3";
import { chatIdFromJoinUrl } from "../sources/calendar.js";

// The sentinel the sync job writes for "checked, Graph had nothing".
// Duplicated from sync-transcripts.ts rather than imported: this module is
// a one-shot repair over historical rows, and it must keep deleting the
// value that was actually written to disk even if the sync job's sentinel
// ever changes.
const NO_TRANSCRIPT_FOUND_MARKER = "__no-transcript-found__";

export interface RepairTranscriptLinkageOptions {
  readonly dryRun?: boolean;
}

export interface RepairTranscriptLinkageResult {
  readonly markersCleared: number;
  readonly chatIdsBackfilled: number;
  readonly chatIdsSkipped: number;
}

/**
 * One-shot repair for the two artifacts of the conferenceId bug (see
 * docs/plans/done/transcripts-meeting-id-resolution.md):
 *
 * 1. Every `__no-transcript-found__` marker in the lake was written from a
 *    404 caused by calling the transcript API with the audio dial-in id.
 *    Those are false negatives, and `not-available` is never retried, so
 *    they would suppress a correct re-check forever. Delete them and let
 *    the next tick re-check with a properly resolved meeting id.
 * 2. `events.chat_id` is NULL wherever Graph omitted `onlineMeeting.chatInfo`
 *    (almost everywhere). It is derivable from the stored joinUrl.
 */
export function repairTranscriptLinkage(
  db: Database,
  opts: RepairTranscriptLinkageOptions = {},
): RepairTranscriptLinkageResult {
  const dryRun = opts.dryRun === true;

  const markerRows = db
    .prepare("SELECT COUNT(*) AS n FROM transcripts WHERE transcript_id = ?")
    .get(NO_TRANSCRIPT_FOUND_MARKER) as { n: number };
  const markersCleared = markerRows.n;

  const candidates = db
    .prepare(
      `SELECT account, event_id, online_meeting_url
       FROM events
       WHERE chat_id IS NULL AND online_meeting_url IS NOT NULL`,
    )
    .all() as {
    account: string;
    event_id: string;
    online_meeting_url: string;
  }[];

  const derivable: { account: string; eventId: string; chatId: string }[] = [];
  let chatIdsSkipped = 0;
  for (const row of candidates) {
    const chatId = chatIdFromJoinUrl(row.online_meeting_url);
    if (chatId === undefined) {
      chatIdsSkipped++;
      continue;
    }
    derivable.push({ account: row.account, eventId: row.event_id, chatId });
  }

  if (!dryRun) {
    const clearMarkers = db.prepare(
      "DELETE FROM transcripts WHERE transcript_id = ?",
    );
    const setChatId = db.prepare(
      "UPDATE events SET chat_id = ? WHERE account = ? AND event_id = ?",
    );
    db.transaction(() => {
      clearMarkers.run(NO_TRANSCRIPT_FOUND_MARKER);
      for (const d of derivable) {
        setChatId.run(d.chatId, d.account, d.eventId);
      }
    })();
  }

  return {
    markersCleared,
    chatIdsBackfilled: derivable.length,
    chatIdsSkipped,
  };
}
