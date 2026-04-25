import { describe, expect, it } from "vitest";
import type { Logger } from "../logger.js";
import { InMemoryFileSystem } from "../testing/in-memory-file-system.js";
import {
  WhatsAppArchiveError,
  WhatsAppParseError,
} from "./import-whatsapp.js";
import { startWhatsAppWatcher } from "./whatsapp-watcher.js";

function makeLogger(): Logger & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    info: (m) => infos.push(m),
    error: (m) => errors.push(m),
    infos,
    errors,
  };
}

const DOWNLOADS = "/Users/waldo/Downloads";

describe("startWhatsAppWatcher", () => {
  it("invokes importer when a matching file appears", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    const imported: string[] = [];
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async (path) => {
        imported.push(path);
      },
    });
    await fs.writeFile(`${DOWNLOADS}/WhatsApp Chat - Mom.txt`, "x");
    fs.trigger(`${DOWNLOADS}/WhatsApp Chat - Mom.txt`);
    // Let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 0));
    expect(imported).toEqual([`${DOWNLOADS}/WhatsApp Chat - Mom.txt`]);
    handle.stop();
  });

  it("invokes importer for .zip exports too", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    const imported: string[] = [];
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async (path) => {
        imported.push(path);
      },
    });
    await fs.writeFile(`${DOWNLOADS}/WhatsApp Chat - Mom.zip`, "x");
    fs.trigger(`${DOWNLOADS}/WhatsApp Chat - Mom.zip`);
    await new Promise((r) => setTimeout(r, 0));
    expect(imported).toEqual([`${DOWNLOADS}/WhatsApp Chat - Mom.zip`]);
    handle.stop();
  });

  it("ignores non-matching filenames", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    const imported: string[] = [];
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async (path) => {
        imported.push(path);
      },
    });
    await fs.writeFile(`${DOWNLOADS}/not-whatsapp.pdf`, "x");
    fs.trigger(`${DOWNLOADS}/not-whatsapp.pdf`);
    await new Promise((r) => setTimeout(r, 0));
    expect(imported).toEqual([]);
    handle.stop();
  });

  it("swallows importer errors and keeps watching", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    let calls = 0;
    const imported: string[] = [];
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async (path) => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        imported.push(path);
      },
    });
    fs.trigger(`${DOWNLOADS}/WhatsApp Chat - A.txt`);
    await new Promise((r) => setTimeout(r, 0));
    fs.trigger(`${DOWNLOADS}/WhatsApp Chat - B.txt`);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    expect(imported).toEqual([`${DOWNLOADS}/WhatsApp Chat - B.txt`]);
    expect(logger.errors.join("\n")).toContain("boom");
    handle.stop();
  });

  it("formats non-Error thrown values via String()", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async () => {
        throw "raw string";
      },
    });
    fs.trigger(`${DOWNLOADS}/WhatsApp Chat - X.txt`);
    await new Promise((r) => setTimeout(r, 0));
    expect(logger.errors.join("\n")).toContain("raw string");
    handle.stop();
  });

  it("stop() unsubscribes — no more importer calls", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    const imported: string[] = [];
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async (path) => {
        imported.push(path);
      },
    });
    handle.stop();
    fs.trigger(`${DOWNLOADS}/WhatsApp Chat - Mom.txt`);
    await new Promise((r) => setTimeout(r, 0));
    expect(imported).toEqual([]);
  });

  it("sweep skips filenames that do not match the WhatsApp export glob", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    await fs.writeFile(`${DOWNLOADS}/WhatsApp Chat - Mom.zip`, "x");
    await fs.writeFile(`${DOWNLOADS}/random.pdf`, "y");
    await fs.writeFile(`${DOWNLOADS}/notes.txt`, "z");
    const imported: string[] = [];
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async (path) => {
        imported.push(path);
      },
    });
    await handle.sweepComplete;
    expect(imported).toEqual([`${DOWNLOADS}/WhatsApp Chat - Mom.zip`]);
    handle.stop();
  });

  it("exposes a sweepComplete promise that resolves after startup sweep finishes", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    await fs.writeFile(`${DOWNLOADS}/WhatsApp Chat - Mom.zip`, "x");
    let importerResolved = false;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async () => {
        await pending;
        importerResolved = true;
      },
    });
    let sweepResolved = false;
    void handle.sweepComplete.then(() => {
      sweepResolved = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(importerResolved).toBe(false);
    expect(sweepResolved).toBe(false);
    release!();
    await handle.sweepComplete;
    expect(sweepResolved).toBe(true);
    expect(importerResolved).toBe(true);
    handle.stop();
  });

  it("imports files that appear after the startup sweep via watch events", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    const imported: string[] = [];
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async (path) => {
        imported.push(path);
      },
    });
    await handle.sweepComplete;
    await fs.writeFile(`${DOWNLOADS}/WhatsApp Chat - Late.txt`, "x");
    fs.trigger(`${DOWNLOADS}/WhatsApp Chat - Late.txt`);
    await new Promise((r) => setTimeout(r, 0));
    expect(imported).toEqual([`${DOWNLOADS}/WhatsApp Chat - Late.txt`]);
    handle.stop();
  });

  it("logs whatsapp_parse_failed when importer throws WhatsAppParseError", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async (path) => {
        throw new WhatsAppParseError("failed to parse WhatsApp export", path);
      },
    });
    await handle.sweepComplete;
    fs.trigger(`${DOWNLOADS}/WhatsApp Chat - Bad.txt`);
    await new Promise((r) => setTimeout(r, 0));
    const joined = logger.errors.join("\n");
    expect(joined).toContain("whatsapp_parse_failed");
    expect(joined).not.toContain("whatsapp_archive_failed");
    expect(joined).not.toContain("whatsapp_import_failed:");
    handle.stop();
  });

  it("logs whatsapp_archive_failed when importer throws WhatsAppArchiveError", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async (path) => {
        throw new WhatsAppArchiveError(
          "failed to archive WhatsApp export (EACCES)",
          path,
        );
      },
    });
    await handle.sweepComplete;
    fs.trigger(`${DOWNLOADS}/WhatsApp Chat - Perms.txt`);
    await new Promise((r) => setTimeout(r, 0));
    const joined = logger.errors.join("\n");
    expect(joined).toContain("whatsapp_archive_failed");
    expect(joined).toContain("EACCES");
    expect(joined).not.toContain("whatsapp_parse_failed");
    handle.stop();
  });

  it("logs whatsapp_import_failed for unknown errors", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async () => {
        throw new Error("totally unexpected");
      },
    });
    await handle.sweepComplete;
    fs.trigger(`${DOWNLOADS}/WhatsApp Chat - Weird.txt`);
    await new Promise((r) => setTimeout(r, 0));
    const joined = logger.errors.join("\n");
    expect(joined).toContain("whatsapp_import_failed");
    expect(joined).toContain("totally unexpected");
    expect(joined).not.toContain("whatsapp_parse_failed");
    expect(joined).not.toContain("whatsapp_archive_failed");
    handle.stop();
  });

  it("logs whatsapp_sweep_complete with file and import counts after startup sweep", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    await fs.writeFile(`${DOWNLOADS}/WhatsApp Chat - A.txt`, "x");
    await fs.writeFile(`${DOWNLOADS}/WhatsApp Chat - B.txt`, "y");
    let calls = 0;
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async (path) => {
        calls += 1;
        if (calls === 1) {
          throw new WhatsAppParseError("boom", path);
        }
      },
    });
    await handle.sweepComplete;
    const summary = logger.infos.find((m) =>
      m.includes("whatsapp_sweep_complete"),
    );
    expect(summary).toBeDefined();
    expect(summary).toContain("files=2");
    expect(summary).toContain("imported=1");
    handle.stop();
  });

  it("sweep skips files that no longer exist by the time sweep reaches them", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    await fs.writeFile(`${DOWNLOADS}/WhatsApp Chat - A.txt`, "x");
    await fs.writeFile(`${DOWNLOADS}/WhatsApp Chat - B.txt`, "y");
    const imported: string[] = [];
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async (path) => {
        imported.push(path);
        // Simulate a race: while processing A, watch event already moved B.
        if (path.endsWith("A.txt")) {
          await fs.rename(
            `${DOWNLOADS}/WhatsApp Chat - B.txt`,
            "/archive/WhatsApp Chat - B.txt",
          );
        }
      },
    });
    await handle.sweepComplete;
    expect(imported).toEqual([`${DOWNLOADS}/WhatsApp Chat - A.txt`]);
    handle.stop();
  });

  it("imports files already present in the downloads directory at startup", async () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    await fs.writeFile(`${DOWNLOADS}/WhatsApp Chat - Mom.zip`, "x");
    await fs.writeFile(`${DOWNLOADS}/WhatsApp Chat - Dad.zip`, "y");
    const imported: string[] = [];
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async (path) => {
        imported.push(path);
      },
    });
    await handle.sweepComplete;
    expect(imported).toEqual([
      `${DOWNLOADS}/WhatsApp Chat - Dad.zip`,
      `${DOWNLOADS}/WhatsApp Chat - Mom.zip`,
    ]);
    handle.stop();
  });

  it("logs an info line when the watcher starts", () => {
    const fs = new InMemoryFileSystem();
    const logger = makeLogger();
    const handle = startWhatsAppWatcher({
      fs,
      logger,
      downloadsPath: DOWNLOADS,
      importer: async () => {},
    });
    expect(logger.infos.some((m) => m.includes(DOWNLOADS))).toBe(true);
    handle.stop();
  });
});
