import { createHash } from "node:crypto";

/**
 * How OAuth secrets (access/refresh tokens, auth codes) are stored at rest.
 * They are 256-bit random values, so an unsalted SHA-256 is sufficient:
 * there is nothing to brute-force, and lookup stays a single indexed
 * equality match. A copy of lake.db (e.g. the nightly NAS backup) then
 * holds no usable credential.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
