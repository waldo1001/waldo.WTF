import { createHash, timingSafeEqual } from "node:crypto";

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

export function verifyPkceS256(challenge: string, verifier: string): boolean {
  if (!challenge || !verifier) return false;
  const computed = b64url(createHash("sha256").update(verifier).digest());
  if (computed.length !== challenge.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}
