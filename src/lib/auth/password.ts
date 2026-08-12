import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

/** Hashes a password as `<saltHex>:<derivedKeyHex>` using scrypt. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derivedKey = scryptSync(password, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [saltHex, keyHex] = storedHash.split(":");
  if (!saltHex || !keyHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");
  const actual = scryptSync(password, salt, expected.length);

  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
