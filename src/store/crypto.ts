import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "../config.ts";

const ALGO = "aes-256-gcm";

/**
 * Seals a value with AES-256-GCM. The AAD binds the ciphertext to the link it
 * belongs to, so a sealed column copied between rows fails to open.
 * Layout: nonce(12) || tag(16) || ciphertext
 */
export function seal(plaintext: string, aad: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGO, config.storeKey, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}

export function open(sealed: Buffer, aad: string): string {
  if (sealed.length < 28) throw new Error("sealed value truncated");
  const nonce = sealed.subarray(0, 12);
  const tag = sealed.subarray(12, 28);
  const body = sealed.subarray(28);
  const decipher = createDecipheriv(ALGO, config.storeKey, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/** Peppered hash for holder and manage tokens. Only the hash is ever stored. */
export function tokenHash(token: string): Buffer {
  return createHash("sha256")
    .update(config.tokenPepper)
    .update(Buffer.from(token, "utf8"))
    .digest();
}

export function hashEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 32 random bytes, base64url. Used for holder and manage tokens. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function zero(buf: Buffer | undefined): void {
  if (buf) buf.fill(0);
}
