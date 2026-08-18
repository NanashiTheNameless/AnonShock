import { createChallenge as libCreateChallenge, verifySolution } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import type { Challenge, Solution } from "altcha-lib/types";
import { config, botCheckAvailable } from "../config.ts";

/**
 * ALTCHA v3 proof of work, using the official altcha-lib for issuing and
 * verification and the official v3 widget (vendored in public/vendor) on the
 * page.
 *
 * Self hosted end to end: this instance mints the challenge and checks the
 * solution, so the guest's browser contacts no third party and the content
 * security policy needs no external origin.
 *
 * The v3 protocol derives a key per counter value and searches for one whose
 * key starts with a required prefix. PBKDF2/SHA-256 is used because the browser
 * runs it in WebCrypto, which keeps an honest guest fast while still costing a
 * bulk submitter real work per attempt.
 */

export type { Challenge };

export async function createChallenge(expiresAt?: Date): Promise<Challenge> {
  return libCreateChallenge({
    algorithm: "PBKDF2/SHA-256",
    cost: config.altchaCost,
    deriveKey,
    expiresAt: expiresAt ?? new Date(Date.now() + config.altchaExpirySeconds * 1000),
    hmacSignatureSecret: config.altchaHmacKey,
  });
}

/** Signatures already spent, so one solved challenge cannot be replayed. */
const spent = new Map<string, number>();

export function pruneSpent(now = Date.now()): void {
  for (const [signature, expiresAt] of spent) {
    if (expiresAt <= now) spent.delete(signature);
  }
}

interface WidgetPayload {
  challenge?: { parameters?: unknown; signature?: unknown };
  solution?: { counter?: unknown; derivedKey?: unknown };
}

function decode(payload: string): WidgetPayload | null {
  try {
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as WidgetPayload;
  } catch {
    return null;
  }
}

/**
 * Verifies a base64 payload from the v3 widget, whose shape is
 * `{ challenge: { parameters, signature }, solution: { counter, derivedKey } }`.
 * Returns true when the bot check is not configured, so an instance without a
 * key stays usable.
 *
 * altcha-lib checks the signature, re-derives the key, and enforces the expiry
 * carried inside the signed parameters. Replay is ours to stop: a signature is
 * spent on first use.
 */
export async function verifyAltcha(payload: string, now = Date.now()): Promise<boolean> {
  if (!botCheckAvailable()) return true;
  if (!payload) return false;

  const decoded = decode(payload);
  const parameters = decoded?.challenge?.parameters;
  const signature = decoded?.challenge?.signature;
  const solution = decoded?.solution;

  if (!parameters || typeof parameters !== "object") return false;
  if (typeof signature !== "string" || signature.length === 0) return false;
  if (!solution || typeof solution.counter !== "number" || typeof solution.derivedKey !== "string") {
    return false;
  }

  pruneSpent(now);
  if (spent.has(signature)) return false;

  let verified = false;
  try {
    const result = await verifySolution({
      challenge: { parameters, signature } as Challenge,
      solution: solution as Solution,
      deriveKey,
      hmacSignatureSecret: config.altchaHmacKey,
    });
    verified = result.verified === true;
  } catch {
    return false;
  }
  if (!verified) return false;

  spent.set(signature, now + config.altchaExpirySeconds * 1000);
  return true;
}
