import type { Account } from "../auth/types.js";
import type { Clock } from "../clock.js";
import type { Logger } from "../logger.js";
import type { MessageStore } from "../store/message-store.js";
import {
  DeltaTokenInvalidError,
  GraphRateLimitedError,
  type CalendarClient,
} from "../sources/calendar.js";

// Rolling window for a newly-enabled account's first sync — a year back
// so "when did we meet about X" history questions work, plus two months
// of runway. Subsequent ticks resume from the stored delta cursor; the
// window does not float on later ticks (see calendar-overview.md's
// cross-cutting decisions).
export const CALENDAR_WINDOW_BACK_DAYS = 365;
export const CALENDAR_WINDOW_FORWARD_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const CALENDAR_SOURCE = "calendar" as const;
const CALENDAR_FOLDER = "default" as const;

export interface SyncCalendarEventsDeps {
  readonly account: Account;
  readonly store: MessageStore;
  readonly calendar: CalendarClient;
  readonly clock: Clock;
  readonly logger?: Logger;
}

export interface SyncCalendarEventsResult {
  readonly added: number;
  readonly removed: number;
}

const isTransient5xx = (err: unknown): boolean =>
  err instanceof Error && /HTTP 5\d\d/.test(err.message);

export async function syncCalendarEvents(
  deps: SyncCalendarEventsDeps,
): Promise<SyncCalendarEventsResult> {
  const { account, store, calendar, clock, logger } = deps;

  const existing = await store.getSyncState(
    account.username,
    CALENDAR_SOURCE,
    CALENDAR_FOLDER,
  );

  let cursor = existing?.deltaToken;
  const now = clock.now();
  const windowStartIso = new Date(
    now.getTime() - CALENDAR_WINDOW_BACK_DAYS * DAY_MS,
  ).toISOString();
  const windowEndIso = new Date(
    now.getTime() + CALENDAR_WINDOW_FORWARD_DAYS * DAY_MS,
  ).toISOString();

  let added = 0;
  let removed = 0;

  for (;;) {
    let page;
    try {
      page = await calendar.listCalendarViewDelta({
        account: account.username,
        ...(cursor !== undefined
          ? { cursor }
          : { windowStartIso, windowEndIso }),
      });
    } catch (err) {
      if (err instanceof DeltaTokenInvalidError) {
        // Cursor expired server-side. Clear it so the next tick restarts
        // from the window rather than retrying a dead cursor forever.
        await store.setSyncState({
          account: account.username,
          source: CALENDAR_SOURCE,
          folder: CALENDAR_FOLDER,
          lastSyncAt: clock.now(),
        });
        logger?.info(
          `calendar_delta_cursor_reset account=${account.username}`,
        );
        return { added, removed };
      }
      if (err instanceof GraphRateLimitedError || isTransient5xx(err)) {
        // Cursor already reflects every page processed so far (persisted
        // below, page-by-page) — stop here, next tick resumes cleanly.
        await store.setSyncState({
          account: account.username,
          source: CALENDAR_SOURCE,
          folder: CALENDAR_FOLDER,
          ...(cursor !== undefined && { deltaToken: cursor }),
          lastSyncAt: clock.now(),
        });
        return { added, removed };
      }
      // TokenExpiredError here means HttpCalendarClient already tried its
      // own forceRefresh retry and failed twice — genuine auth failure,
      // surface it. Any other error also surfaces as-is.
      throw err;
    }

    if (page.events.length > 0) {
      await store.upsertEvents(page.events);
      added += page.events.length;
    }
    if (page.removedIds.length > 0) {
      await store.deleteEvents(
        page.removedIds.map((eventId) => ({
          account: account.username,
          eventId,
        })),
      );
      removed += page.removedIds.length;
    }

    const nextCursor = page.nextLink ?? page.deltaLink;
    await store.setSyncState({
      account: account.username,
      source: CALENDAR_SOURCE,
      folder: CALENDAR_FOLDER,
      ...(nextCursor !== undefined && { deltaToken: nextCursor }),
      lastSyncAt: clock.now(),
    });

    if (page.deltaLink !== undefined) {
      return { added, removed };
    }
    cursor = page.nextLink;
    /* c8 ignore next 3 -- defensive: a page with neither link would loop
       forever; FakeCalendarClient/HttpCalendarClient always supply one. */
    if (cursor === undefined) {
      return { added, removed };
    }
  }
}
