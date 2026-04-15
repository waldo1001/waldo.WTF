import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { backfillBodyFromHtml } from "./backfill-body-from-html.js";
import { htmlToText } from "../text/html-to-text.js";

function openDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

function insert(
  db: Database.Database,
  id: string,
  body: string | null,
  bodyHtml: string | null,
): void {
  db.prepare(
    `INSERT INTO messages (id, source, account, native_id, sent_at, imported_at, body, body_html)
     VALUES (?, 'outlook', 'a@x', ?, 0, 0, ?, ?)`,
  ).run(id, id, body, bodyHtml);
}

describe("backfillBodyFromHtml", () => {
  it("reports 0 processed on an empty db", () => {
    const db = openDb();
    const r = backfillBodyFromHtml({ db, htmlToText });
    expect(r.processed).toBe(0);
    db.close();
  });

  it("populates body from body_html for NULL-body rows only", () => {
    const db = openDb();
    insert(db, "a", null, "<p>hello world</p>");
    insert(db, "b", "already set", "<p>should not overwrite</p>");
    insert(db, "c", null, null);
    insert(db, "d", null, "<p>second</p>");

    const r = backfillBodyFromHtml({ db, htmlToText });

    expect(r.processed).toBe(2);
    const rows = db
      .prepare("SELECT id, body FROM messages ORDER BY id")
      .all() as { id: string; body: string | null }[];
    expect(rows.find((r) => r.id === "a")?.body).toBe("hello world");
    expect(rows.find((r) => r.id === "b")?.body).toBe("already set");
    expect(rows.find((r) => r.id === "c")?.body).toBeNull();
    expect(rows.find((r) => r.id === "d")?.body).toBe("second");
    db.close();
  });

  it("is idempotent on a second run", () => {
    const db = openDb();
    insert(db, "a", null, "<p>hi</p>");
    expect(backfillBodyFromHtml({ db, htmlToText }).processed).toBe(1);
    expect(backfillBodyFromHtml({ db, htmlToText }).processed).toBe(0);
    db.close();
  });

  it("processes rows across chunk boundaries", () => {
    const db = openDb();
    const N = 2503;
    const stmt = db.prepare(
      `INSERT INTO messages (id, source, account, native_id, sent_at, imported_at, body_html)
       VALUES (?, 'outlook', 'a@x', ?, 0, 0, ?)`,
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < N; i += 1) {
        stmt.run(`id-${i}`, `id-${i}`, `<p>row ${i}</p>`);
      }
    });
    tx();

    const r = backfillBodyFromHtml({ db, htmlToText, chunkSize: 500 });
    expect(r.processed).toBe(N);
    const nulls = db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE body IS NULL")
      .get() as { n: number };
    expect(nulls.n).toBe(0);
    const sample = db
      .prepare("SELECT body FROM messages WHERE id = 'id-1999'")
      .get() as { body: string };
    expect(sample.body).toBe("row 1999");
    db.close();
  });

  it("FTS5 finds words only present in body_html after backfill+rebuild", () => {
    const db = openDb();
    insert(
      db,
      "hidden",
      null,
      "<div>prefix <span>zebraword</span> suffix</div>",
    );

    // Before backfill: FTS has a row with NULL body → no match.
    const before = db
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'zebraword'")
      .all();
    expect(before).toHaveLength(0);

    backfillBodyFromHtml({ db, htmlToText });

    const after = db
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'zebraword'")
      .all();
    expect(after).toHaveLength(1);
    db.close();
  });

  it("calls progress callback per chunk", () => {
    const db = openDb();
    for (let i = 0; i < 7; i += 1) insert(db, `i-${i}`, null, `<p>${i}</p>`);
    const progress: number[] = [];
    const r = backfillBodyFromHtml({
      db,
      htmlToText,
      chunkSize: 3,
      onProgress: (n) => progress.push(n),
    });
    expect(r.processed).toBe(7);
    expect(progress).toEqual([3, 6, 7]);
    db.close();
  });
});
