import type { MessageStore } from "../../store/message-store.js";
import type { CalendarEvent } from "../../store/types.js";
import { InvalidParamsError } from "./get-recent-activity.js";

// Shared by get_event and get_event_transcript: both take an eventId plus
// an optional account, and both need the same "look it up directly, or
// search every signed-in account and require disambiguation on a
// collision" resolution — extracted here rather than duplicated.
export async function resolveEvent(
  store: MessageStore,
  eventId: string,
  account: string | undefined,
): Promise<CalendarEvent | null> {
  if (account !== undefined) {
    return store.getEventByKey({ account, eventId });
  }
  const accounts = await store.listAccounts();
  const matches: CalendarEvent[] = [];
  for (const acc of accounts) {
    const found = await store.getEventByKey({ account: acc.username, eventId });
    if (found !== null) matches.push(found);
  }
  if (matches.length > 1) {
    const accountList = matches.map((m) => m.account).join(", ");
    throw new InvalidParamsError(
      `event_id ${eventId} exists under multiple accounts (${accountList}) — pass account to disambiguate`,
    );
  }
  return matches[0] ?? null;
}
