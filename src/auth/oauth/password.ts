import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, storedHash: string): Promise<boolean>;
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

const scryptAsync = (
  password: string,
  salt: Buffer,
): Promise<Buffer> =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, derived) => {
        /* c8 ignore next -- scrypt only errors on bad params, not at runtime */
        if (err) reject(err);
        else resolve(derived);
      },
    );
  });

export const scryptPasswordHasher: PasswordHasher = {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await scryptAsync(password, salt);
    return `${salt.toString("hex")}:${derived.toString("hex")}`;
  },

  async verify(password: string, storedHash: string): Promise<boolean> {
    const colonIdx = storedHash.indexOf(":");
    if (colonIdx === -1) return false;
    const saltHex = storedHash.slice(0, colonIdx);
    const hashHex = storedHash.slice(colonIdx + 1);
    /* c8 ignore next -- malformed hash without content on both sides of ':' is an edge case */
    if (!saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const derived = await scryptAsync(password, salt);
    /* c8 ignore next -- scrypt always produces KEY_LEN bytes; guard for timingSafeEqual */
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  },
};

export class PlaintextPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `plain:${password}`;
  }
  async verify(password: string, storedHash: string): Promise<boolean> {
    return storedHash === `plain:${password}`;
  }
}
