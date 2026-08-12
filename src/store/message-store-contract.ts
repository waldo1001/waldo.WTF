import { describe, expect, it } from "vitest";
import type {
  GetRecentMessagesOptions,
  MessageStore,
} from "./message-store.js";
import type {
  AccountRecord,
  CalendarEvent,
  EventAttendee,
  Message,
  SearchHit,
  SyncLogEntry,
  SyncStateEntry,
  Transcript,
  TranscriptSearchHit,
  TranscriptSegment,
} from "./types.js";

async function recentIds(
  store: MessageStore,
  opts: GetRecentMessagesOptions,
): Promise<string[]> {
  const { messages } = await store.getRecentMessages(opts);
  return messages.map((m) => m.id);
}

async function recent(
  store: MessageStore,
  opts: GetRecentMessagesOptions,
): Promise<readonly Message[]> {
  const { messages } = await store.getRecentMessages(opts);
  return messages;
}

async function search(
  store: MessageStore,
  query: string,
  limit: number,
): Promise<readonly SearchHit[]> {
  const { hits } = await store.searchMessages(query, limit);
  return hits;
}

async function searchTranscripts(
  store: MessageStore,
  query: string,
  limit: number,
): Promise<readonly TranscriptSearchHit[]> {
  const { hits } = await store.searchTranscriptSegments(query, limit);
  return hits;
}

function msg(overrides: Partial<Message> & Pick<Message, "id">): Message {
  return {
    source: "outlook",
    account: "a@example.test",
    nativeId: `native-${overrides.id}`,
    sentAt: new Date("2026-04-13T10:00:00Z"),
    importedAt: new Date("2026-04-13T10:05:00Z"),
    ...overrides,
  };
}

function calendarEvent(
  overrides: Partial<CalendarEvent> & Pick<CalendarEvent, "eventId">,
): CalendarEvent {
  return {
    account: "a@example.test",
    startAt: new Date("2026-04-13T10:00:00Z"),
    endAt: new Date("2026-04-13T11:00:00Z"),
    isAllDay: false,
    isCancelled: false,
    attendees: [],
    ...overrides,
  };
}

function attendee(
  overrides: Partial<EventAttendee> & Pick<EventAttendee, "email">,
): EventAttendee {
  return {
    responseStatus: "none",
    ...overrides,
  };
}

function transcript(
  overrides: Partial<Transcript> &
    Pick<Transcript, "eventId" | "transcriptId">,
): Transcript {
  return {
    account: "a@example.test",
    fetchedAt: new Date("2026-04-13T12:00:00Z"),
    segmentCount: 0,
    status: "ok",
    ...overrides,
  };
}

function segment(
  overrides: Partial<TranscriptSegment> &
    Pick<TranscriptSegment, "eventId" | "transcriptId" | "sequence" | "text">,
): TranscriptSegment {
  return {
    account: "a@example.test",
    startOffsetMs: 0,
    endOffsetMs: 1000,
    ...overrides,
  };
}

export interface MessageStoreTestHarness {
  readonly store: MessageStore;
  readSyncLog(): readonly SyncLogEntry[];
}

export type MessageStoreFactory = () =>
  | MessageStoreTestHarness
  | Promise<MessageStoreTestHarness>;

export function runMessageStoreContract(
  label: string,
  factory: MessageStoreFactory,
): void {
  describe(`MessageStore contract (${label})`, () => {
    it("upsertMessages on an empty store adds all rows", async () => {
      const { store } = await factory();
      const result = await store.upsertMessages([
        msg({ id: "1" }),
        msg({ id: "2" }),
        msg({ id: "3" }),
      ]);
      expect(result).toEqual({ added: 3, updated: 0 });
    });

    it("upsertMessages updates an existing id in place", async () => {
      const { store } = await factory();
      await store.upsertMessages([msg({ id: "1", body: "first" })]);
      const result = await store.upsertMessages([
        msg({ id: "1", body: "second" }),
      ]);
      expect(result).toEqual({ added: 0, updated: 1 });
    });

    it("upsertMessages reports mixed added/updated counts", async () => {
      const { store } = await factory();
      await store.upsertMessages([msg({ id: "1" }), msg({ id: "2" })]);
      const result = await store.upsertMessages([
        msg({ id: "2" }),
        msg({ id: "3" }),
        msg({ id: "4" }),
      ]);
      expect(result).toEqual({ added: 2, updated: 1 });
    });

    it("upsertMessages with empty array is a no-op", async () => {
      const { store } = await factory();
      const result = await store.upsertMessages([]);
      expect(result).toEqual({ added: 0, updated: 0 });
    });

    it("deleteMessages removes listed ids and returns actual deleted count", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1" }),
        msg({ id: "2" }),
        msg({ id: "3" }),
      ]);
      const result = await store.deleteMessages(["1", "3", "missing"]);
      expect(result).toEqual({ deleted: 2 });
      const reAdd = await store.upsertMessages([msg({ id: "1" })]);
      expect(reAdd).toEqual({ added: 1, updated: 0 });
    });

    it("deleteMessages with empty array is a no-op", async () => {
      const { store } = await factory();
      const result = await store.deleteMessages([]);
      expect(result).toEqual({ deleted: 0 });
    });

    it("getSyncState returns null when no entry exists", async () => {
      const { store } = await factory();
      expect(await store.getSyncState("a@example.test", "outlook")).toBeNull();
    });

    it("setSyncState then getSyncState round-trips the entry", async () => {
      const { store } = await factory();
      const entry: SyncStateEntry = {
        account: "a@example.test",
        source: "outlook",
        deltaToken: "delta-abc",
        lastSyncAt: new Date("2026-04-13T09:00:00Z"),
      };
      await store.setSyncState(entry);
      expect(await store.getSyncState("a@example.test", "outlook")).toEqual(
        entry,
      );
    });

    it("setSyncState overwrites an existing entry for the same key", async () => {
      const { store } = await factory();
      await store.setSyncState({
        account: "a@example.test",
        source: "outlook",
        deltaToken: "first",
      });
      await store.setSyncState({
        account: "a@example.test",
        source: "outlook",
        deltaToken: "second",
      });
      const got = await store.getSyncState("a@example.test", "outlook");
      expect(got?.deltaToken).toBe("second");
    });

    it("sync state is isolated by folder for the same (account, source)", async () => {
      const { store } = await factory();
      await store.setSyncState({
        account: "a@example.test",
        source: "outlook",
        folder: "",
        deltaToken: "inbox-cursor",
      });
      await store.setSyncState({
        account: "a@example.test",
        source: "outlook",
        folder: "sentitems",
        deltaToken: "sent-cursor",
      });
      const inbox = await store.getSyncState("a@example.test", "outlook");
      const sent = await store.getSyncState(
        "a@example.test",
        "outlook",
        "sentitems",
      );
      expect(inbox?.deltaToken).toBe("inbox-cursor");
      expect(sent?.deltaToken).toBe("sent-cursor");
    });

    it("upsertMessages round-trips fromMe=true", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "sent-1",
          threadId: "t1",
          fromMe: true,
        }),
      ]);
      const { messages } = await store.getRecentMessages({
        since: new Date("2026-04-13T00:00:00Z"),
        limit: 10,
      });
      const sent = messages.find((m) => m.id === "sent-1");
      expect(sent?.fromMe).toBe(true);
    });

    it("upsertMessages with fromMe absent is treated as not-from-me", async () => {
      const { store } = await factory();
      await store.upsertMessages([msg({ id: "inbox-1", threadId: "t1" })]);
      const { messages } = await store.getRecentMessages({
        since: new Date("2026-04-13T00:00:00Z"),
        limit: 10,
      });
      const inbox = messages.find((m) => m.id === "inbox-1");
      expect(inbox?.fromMe === true).toBe(false);
    });

    it("sync state is isolated by (account, source) pair", async () => {
      const { store } = await factory();
      await store.setSyncState({
        account: "a@example.test",
        source: "outlook",
        deltaToken: "A-out",
      });
      await store.setSyncState({
        account: "a@example.test",
        source: "teams",
        deltaToken: "A-teams",
      });
      await store.setSyncState({
        account: "b@example.test",
        source: "outlook",
        deltaToken: "B-out",
      });
      expect(
        (await store.getSyncState("a@example.test", "outlook"))?.deltaToken,
      ).toBe("A-out");
      expect(
        (await store.getSyncState("a@example.test", "teams"))?.deltaToken,
      ).toBe("A-teams");
      expect(
        (await store.getSyncState("b@example.test", "outlook"))?.deltaToken,
      ).toBe("B-out");
    });

    it("appendSyncLog round-trips an ok entry with messagesAdded", async () => {
      const harness = await factory();
      const entry: SyncLogEntry = {
        ts: new Date("2026-04-13T10:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 5,
      };
      await harness.store.appendSyncLog(entry);
      const rows = harness.readSyncLog();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(entry);
      expect(rows[0]?.errorMessage).toBeUndefined();
    });

    it("appendSyncLog round-trips an error entry with errorMessage", async () => {
      const harness = await factory();
      const entry: SyncLogEntry = {
        ts: new Date("2026-04-13T10:05:00Z"),
        account: "a@example.test",
        source: "teams",
        status: "error",
        errorMessage: "graph 429",
      };
      await harness.store.appendSyncLog(entry);
      const rows = harness.readSyncLog();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(entry);
      expect(rows[0]?.messagesAdded).toBeUndefined();
    });

    it("appendSyncLog accepts the transcripts source (sync-log-only, never a Message source)", async () => {
      const harness = await factory();
      const entry: SyncLogEntry = {
        ts: new Date("2026-04-13T10:10:00Z"),
        account: "a@example.test",
        source: "transcripts",
        status: "ok",
        messagesAdded: 3,
      };
      await harness.store.appendSyncLog(entry);
      const rows = harness.readSyncLog();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(entry);
    });

    it("upsertAccount inserts a new account visible to listAccounts", async () => {
      const { store } = await factory();
      const account: AccountRecord = {
        username: "a@example.test",
        displayName: "Eric",
        tenantId: "tenant-1",
        addedAt: new Date("2026-04-13T08:00:00Z"),
      };
      await store.upsertAccount(account);
      expect(await store.listAccounts()).toEqual([account]);
    });

    it("upsertAccount updates an existing username in place", async () => {
      const { store } = await factory();
      await store.upsertAccount({
        username: "a@example.test",
        displayName: "Old",
        addedAt: new Date("2026-04-13T08:00:00Z"),
      });
      await store.upsertAccount({
        username: "a@example.test",
        displayName: "New",
        tenantId: "tenant-2",
        addedAt: new Date("2026-04-13T08:00:00Z"),
      });
      const rows = await store.listAccounts();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.displayName).toBe("New");
      expect(rows[0]?.tenantId).toBe("tenant-2");
    });

    it("listAccounts returns rows ordered by addedAt ASC, tie-break by username", async () => {
      const { store } = await factory();
      await store.upsertAccount({
        username: "b@example.test",
        addedAt: new Date("2026-04-13T09:00:00Z"),
      });
      await store.upsertAccount({
        username: "a@example.test",
        addedAt: new Date("2026-04-13T08:00:00Z"),
      });
      await store.upsertAccount({
        username: "c@example.test",
        addedAt: new Date("2026-04-13T08:00:00Z"),
      });
      const rows = await store.listAccounts();
      expect(rows.map((r) => r.username)).toEqual([
        "a@example.test",
        "c@example.test",
        "b@example.test",
      ]);
    });

    it("listAccounts on an empty store returns []", async () => {
      const { store } = await factory();
      expect(await store.listAccounts()).toEqual([]);
    });

    it("searchMessages returns empty hits on an empty store", async () => {
      const { store } = await factory();
      const res = await store.searchMessages("anything", 10);
      expect(res.hits).toEqual([]);
      expect(res.mutedCount).toBe(0);
    });

    it("searchMessages finds a message by a body term", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", body: "lorem ipsum dolor" }),
        msg({ id: "2", body: "completely unrelated text" }),
      ]);
      const hits = await search(store, "ipsum", 10);
      expect(hits.map((h) => h.message.id)).toEqual(["1"]);
    });

    it("searchMessages finds a message by a threadName term", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", threadName: "Project Falcon", body: "hello" }),
      ]);
      const hits = await search(store, "Falcon", 10);
      expect(hits.map((h) => h.message.id)).toEqual(["1"]);
    });

    it("searchMessages finds a message by a senderName term", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", senderName: "Alice Example", body: "hello" }),
      ]);
      const hits = await search(store, "Example", 10);
      expect(hits.map((h) => h.message.id)).toEqual(["1"]);
    });

    it("searchMessages respects the limit argument", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", body: "kangaroo" }),
        msg({ id: "2", body: "kangaroo" }),
        msg({ id: "3", body: "kangaroo" }),
        msg({ id: "4", body: "kangaroo" }),
        msg({ id: "5", body: "kangaroo" }),
      ]);
      const hits = await search(store, "kangaroo", 2);
      expect(hits).toHaveLength(2);
    });

    it("searchMessages returns empty hits for an empty query", async () => {
      const { store } = await factory();
      await store.upsertMessages([msg({ id: "1", body: "lorem ipsum" })]);
      expect((await store.searchMessages("", 10)).hits).toEqual([]);
      expect((await store.searchMessages("   ", 10)).hits).toEqual([]);
    });

    it("searchMessages filters by senderEmail case-insensitively, ignoring body-only matches", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "from-gunter",
          senderEmail: "gunter@example.test",
          senderName: "Gunter Peeters",
          body: "project update",
        }),
        msg({
          id: "from-gunter-mixed",
          senderEmail: "Gunter@Example.TEST",
          body: "another",
        }),
        msg({
          id: "body-mentions",
          senderEmail: "bot@devops.example",
          body: "branch owned by gunter@example.test merged",
        }),
      ]);
      const { hits } = await store.searchMessages("", 10, {
        senderEmail: "gunter@example.test",
      });
      const ids = hits.map((h) => h.message.id).sort();
      expect(ids).toEqual(["from-gunter", "from-gunter-mixed"]);
    });

    it("searchMessages senderName does a case-insensitive substring match", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "lastname-first", senderName: "Peeters, Gunter", body: "one" }),
        msg({ id: "firstname-first", senderName: "Gunter Peeters", body: "two" }),
        msg({ id: "unrelated", senderName: "Gunther Muller", body: "three" }),
      ]);
      const { hits } = await store.searchMessages("", 10, {
        senderName: "peeters",
      });
      const ids = hits.map((h) => h.message.id).sort();
      expect(ids).toEqual(["firstname-first", "lastname-first"]);
    });

    it("searchMessages composes FTS query and senderEmail via AND", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "lunch-from-gunter",
          senderEmail: "gunter@example.test",
          body: "lunch tomorrow",
        }),
        msg({
          id: "deploy-from-gunter",
          senderEmail: "gunter@example.test",
          body: "deploy done",
        }),
        msg({
          id: "lunch-from-other",
          senderEmail: "someone@x.test",
          body: "lunch plans",
        }),
      ]);
      const { hits } = await store.searchMessages("lunch", 10, {
        senderEmail: "gunter@example.test",
      });
      expect(hits.map((h) => h.message.id)).toEqual(["lunch-from-gunter"]);
    });

    it("searchMessages after is inclusive and before is exclusive", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "too-early",
          senderEmail: "p@x.test",
          sentAt: new Date("2026-03-31T23:59:59Z"),
        }),
        msg({
          id: "at-after",
          senderEmail: "p@x.test",
          sentAt: new Date("2026-04-01T00:00:00Z"),
        }),
        msg({
          id: "mid",
          senderEmail: "p@x.test",
          sentAt: new Date("2026-04-10T12:00:00Z"),
        }),
        msg({
          id: "at-before",
          senderEmail: "p@x.test",
          sentAt: new Date("2026-04-15T00:00:00Z"),
        }),
      ]);
      const { hits } = await store.searchMessages("", 10, {
        senderEmail: "p@x.test",
        after: new Date("2026-04-01T00:00:00Z"),
        before: new Date("2026-04-15T00:00:00Z"),
      });
      const ids = hits.map((h) => h.message.id).sort();
      expect(ids).toEqual(["at-after", "mid"]);
    });

    it("searchMessages orders by sent_at DESC when the FTS query is empty", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "oldest",
          senderEmail: "p@x.test",
          sentAt: new Date("2026-04-01T00:00:00Z"),
        }),
        msg({
          id: "newest",
          senderEmail: "p@x.test",
          sentAt: new Date("2026-04-10T00:00:00Z"),
        }),
        msg({
          id: "middle",
          senderEmail: "p@x.test",
          sentAt: new Date("2026-04-05T00:00:00Z"),
        }),
      ]);
      const { hits } = await store.searchMessages("", 10, {
        senderEmail: "p@x.test",
      });
      expect(hits.map((h) => h.message.id)).toEqual([
        "newest",
        "middle",
        "oldest",
      ]);
    });

    it("searchTranscriptSegments returns empty hits on an empty store", async () => {
      const { store } = await factory();
      const res = await store.searchTranscriptSegments("anything", 10);
      expect(res.hits).toEqual([]);
    });

    it("searchTranscriptSegments finds a segment by a text term", async () => {
      const { store } = await factory();
      await store.upsertEvents([calendarEvent({ eventId: "evt-1" })]);
      await store.upsertTranscript({
        transcript: transcript({ eventId: "evt-1", transcriptId: "tr-1" }),
        segments: [
          segment({
            eventId: "evt-1",
            transcriptId: "tr-1",
            sequence: 0,
            text: "let's discuss the budget review",
          }),
          segment({
            eventId: "evt-1",
            transcriptId: "tr-1",
            sequence: 1,
            text: "completely unrelated content",
          }),
        ],
      });
      const hits = await searchTranscripts(store, "budget", 10);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.segment.sequence).toBe(0);
      expect(hits[0]?.segment.eventId).toBe("evt-1");
      expect(hits[0]?.segment.transcriptId).toBe("tr-1");
    });

    it("searchTranscriptSegments respects the limit argument", async () => {
      const { store } = await factory();
      await store.upsertEvents([calendarEvent({ eventId: "evt-1" })]);
      await store.upsertTranscript({
        transcript: transcript({ eventId: "evt-1", transcriptId: "tr-1" }),
        segments: [0, 1, 2, 3, 4].map((n) =>
          segment({
            eventId: "evt-1",
            transcriptId: "tr-1",
            sequence: n,
            text: "kangaroo",
          }),
        ),
      });
      const hits = await searchTranscripts(store, "kangaroo", 2);
      expect(hits).toHaveLength(2);
    });

    it("searchTranscriptSegments returns empty hits for an empty query", async () => {
      const { store } = await factory();
      await store.upsertEvents([calendarEvent({ eventId: "evt-1" })]);
      await store.upsertTranscript({
        transcript: transcript({ eventId: "evt-1", transcriptId: "tr-1" }),
        segments: [
          segment({ eventId: "evt-1", transcriptId: "tr-1", sequence: 0, text: "lorem ipsum" }),
        ],
      });
      expect((await store.searchTranscriptSegments("", 10)).hits).toEqual([]);
      expect((await store.searchTranscriptSegments("   ", 10)).hits).toEqual([]);
    });

    it("searchTranscriptSegments finds segments across different events and transcripts", async () => {
      const { store } = await factory();
      await store.upsertEvents([
        calendarEvent({ eventId: "evt-1" }),
        calendarEvent({ eventId: "evt-2" }),
      ]);
      await store.upsertTranscript({
        transcript: transcript({ eventId: "evt-1", transcriptId: "tr-1" }),
        segments: [
          segment({ eventId: "evt-1", transcriptId: "tr-1", sequence: 0, text: "spaceship launch" }),
        ],
      });
      await store.upsertTranscript({
        transcript: transcript({ eventId: "evt-2", transcriptId: "tr-2" }),
        segments: [
          segment({ eventId: "evt-2", transcriptId: "tr-2", sequence: 0, text: "spaceship reentry" }),
        ],
      });
      const hits = await searchTranscripts(store, "spaceship", 10);
      const eventIds = hits.map((h) => h.segment.eventId).sort();
      expect(eventIds).toEqual(["evt-1", "evt-2"]);
    });

    it("getRecentMessages returns empty on an empty store", async () => {
      const { store } = await factory();
      const got = await store.getRecentMessages({
        since: new Date("2026-04-13T00:00:00Z"),
        limit: 50,
      });
      expect(got.messages).toEqual([]);
      expect(got.mutedCount).toBe(0);
    });

    it("getRecentMessages filters out messages older than since", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "old", sentAt: new Date("2026-04-10T12:00:00Z") }),
        msg({ id: "edge", sentAt: new Date("2026-04-13T00:00:00Z") }),
        msg({ id: "new", sentAt: new Date("2026-04-13T09:00:00Z") }),
      ]);
      const ids = await recentIds(store, {
        since: new Date("2026-04-13T00:00:00Z"),
        limit: 50,
      });
      expect(ids.sort()).toEqual(["edge", "new"]);
    });

    it("getRecentMessages orders by sentAt DESC with id DESC tiebreak", async () => {
      const { store } = await factory();
      const ts = new Date("2026-04-13T10:00:00Z");
      await store.upsertMessages([
        msg({ id: "a", sentAt: ts }),
        msg({ id: "b", sentAt: ts }),
        msg({ id: "c", sentAt: new Date("2026-04-13T11:00:00Z") }),
      ]);
      const ids = await recentIds(store, {
        since: new Date("2026-04-13T00:00:00Z"),
        limit: 50,
      });
      expect(ids).toEqual(["c", "b", "a"]);
    });

    it("getRecentMessages filters by sources", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", source: "outlook" }),
        msg({ id: "2", source: "teams" }),
        msg({ id: "3", source: "whatsapp" }),
      ]);
      const ids = await recentIds(store, {
        since: new Date("2026-04-01T00:00:00Z"),
        sources: ["teams", "whatsapp"],
        limit: 50,
      });
      expect(ids.sort()).toEqual(["2", "3"]);
    });

    it("getRecentMessages filters by accounts", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", account: "a@example.test" }),
        msg({ id: "2", account: "b@example.test" }),
        msg({ id: "3", account: "c@example.test" }),
      ]);
      const ids = await recentIds(store, {
        since: new Date("2026-04-01T00:00:00Z"),
        accounts: ["a@example.test", "c@example.test"],
        limit: 50,
      });
      expect(ids.sort()).toEqual(["1", "3"]);
    });

    it("getRecentMessages applies sources and accounts together", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", source: "outlook", account: "a@example.test" }),
        msg({ id: "2", source: "teams", account: "a@example.test" }),
        msg({ id: "3", source: "outlook", account: "b@example.test" }),
      ]);
      const ids = await recentIds(store, {
        since: new Date("2026-04-01T00:00:00Z"),
        sources: ["outlook"],
        accounts: ["a@example.test"],
        limit: 50,
      });
      expect(ids).toEqual(["1"]);
    });

    it("getSyncStatus on an empty store returns []", async () => {
      const { store } = await factory();
      expect(
        await store.getSyncStatus(new Date("2026-04-13T12:00:00Z")),
      ).toEqual([]);
    });

    it("getSyncStatus returns one row per (account, source) seen in sync_state", async () => {
      const { store } = await factory();
      await store.setSyncState({
        account: "a@example.test",
        source: "outlook",
        deltaToken: "tok",
        lastSyncAt: new Date("2026-04-13T11:55:00Z"),
      });
      const rows = await store.getSyncStatus(new Date("2026-04-13T12:00:00Z"));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.account).toBe("a@example.test");
      expect(rows[0]?.source).toBe("outlook");
      expect(rows[0]?.lastSyncAt).toEqual(new Date("2026-04-13T11:55:00Z"));
      expect(rows[0]?.lastStatus).toBeUndefined();
      expect(rows[0]?.lastOkAt).toBeUndefined();
      expect(rows[0]?.messagesAddedLast24h).toBe(0);
    });

    it("getSyncStatus includes a row for a pair with only sync_log entries", async () => {
      const { store } = await factory();
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "teams",
        status: "ok",
        messagesAdded: 3,
      });
      const rows = await store.getSyncStatus(new Date("2026-04-13T12:00:00Z"));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe("teams");
      expect(rows[0]?.lastStatus).toBe("ok");
      expect(rows[0]?.lastSyncAt).toBeUndefined();
    });

    it("getSyncStatus.lastStatus reflects the most recent sync_log row (error after ok)", async () => {
      const { store } = await factory();
      await store.appendSyncLog({
        ts: new Date("2026-04-13T10:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 7,
      });
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "error",
        errorMessage: "graph 429",
      });
      const rows = await store.getSyncStatus(new Date("2026-04-13T12:00:00Z"));
      expect(rows[0]?.lastStatus).toBe("error");
      expect(rows[0]?.lastError).toBe("graph 429");
      expect(rows[0]?.lastOkAt).toEqual(new Date("2026-04-13T10:00:00Z"));
      expect(rows[0]?.messagesAddedLastOk).toBe(7);
    });

    it("getSyncStatus.lastStatus reflects the most recent sync_log row (ok after error)", async () => {
      const { store } = await factory();
      await store.appendSyncLog({
        ts: new Date("2026-04-13T10:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "error",
        errorMessage: "transient",
      });
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 4,
      });
      const rows = await store.getSyncStatus(new Date("2026-04-13T12:00:00Z"));
      expect(rows[0]?.lastStatus).toBe("ok");
      expect(rows[0]?.lastError).toBeUndefined();
      expect(rows[0]?.lastOkAt).toEqual(new Date("2026-04-13T11:00:00Z"));
      expect(rows[0]?.messagesAddedLastOk).toBe(4);
    });

    it("getSyncStatus.messagesAddedLast24h sums ok rows within 24h of now", async () => {
      const { store } = await factory();
      const now = new Date("2026-04-13T12:00:00Z");
      // Outside window (25h old) — excluded
      await store.appendSyncLog({
        ts: new Date("2026-04-12T11:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 1000,
      });
      // Inside window (23h old)
      await store.appendSyncLog({
        ts: new Date("2026-04-12T13:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 5,
      });
      // Inside window, but error — excluded from sum
      await store.appendSyncLog({
        ts: new Date("2026-04-13T09:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "error",
        errorMessage: "x",
      });
      // Inside window
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 8,
      });
      const rows = await store.getSyncStatus(now);
      expect(rows[0]?.messagesAddedLast24h).toBe(13);
    });

    it("getSyncStatus rows are ordered by account ASC, source ASC", async () => {
      const { store } = await factory();
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "b@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 1,
      });
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "teams",
        status: "ok",
        messagesAdded: 1,
      });
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 1,
      });
      const rows = await store.getSyncStatus(new Date("2026-04-13T12:00:00Z"));
      expect(rows.map((r) => `${r.account}/${r.source}`)).toEqual([
        "a@example.test/outlook",
        "a@example.test/teams",
        "b@example.test/outlook",
      ]);
    });

    it("getSyncStatus unions sync_state and sync_log rows for the same pair", async () => {
      const { store } = await factory();
      await store.setSyncState({
        account: "a@example.test",
        source: "outlook",
        deltaToken: "t",
        lastSyncAt: new Date("2026-04-13T11:55:00Z"),
      });
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 2,
      });
      const rows = await store.getSyncStatus(new Date("2026-04-13T12:00:00Z"));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.lastSyncAt).toEqual(new Date("2026-04-13T11:55:00Z"));
      expect(rows[0]?.lastOkAt).toEqual(new Date("2026-04-13T11:00:00Z"));
      expect(rows[0]?.lastStatus).toBe("ok");
      expect(rows[0]?.messagesAddedLastOk).toBe(2);
    });

    it("upsertMessages round-trips Teams-specific fields (chatType/replyToId/mentions)", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "t1",
          source: "teams",
          chatType: "channel",
          replyToId: "root-msg-1",
          mentions: ["alice@example.test", "bob@example.test"],
          sentAt: new Date("2026-04-13T10:00:00Z"),
          body: "hi",
        }),
      ]);
      const got = await recent(store, {
        since: new Date("2026-04-01T00:00:00Z"),
        limit: 10,
      });
      expect(got).toHaveLength(1);
      const m = got[0]!;
      expect(m.source).toBe("teams");
      expect(m.chatType).toBe("channel");
      expect(m.replyToId).toBe("root-msg-1");
      expect(m.mentions).toEqual(["alice@example.test", "bob@example.test"]);
    });

    it("upsertMessages leaves Teams fields undefined when omitted", async () => {
      const { store } = await factory();
      await store.upsertMessages([msg({ id: "plain", body: "plain" })]);
      const got = await recent(store, {
        since: new Date("2026-04-01T00:00:00Z"),
        limit: 10,
      });
      const m = got[0]!;
      expect(m.chatType).toBeUndefined();
      expect(m.replyToId).toBeUndefined();
      expect(m.mentions).toBeUndefined();
    });

    it("upsertMessages preserves an empty mentions array distinct from undefined", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "empty-mentions", source: "teams", mentions: [] }),
      ]);
      const got = await recent(store, {
        since: new Date("2026-04-01T00:00:00Z"),
        limit: 10,
      });
      expect(got[0]?.mentions).toEqual([]);
    });

    it("getChatCursor returns undefined when no cursor is set", async () => {
      const { store } = await factory();
      expect(
        await store.getChatCursor("a@example.test", "chat-1"),
      ).toBeUndefined();
    });

    it("setChatCursor then getChatCursor round-trips the ISO value", async () => {
      const { store } = await factory();
      await store.setChatCursor({
        account: "a@example.test",
        chatId: "chat-1",
        cursor: "2026-04-13T10:00:00.000Z",
      });
      expect(await store.getChatCursor("a@example.test", "chat-1")).toBe(
        "2026-04-13T10:00:00.000Z",
      );
    });

    it("setChatCursor overwrites an existing cursor for the same (account, chatId)", async () => {
      const { store } = await factory();
      await store.setChatCursor({
        account: "a@example.test",
        chatId: "chat-1",
        cursor: "2026-04-13T10:00:00.000Z",
      });
      await store.setChatCursor({
        account: "a@example.test",
        chatId: "chat-1",
        cursor: "2026-04-13T11:00:00.000Z",
      });
      expect(await store.getChatCursor("a@example.test", "chat-1")).toBe(
        "2026-04-13T11:00:00.000Z",
      );
    });

    it("listChatCursors returns [] when the account has no cursors", async () => {
      const { store } = await factory();
      expect(await store.listChatCursors("a@example.test")).toEqual([]);
    });

    it("listChatCursors returns all cursors for the given account", async () => {
      const { store } = await factory();
      await store.setChatCursor({
        account: "a@example.test",
        chatId: "chat-1",
        cursor: "2026-04-13T10:00:00.000Z",
      });
      await store.setChatCursor({
        account: "a@example.test",
        chatId: "chat-2",
        cursor: "2026-04-13T11:00:00.000Z",
      });
      const rows = await store.listChatCursors("a@example.test");
      const map = new Map(rows.map((r) => [r.chatId, r.cursor]));
      expect(map.get("chat-1")).toBe("2026-04-13T10:00:00.000Z");
      expect(map.get("chat-2")).toBe("2026-04-13T11:00:00.000Z");
      expect(rows).toHaveLength(2);
    });

    it("chat cursors are isolated by account", async () => {
      const { store } = await factory();
      await store.setChatCursor({
        account: "a@example.test",
        chatId: "chat-1",
        cursor: "2026-04-13T10:00:00.000Z",
      });
      await store.setChatCursor({
        account: "b@example.test",
        chatId: "chat-1",
        cursor: "2026-04-13T11:00:00.000Z",
      });
      expect(await store.getChatCursor("a@example.test", "chat-1")).toBe(
        "2026-04-13T10:00:00.000Z",
      );
      expect(await store.getChatCursor("b@example.test", "chat-1")).toBe(
        "2026-04-13T11:00:00.000Z",
      );
      expect(await store.listChatCursors("a@example.test")).toHaveLength(1);
      expect(await store.listChatCursors("b@example.test")).toHaveLength(1);
    });

    it("getThread returns [] for an unknown thread id", async () => {
      const { store } = await factory();
      expect(await store.getThread({ threadId: "nope" })).toEqual([]);
    });

    it("getThread resolves a Teams chat by thread_id, ordered sent_at ASC", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "teams:a@example.test:3",
          source: "teams",
          threadId: "chat-1",
          sentAt: new Date("2026-04-13T12:00:00Z"),
          body: "third",
        }),
        msg({
          id: "teams:a@example.test:1",
          source: "teams",
          threadId: "chat-1",
          sentAt: new Date("2026-04-13T10:00:00Z"),
          body: "first",
        }),
        msg({
          id: "teams:a@example.test:2",
          source: "teams",
          threadId: "chat-1",
          sentAt: new Date("2026-04-13T11:00:00Z"),
          body: "second",
        }),
        msg({
          id: "teams:a@example.test:other",
          source: "teams",
          threadId: "chat-2",
          body: "unrelated",
        }),
      ]);
      const rows = await store.getThread({ threadId: "chat-1" });
      expect(rows.map((m) => m.body)).toEqual(["first", "second", "third"]);
    });

    it("getThread by default returns the latest N messages of a long thread, ordered chronologically within the slice", async () => {
      const { store } = await factory();
      const seeded: Message[] = [];
      for (let i = 0; i < 10; i++) {
        seeded.push(
          msg({
            id: `teams:a@example.test:${i.toString().padStart(2, "0")}`,
            source: "teams",
            threadId: "chat-big",
            sentAt: new Date(
              Date.UTC(2026, 3, 13, 10, i, 0),
            ),
            body: `m${i}`,
          }),
        );
      }
      await store.upsertMessages(seeded);
      const rows = await store.getThread({ threadId: "chat-big", limit: 3 });
      expect(rows.map((m) => m.body)).toEqual(["m7", "m8", "m9"]);
    });

    it("getThread with fromStart: true returns the FIRST N messages of a long thread (regression)", async () => {
      const { store } = await factory();
      const seeded: Message[] = [];
      for (let i = 0; i < 10; i++) {
        seeded.push(
          msg({
            id: `teams:a@example.test:${i.toString().padStart(2, "0")}`,
            source: "teams",
            threadId: "chat-big",
            sentAt: new Date(
              Date.UTC(2026, 3, 13, 10, i, 0),
            ),
            body: `m${i}`,
          }),
        );
      }
      await store.upsertMessages(seeded);
      const rows = await store.getThread({
        threadId: "chat-big",
        limit: 3,
        fromStart: true,
      });
      expect(rows.map((m) => m.body)).toEqual(["m0", "m1", "m2"]);
    });

    it("getThread default returns the full thread asc when limit exceeds total messages", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "teams:a@example.test:1",
          source: "teams",
          threadId: "chat-small",
          sentAt: new Date("2026-04-13T10:00:00Z"),
          body: "first",
        }),
        msg({
          id: "teams:a@example.test:2",
          source: "teams",
          threadId: "chat-small",
          sentAt: new Date("2026-04-13T11:00:00Z"),
          body: "second",
        }),
      ]);
      const rows = await store.getThread({ threadId: "chat-small", limit: 100 });
      expect(rows.map((m) => m.body)).toEqual(["first", "second"]);
    });

    it("getThread defaults to 200 when limit omitted (returning the latest 200 of a longer thread, chronologically within the slice)", async () => {
      const { store } = await factory();
      const seeded: Message[] = [];
      for (let i = 0; i < 205; i++) {
        seeded.push(
          msg({
            id: `teams:a@example.test:${i.toString().padStart(3, "0")}`,
            source: "teams",
            threadId: "chat-huge",
            sentAt: new Date(Date.UTC(2026, 3, 13, 0, 0, i)),
            body: `m${i}`,
          }),
        );
      }
      await store.upsertMessages(seeded);
      const rows = await store.getThread({ threadId: "chat-huge" });
      expect(rows).toHaveLength(200);
      expect(rows[0]?.body).toBe("m5");
      expect(rows[199]?.body).toBe("m204");
    });

    it("getThread honours Teams-specific fields on the round-trip", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "teams:a@example.test:1",
          source: "teams",
          threadId: "chat-1",
          chatType: "group",
          replyToId: "root",
          mentions: ["alice@example.test"],
          body: "hi",
        }),
      ]);
      const rows = await store.getThread({ threadId: "chat-1" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.chatType).toBe("group");
      expect(rows[0]?.replyToId).toBe("root");
      expect(rows[0]?.mentions).toEqual(["alice@example.test"]);
    });

    it("listThreadSummaries returns one row per distinct (source, thread_id) with counts and date range, ordered newestSentAt desc", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "w1",
          source: "whatsapp",
          threadId: "General chat",
          threadName: "General chat",
          sentAt: new Date("2026-04-09T10:00:00Z"),
          body: "old a",
        }),
        msg({
          id: "w2",
          source: "whatsapp",
          threadId: "General chat",
          threadName: "General chat",
          sentAt: new Date("2026-04-09T11:00:00Z"),
          body: "old b",
        }),
        msg({
          id: "w3",
          source: "whatsapp",
          threadId: "General chat (BC Dev Talk)",
          threadName: "General chat (BC Dev Talk)",
          sentAt: new Date("2026-04-20T09:00:00Z"),
          body: "new a",
        }),
        msg({
          id: "w4",
          source: "whatsapp",
          threadId: "General chat (BC Dev Talk)",
          threadName: "General chat (BC Dev Talk)",
          sentAt: new Date("2026-04-21T08:00:00Z"),
          body: "new b",
        }),
        msg({
          id: "w5",
          source: "whatsapp",
          threadId: "General chat (BC Dev Talk)",
          threadName: "General chat (BC Dev Talk)",
          sentAt: new Date("2026-04-21T12:00:00Z"),
          body: "new c",
        }),
      ]);
      const rows = await store.listThreadSummaries({ source: "whatsapp" });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        source: "whatsapp",
        threadId: "General chat (BC Dev Talk)",
        threadName: "General chat (BC Dev Talk)",
        messageCount: 3,
        newestSentAt: new Date("2026-04-21T12:00:00Z"),
        oldestSentAt: new Date("2026-04-20T09:00:00Z"),
      });
      expect(rows[1]).toEqual({
        source: "whatsapp",
        threadId: "General chat",
        threadName: "General chat",
        messageCount: 2,
        newestSentAt: new Date("2026-04-09T11:00:00Z"),
        oldestSentAt: new Date("2026-04-09T10:00:00Z"),
      });
    });

    it("listThreadSummaries scopes by source and ignores other sources", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "t1",
          source: "teams",
          threadId: "chat-teams-1",
          threadName: "Team Chat",
          sentAt: new Date("2026-04-13T10:00:00Z"),
        }),
        msg({
          id: "w1",
          source: "whatsapp",
          threadId: "chat-whatsapp-1",
          threadName: "WhatsApp Chat",
          sentAt: new Date("2026-04-13T10:00:00Z"),
        }),
      ]);
      const teams = await store.listThreadSummaries({ source: "teams" });
      expect(teams).toHaveLength(1);
      expect(teams[0]?.threadId).toBe("chat-teams-1");
      const whatsapp = await store.listThreadSummaries({ source: "whatsapp" });
      expect(whatsapp).toHaveLength(1);
      expect(whatsapp[0]?.threadId).toBe("chat-whatsapp-1");
    });

    it("listThreadSummaries skips messages with NULL thread_id", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "orphan",
          source: "outlook",
          sentAt: new Date("2026-04-13T10:00:00Z"),
        }),
        msg({
          id: "grouped",
          source: "outlook",
          threadId: "thread-x",
          threadName: "Subject X",
          sentAt: new Date("2026-04-13T10:00:00Z"),
        }),
      ]);
      const rows = await store.listThreadSummaries({ source: "outlook" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.threadId).toBe("thread-x");
    });

    it("listThreadSummaries picks threadName from the latest message in each thread", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "x1",
          source: "whatsapp",
          threadId: "General chat",
          threadName: "General chat",
          sentAt: new Date("2026-04-09T10:00:00Z"),
        }),
        msg({
          id: "x2",
          source: "whatsapp",
          threadId: "General chat",
          threadName: "General chat (renamed)",
          sentAt: new Date("2026-04-21T10:00:00Z"),
        }),
      ]);
      const rows = await store.listThreadSummaries({ source: "whatsapp" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.threadName).toBe("General chat (renamed)");
    });

    it("listThreadSummaries returns [] for a source with no messages", async () => {
      const { store } = await factory();
      expect(await store.listThreadSummaries({ source: "teams" })).toEqual([]);
    });

    it("listThreadSummaries returns threadName=undefined when every row in the thread has a NULL thread_name", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({
          id: "bare",
          source: "outlook",
          threadId: "bare-thread",
          sentAt: new Date("2026-04-13T10:00:00Z"),
        }),
      ]);
      const rows = await store.listThreadSummaries({ source: "outlook" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.threadName).toBeUndefined();
    });

    it("getSyncLogRecent returns [] on an empty store", async () => {
      const { store } = await factory();
      expect(await store.getSyncLogRecent(100)).toEqual([]);
    });

    it("getSyncLogRecent returns the N most recent entries ordered by ts DESC", async () => {
      const { store } = await factory();
      await store.appendSyncLog({
        ts: new Date("2026-04-13T10:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 1,
      });
      await store.appendSyncLog({
        ts: new Date("2026-04-13T11:00:00Z"),
        account: "a@example.test",
        source: "teams",
        status: "error",
        errorMessage: "x",
      });
      await store.appendSyncLog({
        ts: new Date("2026-04-13T12:00:00Z"),
        account: "b@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 3,
      });
      const rows = await store.getSyncLogRecent(100);
      expect(rows).toHaveLength(3);
      expect(rows[0]?.ts.toISOString()).toBe("2026-04-13T12:00:00.000Z");
      expect(rows[1]?.ts.toISOString()).toBe("2026-04-13T11:00:00.000Z");
      expect(rows[2]?.ts.toISOString()).toBe("2026-04-13T10:00:00.000Z");
    });

    it("getSyncLogRecent caps the result to the requested limit", async () => {
      const { store } = await factory();
      for (let i = 0; i < 5; i++) {
        await store.appendSyncLog({
          ts: new Date(Date.UTC(2026, 3, 13, 10 + i, 0, 0)),
          account: "a@example.test",
          source: "outlook",
          status: "ok",
          messagesAdded: 1,
        });
      }
      const rows = await store.getSyncLogRecent(2);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.ts.toISOString()).toBe("2026-04-13T14:00:00.000Z");
      expect(rows[1]?.ts.toISOString()).toBe("2026-04-13T13:00:00.000Z");
    });

    it("getSyncLogRecent with limit=0 returns []", async () => {
      const { store } = await factory();
      await store.appendSyncLog({
        ts: new Date("2026-04-13T10:00:00Z"),
        account: "a@example.test",
        source: "outlook",
        status: "ok",
        messagesAdded: 1,
      });
      expect(await store.getSyncLogRecent(0)).toEqual([]);
    });

    it("getRecentMessages honours the limit", async () => {
      const { store } = await factory();
      await store.upsertMessages([
        msg({ id: "1", sentAt: new Date("2026-04-13T01:00:00Z") }),
        msg({ id: "2", sentAt: new Date("2026-04-13T02:00:00Z") }),
        msg({ id: "3", sentAt: new Date("2026-04-13T03:00:00Z") }),
        msg({ id: "4", sentAt: new Date("2026-04-13T04:00:00Z") }),
      ]);
      const ids = await recentIds(store, {
        since: new Date("2026-04-01T00:00:00Z"),
        limit: 2,
      });
      expect(ids).toEqual(["4", "3"]);
    });

    it("upsertEvents inserts a new event with its attendees", async () => {
      const { store } = await factory();
      await store.upsertEvents([
        calendarEvent({
          eventId: "evt-1",
          subject: "Planning sync",
          attendees: [
            attendee({ email: "kristof@example.test", displayName: "Kristof" }),
            attendee({
              email: "eric@example.test",
              displayName: "Eric",
              isOrganizer: true,
              responseStatus: "organizer",
            }),
          ],
        }),
      ]);
      const [event] = await store.getEventsInRange(
        "a@example.test",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-14T00:00:00Z"),
      );
      expect(event?.eventId).toBe("evt-1");
      expect(event?.subject).toBe("Planning sync");
      expect(event?.attendees).toHaveLength(2);
    });

    it("upsertEvents with zero attendees stores an event with an empty attendee list", async () => {
      const { store } = await factory();
      await store.upsertEvents([calendarEvent({ eventId: "evt-solo" })]);
      const [event] = await store.getEventsInRange(
        "a@example.test",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-14T00:00:00Z"),
      );
      expect(event?.attendees).toEqual([]);
    });

    it("upsertEvents replaces attendees on update, not append", async () => {
      const { store } = await factory();
      await store.upsertEvents([
        calendarEvent({
          eventId: "evt-1",
          attendees: [
            attendee({ email: "kristof@example.test" }),
            attendee({ email: "eric@example.test" }),
          ],
        }),
      ]);
      await store.upsertEvents([
        calendarEvent({
          eventId: "evt-1",
          attendees: [attendee({ email: "eric@example.test" })],
        }),
      ]);
      const [event] = await store.getEventsInRange(
        "a@example.test",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-14T00:00:00Z"),
      );
      expect(event?.attendees).toHaveLength(1);
      expect(event?.attendees[0]?.email).toBe("eric@example.test");
    });

    it("upsertEvents case-folds attendee email to lower case", async () => {
      const { store } = await factory();
      await store.upsertEvents([
        calendarEvent({
          eventId: "evt-1",
          attendees: [attendee({ email: "Kristof@Example.Test" })],
        }),
      ]);
      const [event] = await store.getEventsInRange(
        "a@example.test",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-14T00:00:00Z"),
      );
      expect(event?.attendees[0]?.email).toBe("kristof@example.test");
    });

    it("deleteEvents removes the event and its attendees", async () => {
      const { store } = await factory();
      await store.upsertEvents([
        calendarEvent({
          eventId: "evt-1",
          attendees: [attendee({ email: "kristof@example.test" })],
        }),
      ]);
      await store.deleteEvents([{ account: "a@example.test", eventId: "evt-1" }]);
      const events = await store.getEventsInRange(
        "a@example.test",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-14T00:00:00Z"),
      );
      expect(events).toEqual([]);
      // Re-adding the same eventId must not collide with orphaned attendee
      // rows from the deleted event — proves attendees were actually removed,
      // not just the event row.
      await store.upsertEvents([calendarEvent({ eventId: "evt-1" })]);
      const [reAdded] = await store.getEventsInRange(
        "a@example.test",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-14T00:00:00Z"),
      );
      expect(reAdded?.attendees).toEqual([]);
    });

    it("deleteEvents on an unknown event is a no-op", async () => {
      const { store } = await factory();
      await expect(
        store.deleteEvents([{ account: "a@example.test", eventId: "missing" }]),
      ).resolves.not.toThrow();
    });

    it("deleteEvents with an empty list is a no-op", async () => {
      const { store } = await factory();
      await store.upsertEvents([calendarEvent({ eventId: "evt-1" })]);
      await store.deleteEvents([]);
      const events = await store.getEventsInRange(
        "a@example.test",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-14T00:00:00Z"),
      );
      expect(events).toHaveLength(1);
    });

    it("getEventsInRange returns overlapping events ordered by start_at with attendees joined", async () => {
      const { store } = await factory();
      await store.upsertEvents([
        calendarEvent({
          eventId: "before",
          startAt: new Date("2026-04-12T08:00:00Z"),
          endAt: new Date("2026-04-12T09:00:00Z"),
        }),
        calendarEvent({
          eventId: "spans-window",
          startAt: new Date("2026-04-12T23:00:00Z"),
          endAt: new Date("2026-04-13T01:00:00Z"),
        }),
        calendarEvent({
          eventId: "inside-early",
          startAt: new Date("2026-04-13T09:00:00Z"),
          endAt: new Date("2026-04-13T10:00:00Z"),
          attendees: [attendee({ email: "kristof@example.test" })],
        }),
        calendarEvent({
          eventId: "inside-late",
          startAt: new Date("2026-04-13T15:00:00Z"),
          endAt: new Date("2026-04-13T16:00:00Z"),
        }),
        calendarEvent({
          eventId: "after",
          startAt: new Date("2026-04-15T08:00:00Z"),
          endAt: new Date("2026-04-15T09:00:00Z"),
        }),
      ]);
      const events = await store.getEventsInRange(
        "a@example.test",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-14T00:00:00Z"),
      );
      expect(events.map((e) => e.eventId)).toEqual([
        "spans-window",
        "inside-early",
        "inside-late",
      ]);
      expect(events[1]?.attendees).toEqual([
        expect.objectContaining({ email: "kristof@example.test" }),
      ]);
    });

    it("getEventsInRange still returns cancelled events — filtering is the caller's job", async () => {
      const { store } = await factory();
      await store.upsertEvents([
        calendarEvent({ eventId: "cancelled-evt", isCancelled: true }),
      ]);
      const events = await store.getEventsInRange(
        "a@example.test",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-14T00:00:00Z"),
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.isCancelled).toBe(true);
    });

    it("getEventsInRange excludes events from other accounts", async () => {
      const { store } = await factory();
      await store.upsertEvents([
        calendarEvent({ eventId: "evt-1", account: "a@example.test" }),
        calendarEvent({ eventId: "evt-1", account: "b@example.test" }),
      ]);
      const events = await store.getEventsInRange(
        "a@example.test",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-14T00:00:00Z"),
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.account).toBe("a@example.test");
    });

    it("upsert + getEventsInRange round-trips all CalendarEvent columns", async () => {
      const { store } = await factory();
      await store.upsertEvents([
        calendarEvent({
          eventId: "evt-full",
          tenantId: "tenant-1",
          subject: "Full round-trip — café 😀",
          organizerName: "Eric Wauters",
          organizerEmail: "eric@example.test",
          isAllDay: true,
          isCancelled: false,
          chatId: "19:chat-thread-id@thread.v2",
          onlineMeetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
          onlineMeetingId: "meeting-123",
          lastModifiedAt: new Date("2026-04-12T00:00:00Z"),
          rawJson: '{"id":"evt-full"}',
        }),
      ]);
      const [event] = await store.getEventsInRange(
        "a@example.test",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-14T00:00:00Z"),
      );
      expect(event).toMatchObject({
        eventId: "evt-full",
        tenantId: "tenant-1",
        subject: "Full round-trip — café 😀",
        organizerName: "Eric Wauters",
        organizerEmail: "eric@example.test",
        isAllDay: true,
        isCancelled: false,
        chatId: "19:chat-thread-id@thread.v2",
        onlineMeetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
        onlineMeetingId: "meeting-123",
        rawJson: '{"id":"evt-full"}',
      });
      expect(event?.lastModifiedAt?.toISOString()).toBe(
        "2026-04-12T00:00:00.000Z",
      );
    });

    it("upsert + getEventsInRange round-trips nullable columns as undefined when unset", async () => {
      const { store } = await factory();
      await store.upsertEvents([calendarEvent({ eventId: "evt-bare" })]);
      const [event] = await store.getEventsInRange(
        "a@example.test",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-14T00:00:00Z"),
      );
      expect(event?.chatId).toBeUndefined();
      expect(event?.onlineMeetingUrl).toBeUndefined();
      expect(event?.tenantId).toBeUndefined();
      expect(event?.lastModifiedAt).toBeUndefined();
    });

    it("events PK is composite (account, event_id) — same event_id under different accounts does not collide", async () => {
      const { store } = await factory();
      await store.upsertEvents([
        calendarEvent({
          eventId: "shared-id",
          account: "a@example.test",
          subject: "Account A's meeting",
        }),
        calendarEvent({
          eventId: "shared-id",
          account: "b@example.test",
          subject: "Account B's meeting",
        }),
      ]);
      const [aEvent] = await store.getEventsInRange(
        "a@example.test",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-14T00:00:00Z"),
      );
      const [bEvent] = await store.getEventsInRange(
        "b@example.test",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-14T00:00:00Z"),
      );
      expect(aEvent?.subject).toBe("Account A's meeting");
      expect(bEvent?.subject).toBe("Account B's meeting");
    });

    it("getEventByKey returns the event with attendees, or null", async () => {
      const { store } = await factory();
      expect(
        await store.getEventByKey({ account: "a@example.test", eventId: "missing" }),
      ).toBeNull();

      await store.upsertEvents([
        calendarEvent({
          eventId: "evt-1",
          attendees: [attendee({ email: "kristof@example.test" })],
        }),
      ]);
      const found = await store.getEventByKey({
        account: "a@example.test",
        eventId: "evt-1",
      });
      expect(found?.eventId).toBe("evt-1");
      expect(found?.attendees).toEqual([
        expect.objectContaining({ email: "kristof@example.test" }),
      ]);

      const zeroAttendees = await store.getEventByKey({
        account: "a@example.test",
        eventId: "missing-still",
      });
      expect(zeroAttendees).toBeNull();
    });

    it("getEventByKey isolates by account — same eventId under two accounts returns the right one", async () => {
      const { store } = await factory();
      await store.upsertEvents([
        calendarEvent({
          eventId: "shared-id",
          account: "a@example.test",
          subject: "Account A's meeting",
        }),
        calendarEvent({
          eventId: "shared-id",
          account: "b@example.test",
          subject: "Account B's meeting",
        }),
      ]);
      const aEvent = await store.getEventByKey({
        account: "a@example.test",
        eventId: "shared-id",
      });
      const bEvent = await store.getEventByKey({
        account: "b@example.test",
        eventId: "shared-id",
      });
      expect(aEvent?.subject).toBe("Account A's meeting");
      expect(bEvent?.subject).toBe("Account B's meeting");
    });

    it("findEvents merges accounts and orders by start_at", async () => {
      const { store } = await factory();
      const wide = {
        from: new Date("2026-01-01T00:00:00Z"),
        to: new Date("2026-12-31T00:00:00Z"),
        order: "asc" as const,
        limit: 100,
      };
      expect((await store.findEvents(wide)).events).toEqual([]);

      await store.upsertEvents([
        calendarEvent({
          eventId: "evt-a",
          account: "a@example.test",
          startAt: new Date("2026-04-13T09:00:00Z"),
          endAt: new Date("2026-04-13T10:00:00Z"),
        }),
        calendarEvent({
          eventId: "evt-b",
          account: "b@example.test",
          startAt: new Date("2026-04-13T08:00:00Z"),
          endAt: new Date("2026-04-13T09:00:00Z"),
        }),
      ]);
      const merged = await store.findEvents(wide);
      expect(merged.events.map((e) => e.eventId)).toEqual(["evt-b", "evt-a"]);

      const oneAccount = await store.findEvents({
        ...wide,
        accounts: ["a@example.test"],
      });
      expect(oneAccount.events.map((e) => e.eventId)).toEqual(["evt-a"]);

      const desc = await store.findEvents({ ...wide, order: "desc" });
      expect(desc.events.map((e) => e.eventId)).toEqual(["evt-a", "evt-b"]);
    });

    it("findEvents subject_contains matches case-insensitively and escapes SQL LIKE metacharacters", async () => {
      const { store } = await factory();
      await store.upsertEvents([
        calendarEvent({ eventId: "evt-budget", subject: "Q3 Budget Review" }),
        calendarEvent({ eventId: "evt-percent", subject: "100% done check-in" }),
        calendarEvent({ eventId: "evt-unrelated", subject: "Standup" }),
      ]);
      const wide = {
        from: new Date("2026-01-01T00:00:00Z"),
        to: new Date("2026-12-31T00:00:00Z"),
        order: "asc" as const,
        limit: 100,
      };
      const mixedCase = await store.findEvents({ ...wide, subjectContains: "bUdGeT" });
      expect(mixedCase.events.map((e) => e.eventId)).toEqual(["evt-budget"]);

      // literal "%" in the filter must not act as a wildcard
      const literalPercent = await store.findEvents({ ...wide, subjectContains: "100%" });
      expect(literalPercent.events.map((e) => e.eventId)).toEqual(["evt-percent"]);
      const wrongPercent = await store.findEvents({ ...wide, subjectContains: "50%" });
      expect(wrongPercent.events).toEqual([]);

      const substring = await store.findEvents({ ...wide, subjectContains: "udge" });
      expect(substring.events.map((e) => e.eventId)).toEqual(["evt-budget"]);
    });

    it("findEvents attendee matches display name, email, or organizer", async () => {
      const { store } = await factory();
      await store.upsertEvents([
        calendarEvent({
          eventId: "evt-attendee-match",
          organizerEmail: "eric@example.test",
          attendees: [attendee({ email: "kristof@example.test", displayName: "Kristof V." })],
        }),
        calendarEvent({
          eventId: "evt-organizer-match",
          organizerName: "Gunter",
          organizerEmail: "gunter@example.test",
        }),
        calendarEvent({ eventId: "evt-no-match", organizerEmail: "someone@example.test" }),
      ]);
      const wide = {
        from: new Date("2026-01-01T00:00:00Z"),
        to: new Date("2026-12-31T00:00:00Z"),
        order: "asc" as const,
        limit: 100,
      };

      const byDisplayName = await store.findEvents({ ...wide, attendee: "Kristof" });
      expect(byDisplayName.events.map((e) => e.eventId)).toEqual(["evt-attendee-match"]);

      const byOrganizerName = await store.findEvents({ ...wide, attendee: "Gunter" });
      expect(byOrganizerName.events.map((e) => e.eventId)).toEqual(["evt-organizer-match"]);

      const byOrganizerEmail = await store.findEvents({ ...wide, attendee: "gunter@" });
      expect(byOrganizerEmail.events.map((e) => e.eventId)).toEqual(["evt-organizer-match"]);

      const noMatch = await store.findEvents({ ...wide, attendee: "nobody-like-this" });
      expect(noMatch.events).toEqual([]);
    });

    it("findEvents caps results at limit and sets truncated when more match", async () => {
      const { store } = await factory();
      await store.upsertEvents([
        calendarEvent({ eventId: "evt-1", startAt: new Date("2026-04-13T01:00:00Z"), endAt: new Date("2026-04-13T02:00:00Z") }),
        calendarEvent({ eventId: "evt-2", startAt: new Date("2026-04-13T03:00:00Z"), endAt: new Date("2026-04-13T04:00:00Z") }),
        calendarEvent({ eventId: "evt-3", startAt: new Date("2026-04-13T05:00:00Z"), endAt: new Date("2026-04-13T06:00:00Z") }),
      ]);
      const wide = {
        from: new Date("2026-01-01T00:00:00Z"),
        to: new Date("2026-12-31T00:00:00Z"),
        order: "asc" as const,
      };
      const exact = await store.findEvents({ ...wide, limit: 3 });
      expect(exact.events).toHaveLength(3);
      expect(exact.truncated).toBe(false);

      const capped = await store.findEvents({ ...wide, limit: 2 });
      expect(capped.events).toHaveLength(2);
      expect(capped.truncated).toBe(true);
      expect(capped.events.map((e) => e.eventId)).toEqual(["evt-1", "evt-2"]);
    });

    it("getRecentItems unions messages and events ordered by at with a 500 cap", async () => {
      const { store } = await factory();
      const window = {
        from: new Date("2026-04-01T00:00:00Z"),
        to: new Date("2026-04-30T00:00:00Z"),
      };

      // empty: no messages, no events
      const empty = await store.getRecentItems({ ...window, kinds: ["message", "event"] });
      expect(empty.items).toEqual([]);

      await store.upsertMessages([
        msg({ id: "m1", sentAt: new Date("2026-04-13T09:00:00Z") }),
      ]);
      await store.upsertEvents([
        calendarEvent({
          eventId: "e1",
          startAt: new Date("2026-04-13T10:00:00Z"),
          endAt: new Date("2026-04-13T11:00:00Z"),
        }),
      ]);
      const mixed = await store.getRecentItems({ ...window, kinds: ["message", "event"] });
      expect(mixed.items.map((i) => i.kind)).toEqual(["message", "event"]);
      expect(mixed.items[0]?.at.toISOString()).toBe("2026-04-13T09:00:00.000Z");
      expect(mixed.items[1]?.at.toISOString()).toBe("2026-04-13T10:00:00.000Z");

      // kinds filter
      const messagesOnly = await store.getRecentItems({ ...window, kinds: ["message"] });
      expect(messagesOnly.items.map((i) => i.kind)).toEqual(["message"]);
      const eventsOnly = await store.getRecentItems({ ...window, kinds: ["event"] });
      expect(eventsOnly.items.map((i) => i.kind)).toEqual(["event"]);

      // sources filter reaches the underlying getRecentMessages call.
      await store.upsertMessages([
        msg({ id: "m2", source: "teams", sentAt: new Date("2026-04-13T09:00:00Z") }),
      ]);
      const sourceFiltered = await store.getRecentItems({
        ...window,
        kinds: ["message"],
        sources: ["teams"],
      });
      expect(sourceFiltered.items.map((i) => (i.kind === "message" ? i.message.id : ""))).toEqual(["m2"]);

      // accounts filter reaches both the message and event sub-fetches.
      await store.upsertMessages([
        msg({ id: "m-other-acct", account: "b@example.test", sentAt: new Date("2026-04-13T09:30:00Z") }),
      ]);
      await store.upsertEvents([
        calendarEvent({
          eventId: "e-other-acct",
          account: "b@example.test",
          startAt: new Date("2026-04-13T09:30:00Z"),
          endAt: new Date("2026-04-13T10:00:00Z"),
        }),
      ]);
      const acctFiltered = await store.getRecentItems({
        ...window,
        kinds: ["message", "event"],
        accounts: ["b@example.test"],
      });
      expect(acctFiltered.items.map((i) => (i.kind === "message" ? i.message.id : i.event.eventId)).sort()).toEqual([
        "e-other-acct",
        "m-other-acct",
      ]);
    });

    it("getRecentItems breaks ties between two items of the same kind by returning them in an arbitrary stable order", async () => {
      const { store } = await factory();
      const tiedAt = new Date("2026-04-13T10:00:00Z");
      await store.upsertMessages([
        msg({ id: "tie-a", sentAt: tiedAt }),
        msg({ id: "tie-b", sentAt: tiedAt }),
      ]);
      const result = await store.getRecentItems({
        from: new Date("2026-04-01T00:00:00Z"),
        to: new Date("2026-04-30T00:00:00Z"),
        kinds: ["message"],
      });
      expect(result.items.map((i) => (i.kind === "message" ? i.message.id : "")).sort()).toEqual([
        "tie-a",
        "tie-b",
      ]);
    });

    it("getRecentItems caps combined messages+events at 500, keeping the most recent", async () => {
      const { store } = await factory();
      const base = Date.parse("2026-04-01T00:00:00Z");
      const messages = Array.from({ length: 300 }, (_, i) =>
        msg({ id: `m${i}`, sentAt: new Date(base + i * 60_000) }),
      );
      const events = Array.from({ length: 300 }, (_, i) =>
        calendarEvent({
          eventId: `e${i}`,
          startAt: new Date(base + i * 60_000 + 30_000),
          endAt: new Date(base + i * 60_000 + 90_000),
        }),
      );
      await store.upsertMessages(messages);
      await store.upsertEvents(events);
      const result = await store.getRecentItems({
        from: new Date(base),
        to: new Date(base + 600 * 60_000),
        kinds: ["message", "event"],
      });
      expect(result.items).toHaveLength(500);
      const ids = result.items.map((i) => (i.kind === "message" ? i.message.id : i.event.eventId));
      expect(ids).not.toContain("m0");
      expect(ids).toContain("m299");
      expect(ids).toContain("e299");
    });

    it("getTranscriptByKey returns null when no transcript exists", async () => {
      const { store } = await factory();
      const got = await store.getTranscriptByKey({
        account: "a@example.test",
        eventId: "evt-1",
        transcriptId: "tr-1",
      });
      expect(got).toBeNull();
    });

    it("upsertTranscript stores a transcript with its segments, retrievable by key", async () => {
      const { store } = await factory();
      await store.upsertEvents([calendarEvent({ eventId: "evt-1" })]);
      await store.upsertTranscript({
        transcript: transcript({
          eventId: "evt-1",
          transcriptId: "tr-1",
          segmentCount: 2,
        }),
        segments: [
          segment({
            eventId: "evt-1",
            transcriptId: "tr-1",
            sequence: 0,
            text: "hello",
            speakerEmail: "kristof@example.test",
            speakerDisplayName: "Kristof",
          }),
          segment({ eventId: "evt-1", transcriptId: "tr-1", sequence: 1, text: "world" }),
        ],
      });
      const got = await store.getTranscriptByKey({
        account: "a@example.test",
        eventId: "evt-1",
        transcriptId: "tr-1",
      });
      expect(got?.transcript.status).toBe("ok");
      expect(got?.transcript.segmentCount).toBe(2);
      expect(got?.segments.map((s) => s.text)).toEqual(["hello", "world"]);
      // Segments come back ordered by sequence regardless of insertion order.
      expect(got?.segments.map((s) => s.sequence)).toEqual([0, 1]);
      expect(got?.segments[0]).toMatchObject({
        speakerEmail: "kristof@example.test",
        speakerDisplayName: "Kristof",
      });
      expect(got?.segments[1]).not.toHaveProperty("speakerEmail");
      expect(got?.segments[1]).not.toHaveProperty("speakerDisplayName");
    });

    it("upsertTranscript on the same key replaces the segment set atomically", async () => {
      const { store } = await factory();
      await store.upsertEvents([calendarEvent({ eventId: "evt-1" })]);
      await store.upsertTranscript({
        transcript: transcript({ eventId: "evt-1", transcriptId: "tr-1" }),
        segments: [
          segment({ eventId: "evt-1", transcriptId: "tr-1", sequence: 0, text: "first draft" }),
          segment({ eventId: "evt-1", transcriptId: "tr-1", sequence: 1, text: "second line" }),
        ],
      });
      await store.upsertTranscript({
        transcript: transcript({
          eventId: "evt-1",
          transcriptId: "tr-1",
          segmentCount: 1,
        }),
        segments: [
          segment({ eventId: "evt-1", transcriptId: "tr-1", sequence: 0, text: "replaced" }),
        ],
      });
      const got = await store.getTranscriptByKey({
        account: "a@example.test",
        eventId: "evt-1",
        transcriptId: "tr-1",
      });
      expect(got?.segments.map((s) => s.text)).toEqual(["replaced"]);
      expect(got?.transcript.segmentCount).toBe(1);
    });

    it("upsertTranscript disambiguates multiple transcripts for the same event (PK includes transcript_id)", async () => {
      const { store } = await factory();
      await store.upsertEvents([calendarEvent({ eventId: "evt-1" })]);
      await store.upsertTranscript({
        transcript: transcript({ eventId: "evt-1", transcriptId: "tr-1" }),
        segments: [segment({ eventId: "evt-1", transcriptId: "tr-1", sequence: 0, text: "first recording" })],
      });
      await store.upsertTranscript({
        transcript: transcript({ eventId: "evt-1", transcriptId: "tr-2" }),
        segments: [segment({ eventId: "evt-1", transcriptId: "tr-2", sequence: 0, text: "second recording" })],
      });
      const first = await store.getTranscriptByKey({
        account: "a@example.test",
        eventId: "evt-1",
        transcriptId: "tr-1",
      });
      const second = await store.getTranscriptByKey({
        account: "a@example.test",
        eventId: "evt-1",
        transcriptId: "tr-2",
      });
      expect(first?.segments.map((s) => s.text)).toEqual(["first recording"]);
      expect(second?.segments.map((s) => s.text)).toEqual(["second recording"]);
    });

    it("listTranscriptsForEvent returns 0+ transcripts scoped to that account+event, ordered by fetchedAt", async () => {
      const { store } = await factory();
      expect(await store.listTranscriptsForEvent("a@example.test", "evt-1")).toEqual([]);

      await store.upsertEvents([
        calendarEvent({ eventId: "evt-1" }),
        calendarEvent({ eventId: "evt-other" }),
      ]);
      await store.upsertTranscript({
        transcript: transcript({
          eventId: "evt-1",
          transcriptId: "tr-2",
          fetchedAt: new Date("2026-04-13T13:00:00Z"),
        }),
        segments: [],
      });
      await store.upsertTranscript({
        transcript: transcript({
          eventId: "evt-1",
          transcriptId: "tr-1",
          fetchedAt: new Date("2026-04-13T12:00:00Z"),
        }),
        segments: [],
      });
      // A transcript on a different event must not leak in.
      await store.upsertTranscript({
        transcript: transcript({ eventId: "evt-other", transcriptId: "tr-3" }),
        segments: [],
      });

      const rows = await store.listTranscriptsForEvent("a@example.test", "evt-1");
      expect(rows.map((r) => r.transcriptId)).toEqual(["tr-1", "tr-2"]);
    });

    it("markTranscriptStatus updates status+fetchedAt on an existing transcript row", async () => {
      const { store } = await factory();
      await store.upsertEvents([calendarEvent({ eventId: "evt-1" })]);
      await store.upsertTranscript({
        transcript: transcript({ eventId: "evt-1", transcriptId: "tr-1" }),
        segments: [segment({ eventId: "evt-1", transcriptId: "tr-1", sequence: 0, text: "hi" })],
      });
      await store.markTranscriptStatus(
        { account: "a@example.test", eventId: "evt-1", transcriptId: "tr-1" },
        "fetch-failed",
        new Date("2026-04-14T00:00:00Z"),
      );
      const got = await store.getTranscriptByKey({
        account: "a@example.test",
        eventId: "evt-1",
        transcriptId: "tr-1",
      });
      expect(got?.transcript.status).toBe("fetch-failed");
      expect(got?.transcript.fetchedAt).toEqual(new Date("2026-04-14T00:00:00Z"));
      // Segments from before the status change are untouched.
      expect(got?.segments.map((s) => s.text)).toEqual(["hi"]);
    });

    it("markTranscriptStatus creates a status-only marker row when none exists yet (no transcript ever found)", async () => {
      const { store } = await factory();
      await store.upsertEvents([calendarEvent({ eventId: "evt-1" })]);
      await store.markTranscriptStatus(
        { account: "a@example.test", eventId: "evt-1", transcriptId: "no-transcript" },
        "not-available",
        new Date("2026-04-14T00:00:00Z"),
      );
      const got = await store.getTranscriptByKey({
        account: "a@example.test",
        eventId: "evt-1",
        transcriptId: "no-transcript",
      });
      expect(got?.transcript.status).toBe("not-available");
      expect(got?.transcript.segmentCount).toBe(0);
      expect(got?.segments).toEqual([]);
    });
  });
}
