import type { Database } from "better-sqlite3";

export interface BackfillDeps {
  readonly db: Database;
  readonly htmlToText: (html: string) => string;
  readonly chunkSize?: number;
  readonly onProgress?: (processedSoFar: number) => void;
}

export interface BackfillResult {
  readonly processed: number;
}

const DEFAULT_CHUNK_SIZE = 5_000;

export function backfillBodyFromHtml(deps: BackfillDeps): BackfillResult {
  const { db, htmlToText, onProgress } = deps;
  const chunkSize = deps.chunkSize ?? DEFAULT_CHUNK_SIZE;

  const select = db.prepare<[number], { rowid: number; body_html: string }>(
    `SELECT rowid, body_html FROM messages
     WHERE body IS NULL AND body_html IS NOT NULL
     LIMIT ?`,
  );
  const update = db.prepare<[string, number]>(
    `UPDATE messages SET body = ? WHERE rowid = ?`,
  );

  let processed = 0;
  for (;;) {
    const rows = select.all(chunkSize);
    if (rows.length === 0) break;
    const tx = db.transaction((batch: typeof rows) => {
      for (const r of batch) {
        update.run(htmlToText(r.body_html), r.rowid);
      }
    });
    tx(rows);
    processed += rows.length;
    if (onProgress) onProgress(processed);
    if (rows.length < chunkSize) break;
  }

  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild');`);

  return { processed };
}
