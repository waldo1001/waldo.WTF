import AdmZip from "adm-zip";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../testing/fake-clock.js";
import { InMemoryFileSystem } from "../testing/in-memory-file-system.js";
import { InMemoryMessageStore } from "../testing/in-memory-message-store.js";
import { importWhatsAppFile, WhatsAppImportError } from "./import-whatsapp.js";

function makeZip(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, "utf8"));
  }
  return zip.toBuffer();
}

const CHAT_FIXTURE = [
  "[15/04/2026, 09:03:17] waldo: first message",
  "continuation",
  "[15/04/2026, 09:04:00] mom: reply",
].join("\n");

const ACCOUNT = "waldo-phone";
const DOWNLOADS = "/Users/waldo/Downloads";
const ARCHIVE = "/Users/waldo/WhatsAppArchive";

function makeDeps(now = new Date("2026-04-15T10:00:00.000Z")) {
  const fs = new InMemoryFileSystem();
  const clock = new FakeClock(now);
  const store = new InMemoryMessageStore();
  return { fs, clock, store };
}

describe("importWhatsAppFile", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("imports parsed rows, archives the file, returns stats", async () => {
    const src = `${DOWNLOADS}/WhatsApp Chat - Mom.txt`;
    await deps.fs.writeFile(src, CHAT_FIXTURE);

    const result = await importWhatsAppFile({
      ...deps,
      filePath: src,
      account: ACCOUNT,
      archiveRoot: ARCHIVE,
    });

    expect(result.chat).toBe("Mom");
    expect(result.parsed).toBe(2);
    expect(result.imported).toBe(2);
    expect(result.archivedTo).toBe(
      `${ARCHIVE}/2026-04/WhatsApp Chat - Mom.txt`,
    );

    // Source file moved.
    expect(await deps.fs.exists(src)).toBe(false);
    expect(await deps.fs.exists(result.archivedTo)).toBe(true);

    // Rows landed in store.
    const recent = await deps.store.getRecentMessages({
      since: new Date("2026-04-15T00:00:00.000Z"),
      limit: 10,
    });
    expect(recent).toHaveLength(2);
    expect(recent.every((m) => m.source === "whatsapp")).toBe(true);
    expect(recent.every((m) => m.account === ACCOUNT)).toBe(true);
  });

  it("creates the archive YYYY-MM subdir via fs.mkdir", async () => {
    const src = `${DOWNLOADS}/WhatsApp Chat - Mom.txt`;
    await deps.fs.writeFile(src, CHAT_FIXTURE);

    const seen: string[] = [];
    const wrappedFs = Object.assign(deps.fs, {
      mkdir: async (p: string) => {
        seen.push(p);
      },
    });

    await importWhatsAppFile({
      fs: wrappedFs,
      clock: deps.clock,
      store: deps.store,
      filePath: src,
      account: ACCOUNT,
      archiveRoot: ARCHIVE,
    });

    expect(seen).toContain(`${ARCHIVE}/2026-04`);
  });

  it("is idempotent across re-imports (same hash id → same rows)", async () => {
    const srcA = `${DOWNLOADS}/WhatsApp Chat - Mom.txt`;
    await deps.fs.writeFile(srcA, CHAT_FIXTURE);
    const first = await importWhatsAppFile({
      ...deps,
      filePath: srcA,
      account: ACCOUNT,
      archiveRoot: ARCHIVE,
    });
    expect(first.imported).toBe(2);

    // User re-exports the same chat later; same content, new file in Downloads.
    const srcB = `${DOWNLOADS}/WhatsApp Chat - Mom.txt`;
    await deps.fs.writeFile(srcB, CHAT_FIXTURE);
    const second = await importWhatsAppFile({
      ...deps,
      filePath: srcB,
      account: ACCOUNT,
      archiveRoot: ARCHIVE,
    });

    // Store still only holds 2 rows (primary key dedup).
    const all = await deps.store.getRecentMessages({
      since: new Date("2026-04-15T00:00:00.000Z"),
      limit: 50,
    });
    expect(all).toHaveLength(2);
    // Second import reports 0 newly-added rows.
    expect(second.imported).toBe(0);
    expect(second.parsed).toBe(2);
  });

  it("throws WhatsAppImportError on malformed content and does NOT archive the file", async () => {
    const src = `${DOWNLOADS}/WhatsApp Chat - Mom.txt`;
    await deps.fs.writeFile(src, "garbage line without header");

    await expect(
      importWhatsAppFile({
        ...deps,
        filePath: src,
        account: ACCOUNT,
        archiveRoot: ARCHIVE,
      }),
    ).rejects.toThrow(WhatsAppImportError);

    // Source file is still in Downloads.
    expect(await deps.fs.exists(src)).toBe(true);
    // No rows landed.
    const recent = await deps.store.getRecentMessages({
      since: new Date("2020-01-01T00:00:00.000Z"),
      limit: 10,
    });
    expect(recent).toHaveLength(0);
  });

  it("appends -1, -2 suffixes on archive collisions", async () => {
    const src = `${DOWNLOADS}/WhatsApp Chat - Mom.txt`;
    await deps.fs.writeFile(src, CHAT_FIXTURE);
    // Pre-seed a colliding archive file.
    await deps.fs.writeFile(
      `${ARCHIVE}/2026-04/WhatsApp Chat - Mom.txt`,
      "older export",
    );

    const result = await importWhatsAppFile({
      ...deps,
      filePath: src,
      account: ACCOUNT,
      archiveRoot: ARCHIVE,
    });

    expect(result.archivedTo).toBe(
      `${ARCHIVE}/2026-04/WhatsApp Chat - Mom-1.txt`,
    );
    expect(await deps.fs.exists(result.archivedTo)).toBe(true);
    // Previous archive untouched.
    expect(
      (await deps.fs.readFile(`${ARCHIVE}/2026-04/WhatsApp Chat - Mom.txt`))
        .toString(),
    ).toBe("older export");
  });

  it("bumps the suffix when -1 is also taken", async () => {
    const src = `${DOWNLOADS}/WhatsApp Chat - Mom.txt`;
    await deps.fs.writeFile(src, CHAT_FIXTURE);
    await deps.fs.writeFile(
      `${ARCHIVE}/2026-04/WhatsApp Chat - Mom.txt`,
      "v0",
    );
    await deps.fs.writeFile(
      `${ARCHIVE}/2026-04/WhatsApp Chat - Mom-1.txt`,
      "v1",
    );

    const result = await importWhatsAppFile({
      ...deps,
      filePath: src,
      account: ACCOUNT,
      archiveRoot: ARCHIVE,
    });
    expect(result.archivedTo).toBe(
      `${ARCHIVE}/2026-04/WhatsApp Chat - Mom-2.txt`,
    );
  });

  it("derives chat name from the filename via 'WhatsApp Chat - <name>.txt' regex", async () => {
    const src = `${DOWNLOADS}/WhatsApp Chat - Family Group.txt`;
    await deps.fs.writeFile(src, CHAT_FIXTURE);
    const result = await importWhatsAppFile({
      ...deps,
      filePath: src,
      account: ACCOUNT,
      archiveRoot: ARCHIVE,
    });
    expect(result.chat).toBe("Family Group");
  });

  it("imports a .zip export by extracting _chat.txt and archives the zip itself", async () => {
    const src = `${DOWNLOADS}/WhatsApp Chat - Mom.zip`;
    const zipBuf = makeZip({ "_chat.txt": CHAT_FIXTURE });
    await deps.fs.writeFile(src, zipBuf);

    const result = await importWhatsAppFile({
      ...deps,
      filePath: src,
      account: ACCOUNT,
      archiveRoot: ARCHIVE,
    });

    expect(result.chat).toBe("Mom");
    expect(result.parsed).toBe(2);
    expect(result.imported).toBe(2);
    expect(result.archivedTo).toBe(
      `${ARCHIVE}/2026-04/WhatsApp Chat - Mom.zip`,
    );
    expect(await deps.fs.exists(src)).toBe(false);
    expect(await deps.fs.exists(result.archivedTo)).toBe(true);

    const recent = await deps.store.getRecentMessages({
      since: new Date("2026-04-15T00:00:00.000Z"),
      limit: 10,
    });
    expect(recent).toHaveLength(2);
    expect(recent.every((m) => m.source === "whatsapp")).toBe(true);
  });

  it("zip import is idempotent with its .txt equivalent (same hash id)", async () => {
    const zipSrc = `${DOWNLOADS}/WhatsApp Chat - Mom.zip`;
    await deps.fs.writeFile(zipSrc, makeZip({ "_chat.txt": CHAT_FIXTURE }));
    const zipResult = await importWhatsAppFile({
      ...deps,
      filePath: zipSrc,
      account: ACCOUNT,
      archiveRoot: ARCHIVE,
    });
    expect(zipResult.imported).toBe(2);

    const txtSrc = `${DOWNLOADS}/WhatsApp Chat - Mom.txt`;
    await deps.fs.writeFile(txtSrc, CHAT_FIXTURE);
    const txtResult = await importWhatsAppFile({
      ...deps,
      filePath: txtSrc,
      account: ACCOUNT,
      archiveRoot: ARCHIVE,
    });
    expect(txtResult.imported).toBe(0);
    expect(txtResult.parsed).toBe(2);
  });

  it("throws WhatsAppImportError when the zip has no _chat.txt entry", async () => {
    const src = `${DOWNLOADS}/WhatsApp Chat - Mom.zip`;
    await deps.fs.writeFile(src, makeZip({ "something-else.txt": "nope" }));

    await expect(
      importWhatsAppFile({
        ...deps,
        filePath: src,
        account: ACCOUNT,
        archiveRoot: ARCHIVE,
      }),
    ).rejects.toThrow(WhatsAppImportError);
    expect(await deps.fs.exists(src)).toBe(true);
  });

  it("throws WhatsAppImportError when the zip buffer is corrupted", async () => {
    const src = `${DOWNLOADS}/WhatsApp Chat - Mom.zip`;
    await deps.fs.writeFile(src, Buffer.from("not a real zip", "utf8"));

    await expect(
      importWhatsAppFile({
        ...deps,
        filePath: src,
        account: ACCOUNT,
        archiveRoot: ARCHIVE,
      }),
    ).rejects.toThrow(WhatsAppImportError);
    expect(await deps.fs.exists(src)).toBe(true);
  });

  it("falls back to filename stem when the pattern does not match", async () => {
    const src = `${DOWNLOADS}/random-export.txt`;
    await deps.fs.writeFile(src, CHAT_FIXTURE);
    const result = await importWhatsAppFile({
      ...deps,
      filePath: src,
      account: ACCOUNT,
      archiveRoot: ARCHIVE,
    });
    expect(result.chat).toBe("random-export");
  });
});
