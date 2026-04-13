import { describe, expect, it } from "vitest";
import { InMemoryFileSystem } from "./in-memory-file-system.js";

describe("InMemoryFileSystem", () => {
  it("writeFile followed by readFile returns the same bytes", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("/data/token-cache.json", "hello");
    const bytes = await fs.readFile("/data/token-cache.json");
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString("utf8")).toBe("hello");

    await fs.writeFile("/data/bin", Buffer.from([0x01, 0x02, 0x03]));
    const raw = await fs.readFile("/data/bin");
    expect(Array.from(raw)).toEqual([0x01, 0x02, 0x03]);
  });

  it("readFile rejects when the path does not exist", async () => {
    const fs = new InMemoryFileSystem();
    await expect(fs.readFile("/missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writeFile replaces the contents at an existing path", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("/data/x", "first");
    await fs.writeFile("/data/x", "second");
    const bytes = await fs.readFile("/data/x");
    expect(bytes.toString("utf8")).toBe("second");
  });

  it("rename moves bytes and removes the source path", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("/data/a", "payload");
    await fs.rename("/data/a", "/data/b");
    const moved = await fs.readFile("/data/b");
    expect(moved.toString("utf8")).toBe("payload");
    await expect(fs.readFile("/data/a")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.rename("/data/missing", "/data/c")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("listDir returns sorted immediate children", async () => {
    const fs = new InMemoryFileSystem();
    expect(await fs.listDir("/empty")).toEqual([]);

    await fs.writeFile("/data/b.txt", "");
    await fs.writeFile("/data/a.txt", "");
    await fs.writeFile("/data/c.txt", "");
    await fs.writeFile("/data/nested/deep.txt", "");
    expect(await fs.listDir("/data")).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("watch invokes onEvent when trigger matches the glob", async () => {
    const fs = new InMemoryFileSystem();
    const events: string[] = [];
    const unsubscribe = fs.watch("/inbox", "*.txt", (p) => events.push(p));

    fs.trigger("/inbox/hello.txt");
    fs.trigger("/inbox/ignored.md");
    fs.trigger("/elsewhere/hello.txt");
    expect(events).toEqual(["/inbox/hello.txt"]);

    unsubscribe();
    fs.trigger("/inbox/after.txt");
    expect(events).toEqual(["/inbox/hello.txt"]);
  });

  it("watch glob matches WhatsApp Chat*.txt but not other .txt files", async () => {
    const fs = new InMemoryFileSystem();
    const events: string[] = [];
    fs.watch("/downloads", "WhatsApp Chat*.txt", (p) => events.push(p));

    fs.trigger("/downloads/WhatsApp Chat - Eric.txt");
    fs.trigger("/downloads/WhatsApp Chat with Team.txt");
    fs.trigger("/downloads/notes.txt");
    fs.trigger("/downloads/WhatsApp Chat with Team.zip");

    expect(events).toEqual([
      "/downloads/WhatsApp Chat - Eric.txt",
      "/downloads/WhatsApp Chat with Team.txt",
    ]);
  });
});
