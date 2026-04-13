import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./open-database.js";

describe("openDatabase", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "waldo-wtf-opendb-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies WAL journal_mode and foreign_keys=ON", () => {
    const db = openDatabase(join(dir, "lake.db"));
    try {
      const journal = db.pragma("journal_mode", { simple: true });
      expect(journal).toBe("wal");
      const fk = db.pragma("foreign_keys", { simple: true });
      expect(fk).toBe(1);
    } finally {
      db.close();
    }
  });
});
