import type { Database } from "better-sqlite3";
import {
  hashWhatsAppId,
  normalizeWhatsAppChatName,
} from "../sync/whatsapp-map.js";

export interface RethreadOptions {
  readonly dryRun?: boolean;
}

export interface RethreadResult {
  readonly groups: number;
  readonly mergedGroups: number;
  readonly rowsUpdated: number;
  readonly duplicatesDropped: number;
}

interface Row {
  readonly rowid: number;
  readonly id: string;
  readonly thread_id: string;
  readonly thread_name: string | null;
  readonly sender_name: string | null;
  readonly sent_at: number;
  readonly imported_at: number;
  readonly body: string | null;
}

interface Plan {
  readonly rowid: number;
  readonly newId: string;
  readonly newThreadId: string;
  readonly newThreadName: string | null;
  readonly currentId: string;
  readonly currentThreadId: string;
  readonly currentThreadName: string | null;
  readonly importedAt: number;
}

export function rethreadWhatsApp(
  db: Database,
  opts: RethreadOptions = {},
): RethreadResult {
  const dryRun = opts.dryRun === true;

  const rows = db
    .prepare(
      `SELECT rowid, id, thread_id, thread_name, sender_name, sent_at, imported_at, body
       FROM messages
       WHERE source = 'whatsapp' AND thread_id IS NOT NULL`,
    )
    .all() as Row[];

  type Group = {
    readonly normalized: string;
    readonly rows: Row[];
    readonly distinctRawIds: Set<string>;
    canonicalThreadName: string | null;
    canonicalImportedAt: number;
  };
  const groupsByNorm = new Map<string, Group>();
  for (const r of rows) {
    const normalized = normalizeWhatsAppChatName(r.thread_id);
    let g = groupsByNorm.get(normalized);
    if (!g) {
      g = {
        normalized,
        rows: [],
        distinctRawIds: new Set(),
        canonicalThreadName: r.thread_name,
        canonicalImportedAt: r.imported_at,
      };
      groupsByNorm.set(normalized, g);
    }
    g.rows.push(r);
    g.distinctRawIds.add(r.thread_id);
    if (r.imported_at > g.canonicalImportedAt) {
      g.canonicalImportedAt = r.imported_at;
      g.canonicalThreadName = r.thread_name;
    }
  }

  const plans: Plan[] = [];
  let mergedGroups = 0;
  for (const g of groupsByNorm.values()) {
    const merged = g.distinctRawIds.size > 1;
    if (merged) mergedGroups += 1;
    for (const r of g.rows) {
      const newId = hashWhatsAppId({
        chat: g.normalized,
        ...(r.sender_name !== null && { sender: r.sender_name }),
        sentAtIso: new Date(r.sent_at).toISOString(),
        body: r.body ?? "",
      });
      const needsUpdate =
        newId !== r.id ||
        r.thread_id !== g.normalized ||
        r.thread_name !== g.canonicalThreadName;
      if (!needsUpdate) continue;
      plans.push({
        rowid: r.rowid,
        newId,
        newThreadId: g.normalized,
        newThreadName: g.canonicalThreadName,
        currentId: r.id,
        currentThreadId: r.thread_id,
        currentThreadName: r.thread_name,
        importedAt: r.imported_at,
      });
    }
  }

  let rowsUpdated = 0;
  let duplicatesDropped = 0;

  if (dryRun) {
    const { collisions } = simulateCollisions(plans, rows);
    return {
      groups: groupsByNorm.size,
      mergedGroups,
      rowsUpdated: plans.length - collisions,
      duplicatesDropped: collisions,
    };
  }

  const findByIdStmt = db.prepare<[string], { rowid: number; imported_at: number }>(
    `SELECT rowid, imported_at FROM messages WHERE id = ?`,
  );
  const deleteStmt = db.prepare<[number]>(`DELETE FROM messages WHERE rowid = ?`);
  const updateStmt = db.prepare<[string, string, string | null, number]>(
    `UPDATE messages SET id = ?, thread_id = ?, thread_name = ? WHERE rowid = ?`,
  );

  const tx = db.transaction(() => {
    for (const p of plans) {
      const existing = findByIdStmt.get(p.newId);
      if (existing !== undefined && existing.rowid !== p.rowid) {
        if (existing.imported_at >= p.importedAt) {
          deleteStmt.run(p.rowid);
          duplicatesDropped += 1;
          continue;
        }
        deleteStmt.run(existing.rowid);
        duplicatesDropped += 1;
      }
      updateStmt.run(p.newId, p.newThreadId, p.newThreadName, p.rowid);
      rowsUpdated += 1;
    }
  });
  tx();

  return {
    groups: groupsByNorm.size,
    mergedGroups,
    rowsUpdated,
    duplicatesDropped,
  };
}

function simulateCollisions(
  plans: readonly Plan[],
  allRows: readonly Row[],
): { collisions: number } {
  const idToImportedAt = new Map<string, { rowid: number; importedAt: number }>();
  for (const r of allRows) {
    idToImportedAt.set(r.id, { rowid: r.rowid, importedAt: r.imported_at });
  }
  const alive = new Map(idToImportedAt);
  let collisions = 0;
  for (const p of plans) {
    const existing = alive.get(p.newId);
    if (existing !== undefined && existing.rowid !== p.rowid) {
      collisions += 1;
      if (existing.importedAt >= p.importedAt) {
        alive.delete(p.currentId);
        continue;
      }
      alive.delete(
        [...alive.entries()].find(
          ([, v]) => v.rowid === existing.rowid,
        )?.[0] ?? p.newId,
      );
    }
    alive.delete(p.currentId);
    alive.set(p.newId, { rowid: p.rowid, importedAt: p.importedAt });
  }
  return { collisions };
}
