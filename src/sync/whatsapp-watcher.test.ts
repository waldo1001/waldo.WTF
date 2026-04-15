import { describe, expect, it } from "vitest";
import type { Logger } from "../logger.js";
import { InMemoryFileSystem } from "../testing/in-memory-file-system.js";
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
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
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
