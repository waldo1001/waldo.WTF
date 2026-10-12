import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { readBodyCapped } from "./read-body.js";

const fakeReq = (
  chunks: readonly string[],
  headers: Record<string, string> = {},
): { req: IncomingMessage; stream: PassThrough } => {
  const stream = new PassThrough();
  Object.assign(stream, { headers });
  for (const c of chunks) stream.write(Buffer.from(c));
  stream.end();
  return { req: stream as unknown as IncomingMessage, stream };
};

describe("readBodyCapped", () => {
  it("returns the body text when it fits under the cap", async () => {
    const { req } = fakeReq(["ab", "cd"]);
    expect(await readBodyCapped(req, 4)).toEqual({ ok: true, text: "abcd" });
  });

  it("returns an empty body for an empty request", async () => {
    const { req } = fakeReq([]);
    expect(await readBodyCapped(req, 4)).toEqual({ ok: true, text: "" });
  });

  it("refuses a declared Content-Length over the cap without reading the body", async () => {
    const { req, stream } = fakeReq(["x"], { "content-length": "5" });
    expect(await readBodyCapped(req, 4)).toEqual({ ok: false });
    expect(stream.readableEnded).toBe(false);
  });

  it("reads a body whose declared Content-Length equals the cap", async () => {
    const { req } = fakeReq(["abcd"], { "content-length": "4" });
    expect(await readBodyCapped(req, 4)).toEqual({ ok: true, text: "abcd" });
  });

  it("refuses a streamed body that grows past the cap", async () => {
    const { req } = fakeReq(["abc", "de"]);
    expect(await readBodyCapped(req, 4)).toEqual({ ok: false });
  });

  it("counts bytes, not characters (multi-byte UTF-8)", async () => {
    const { req } = fakeReq(["éé€"]); // 2 + 2 + 3 = 7 bytes
    expect(await readBodyCapped(req, 6)).toEqual({ ok: false });
    const ok = fakeReq(["éé€"]);
    expect(await readBodyCapped(ok.req, 7)).toEqual({ ok: true, text: "éé€" });
  });

  it("rejects when the request stream errors", async () => {
    const stream = new PassThrough();
    Object.assign(stream, { headers: {} });
    const pending = readBodyCapped(stream as unknown as IncomingMessage, 10);
    stream.destroy(new Error("socket hang up"));
    await expect(pending).rejects.toThrow("socket hang up");
  });
});
