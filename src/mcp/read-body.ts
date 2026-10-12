import type { IncomingMessage } from "node:http";

export type CappedBody =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false };

/**
 * Reads a request body up to `maxBytes`. Over the cap it stops buffering and
 * returns `{ ok: false }`; the caller answers 413 with `Connection: close` so
 * Node drops the socket instead of reading the rest. Event listeners rather
 * than `for await`: breaking out of the async iterator destroys the socket
 * before a 413 can be written.
 */
export function readBodyCapped(
  req: IncomingMessage,
  maxBytes: number,
): Promise<CappedBody> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Promise.resolve({ ok: false });
  }
  return new Promise<CappedBody>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    // IncomingMessage without setEncoding() always emits Buffers.
    const onData = (buf: Buffer): void => {
      received += buf.length;
      if (received > maxBytes) {
        cleanup();
        // Discard whatever is still in flight; no more buffering.
        req.resume();
        resolve({ ok: false });
        return;
      }
      chunks.push(buf);
    };
    const onEnd = (): void => {
      cleanup();
      resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
