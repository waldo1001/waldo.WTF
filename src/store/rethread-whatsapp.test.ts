import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { hashWhatsAppId } from "../sync/whatsapp-map.js";
import { applyMigrations } from "./schema.js";
import { rethreadWhatsApp } from "./rethread-whatsapp.js";

function openDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

interface Seed {
  readonly id: string;
  readonly source?: string;
  readonly threadId: string | null;
  readonly threadName?: string | null;
  readonly sender: string;
  readonly sentAtIso: string;
  readonly importedAt: number;
  readonly body: string;
}

function insert(db: Database.Database, s: Seed): void {
  db.prepare(
    `INSERT INTO messages
       (id, source, account, native_id, thread_id, thread_name,
        sender_name, sent_at, imported_at, body)
     VALUES (?, ?, 'waldo-phone', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.id,
    s.source ?? "whatsapp",
    s.id,
    s.threadId,
    s.threadName ?? s.threadId,
    s.sender,
    new Date(s.sentAtIso).getTime(),
    s.importedAt,
    s.body,
  );
}

function seedBifurcated(db: Database.Database): void {
  insert(db, {
    id: hashWhatsAppId({
      chat: "BC Dev Talk",
      sender: "waldo",
      sentAtIso: "2026-04-09T10:00:00.000Z",
      body: "early",
    }),
    threadId: "BC Dev Talk",
    sender: "waldo",
    sentAtIso: "2026-04-09T10:00:00.000Z",
    importedAt: 1_000,
    body: "early",
  });
  insert(db, {
    id: "legacy-raw-id-under-placeholder-name",
    threadId: "General chat (BC Dev Talk)",
    threadName: "General chat (BC Dev Talk)",
    sender: "waldo",
    sentAtIso: "2026-04-21T08:00:00.000Z",
    importedAt: 2_000,
    body: "late",
  });
}

describe("rethreadWhatsApp", () => {
  it("returns zero counts and writes nothing on an empty or already-normalized lake", () => {
    const db = openDb();
    insert(db, {
      id: hashWhatsAppId({
        chat: "Mom",
        sender: "waldo",
        sentAtIso: "2026-04-15T07:03:17.000Z",
        body: "hi",
      }),
      threadId: "Mom",
      sender: "waldo",
      sentAtIso: "2026-04-15T07:03:17.000Z",
      importedAt: 1,
      body: "hi",
    });
    const r = rethreadWhatsApp(db);
    expect(r.rowsUpdated).toBe(0);
    expect(r.duplicatesDropped).toBe(0);
    expect(r.mergedGroups).toBe(0);
    expect(r.groups).toBe(1);
    db.close();
  });

  it("merges a placeholder-prefix variant under canonical threadId with latest-imported threadName", () => {
    const db = openDb();
    seedBifurcated(db);
    const r = rethreadWhatsApp(db);
    expect(r.mergedGroups).toBe(1);
    expect(r.groups).toBe(1);
    expect(r.rowsUpdated).toBeGreaterThanOrEqual(1);
    const rows = db
      .prepare(
        `SELECT thread_id, thread_name FROM messages WHERE source = 'whatsapp' ORDER BY sent_at`,
      )
      .all() as { thread_id: string; thread_name: string }[];
    expect(rows.every((x) => x.thread_id === "BC Dev Talk")).toBe(true);
    expect(rows.every((x) => x.thread_name === "General chat (BC Dev Talk)")).toBe(
      true,
    );
    db.close();
  });

  it("rewrites message id to hashWhatsAppId on the normalized chat name", () => {
    const db = openDb();
    seedBifurcated(db);
    rethreadWhatsApp(db);
    const ids = db
      .prepare(`SELECT id FROM messages WHERE source = 'whatsapp' ORDER BY sent_at`)
      .all() as { id: string }[];
    const expectedLate = hashWhatsAppId({
      chat: "BC Dev Talk",
      sender: "waldo",
      sentAtIso: "2026-04-21T08:00:00.000Z",
      body: "late",
    });
    expect(ids.map((r) => r.id)).toContain(expectedLate);
    db.close();
  });

  it("on content-id collision keeps the row with higher imported_at and reports duplicatesDropped", () => {
    const db = openDb();
    insert(db, {
      id: hashWhatsAppId({
        chat: "BC Dev Talk",
        sender: "waldo",
        sentAtIso: "2026-04-09T10:00:00.000Z",
        body: "dupe",
      }),
      threadId: "BC Dev Talk",
      sender: "waldo",
      sentAtIso: "2026-04-09T10:00:00.000Z",
      importedAt: 1_000,
      body: "dupe",
    });
    insert(db, {
      id: "legacy-dupe-under-placeholder",
      threadId: "General chat (BC Dev Talk)",
      threadName: "General chat (BC Dev Talk)",
      sender: "waldo",
      sentAtIso: "2026-04-09T10:00:00.000Z",
      importedAt: 2_000,
      body: "dupe",
    });
    const r = rethreadWhatsApp(db);
    expect(r.duplicatesDropped).toBe(1);
    const rows = db
      .prepare(`SELECT id, imported_at FROM messages WHERE source = 'whatsapp'`)
      .all() as { id: string; imported_at: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.imported_at).toBe(2_000);
    expect(rows[0]!.id).toBe(
      hashWhatsAppId({
        chat: "BC Dev Talk",
        sender: "waldo",
        sentAtIso: "2026-04-09T10:00:00.000Z",
        body: "dupe",
      }),
    );
    db.close();
  });

  it("on collision keeps the pre-existing normalized row when it has higher imported_at than the bifurcated plan row", () => {
    const db = openDb();
    insert(db, {
      id: hashWhatsAppId({
        chat: "BC Dev Talk",
        sender: "waldo",
        sentAtIso: "2026-04-09T10:00:00.000Z",
        body: "dupe",
      }),
      threadId: "BC Dev Talk",
      sender: "waldo",
      sentAtIso: "2026-04-09T10:00:00.000Z",
      importedAt: 9_000,
      body: "dupe",
    });
    insert(db, {
      id: "legacy-raw-placeholder-id",
      threadId: "General chat (BC Dev Talk)",
      threadName: "General chat (BC Dev Talk)",
      sender: "waldo",
      sentAtIso: "2026-04-09T10:00:00.000Z",
      importedAt: 100,
      body: "dupe",
    });
    const r = rethreadWhatsApp(db);
    expect(r.duplicatesDropped).toBe(1);
    const rows = db
      .prepare(
        `SELECT id, thread_name, imported_at FROM messages WHERE source = 'whatsapp'`,
      )
      .all() as { id: string; thread_name: string; imported_at: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.imported_at).toBe(9_000);
    expect(rows[0]!.id).toBe(
      hashWhatsAppId({
        chat: "BC Dev Talk",
        sender: "waldo",
        sentAtIso: "2026-04-09T10:00:00.000Z",
        body: "dupe",
      }),
    );
    db.close();
  });

  it("dryRun=true reports duplicatesDropped when the bifurcated plan row outranks the pre-existing", () => {
    const db = openDb();
    insert(db, {
      id: hashWhatsAppId({
        chat: "BC Dev Talk",
        sender: "waldo",
        sentAtIso: "2026-04-09T10:00:00.000Z",
        body: "dupe",
      }),
      threadId: "BC Dev Talk",
      sender: "waldo",
      sentAtIso: "2026-04-09T10:00:00.000Z",
      importedAt: 500,
      body: "dupe",
    });
    insert(db, {
      id: "legacy-raw-placeholder-id",
      threadId: "General chat (BC Dev Talk)",
      threadName: "General chat (BC Dev Talk)",
      sender: "waldo",
      sentAtIso: "2026-04-09T10:00:00.000Z",
      importedAt: 5_000,
      body: "dupe",
    });
    const before = db.prepare(`SELECT id, thread_id FROM messages ORDER BY rowid`).all();
    const dry = rethreadWhatsApp(db, { dryRun: true });
    expect(dry.duplicatesDropped).toBe(1);
    const after = db.prepare(`SELECT id, thread_id FROM messages ORDER BY rowid`).all();
    expect(after).toEqual(before);
    db.close();
  });

  it("dryRun=true reports duplicatesDropped on a collision scenario without writing", () => {
    const db = openDb();
    insert(db, {
      id: hashWhatsAppId({
        chat: "BC Dev Talk",
        sender: "waldo",
        sentAtIso: "2026-04-09T10:00:00.000Z",
        body: "dupe",
      }),
      threadId: "BC Dev Talk",
      sender: "waldo",
      sentAtIso: "2026-04-09T10:00:00.000Z",
      importedAt: 5_000,
      body: "dupe",
    });
    insert(db, {
      id: "legacy-raw-placeholder-id",
      threadId: "General chat (BC Dev Talk)",
      threadName: "General chat (BC Dev Talk)",
      sender: "waldo",
      sentAtIso: "2026-04-09T10:00:00.000Z",
      importedAt: 500,
      body: "dupe",
    });
    const before = db
      .prepare(`SELECT id, thread_id FROM messages ORDER BY rowid`)
      .all();
    const dry = rethreadWhatsApp(db, { dryRun: true });
    expect(dry.duplicatesDropped).toBe(1);
    const after = db
      .prepare(`SELECT id, thread_id FROM messages ORDER BY rowid`)
      .all();
    expect(after).toEqual(before);
    db.close();
  });

  it("leaves non-whatsapp and NULL-threadId rows untouched", () => {
    const db = openDb();
    insert(db, {
      id: "outlook-1",
      source: "outlook",
      threadId: "General chat (BC Dev Talk)",
      threadName: "General chat (BC Dev Talk)",
      sender: "bob",
      sentAtIso: "2026-04-20T00:00:00.000Z",
      importedAt: 1,
      body: "outlook body",
    });
    insert(db, {
      id: "whatsapp-null-thread",
      threadId: null,
      threadName: null,
      sender: "dad",
      sentAtIso: "2026-04-20T00:00:00.000Z",
      importedAt: 1,
      body: "orphan",
    });
    const r = rethreadWhatsApp(db);
    expect(r.rowsUpdated).toBe(0);
    const outlook = db
      .prepare(`SELECT thread_id, thread_name, id FROM messages WHERE source = 'outlook'`)
      .get() as { thread_id: string; thread_name: string; id: string };
    expect(outlook.thread_id).toBe("General chat (BC Dev Talk)");
    expect(outlook.thread_name).toBe("General chat (BC Dev Talk)");
    expect(outlook.id).toBe("outlook-1");
    const orphan = db
      .prepare(`SELECT id, thread_id FROM messages WHERE id = 'whatsapp-null-thread'`)
      .get() as { id: string; thread_id: string | null };
    expect(orphan.id).toBe("whatsapp-null-thread");
    expect(orphan.thread_id).toBeNull();
    db.close();
  });

  it("is idempotent on a second run", () => {
    const db = openDb();
    seedBifurcated(db);
    const first = rethreadWhatsApp(db);
    expect(first.rowsUpdated).toBeGreaterThan(0);
    const second = rethreadWhatsApp(db);
    expect(second.rowsUpdated).toBe(0);
    expect(second.duplicatesDropped).toBe(0);
    expect(second.mergedGroups).toBe(0);
    db.close();
  });

  it("dryRun=true reports the same counts without writing", () => {
    const db = openDb();
    seedBifurcated(db);
    const before = db
      .prepare(`SELECT id, thread_id, thread_name FROM messages ORDER BY rowid`)
      .all();
    const dry = rethreadWhatsApp(db, { dryRun: true });
    expect(dry.mergedGroups).toBe(1);
    expect(dry.rowsUpdated).toBeGreaterThan(0);
    const after = db
      .prepare(`SELECT id, thread_id, thread_name FROM messages ORDER BY rowid`)
      .all();
    expect(after).toEqual(before);
    const real = rethreadWhatsApp(db);
    expect(real.rowsUpdated).toBe(dry.rowsUpdated);
    expect(real.duplicatesDropped).toBe(dry.duplicatesDropped);
    expect(real.mergedGroups).toBe(dry.mergedGroups);
    db.close();
  });

  it("FTS index remains queryable by the canonical thread_name after migration", () => {
    const db = openDb();
    seedBifurcated(db);
    rethreadWhatsApp(db);
    const fts = db
      .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'General'`)
      .all() as { rowid: number }[];
    expect(fts.length).toBe(2);
    db.close();
  });
});
