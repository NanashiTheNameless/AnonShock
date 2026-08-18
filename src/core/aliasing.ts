import { randomBytes } from "node:crypto";

// Look-alikes 0, O, I, l, 1 removed so an alias read aloud or retyped is unambiguous.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SLUG_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Rejection sampling: no modulo bias. */
function pick(alphabet: string, length: number): string {
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= max) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function deviceAlias(): string {
  return "d_" + pick(ALPHABET, 6);
}

export function shockerAlias(): string {
  return "s_" + pick(ALPHABET, 6);
}

export function newSlug(): string {
  return pick(SLUG_ALPHABET, 11);
}

export function isDeviceAlias(v: unknown): v is string {
  return typeof v === "string" && /^d_[0-9A-Za-z]{6}$/.test(v);
}

export function isShockerAlias(v: unknown): v is string {
  return typeof v === "string" && /^s_[0-9A-Za-z]{6}$/.test(v);
}

export function isSlug(v: unknown): v is string {
  return typeof v === "string" && /^[0-9A-Za-z]{11}$/.test(v);
}

/** Mints n unique aliases from the given generator. */
export function uniqueAliases(gen: () => string, n: number, taken = new Set<string>()): string[] {
  const out: string[] = [];
  while (out.length < n) {
    const a = gen();
    if (taken.has(a)) continue;
    taken.add(a);
    out.push(a);
  }
  return out;
}

/** Default guest-facing display names: Hub 1, Hub 2, ... and Shocker A, B, ... AA, AB. */
export function defaultDeviceName(index: number): string {
  return `Hub ${index + 1}`;
}

export function defaultShockerName(index: number): string {
  let n = index;
  let name = "";
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Shocker ${name}`;
}
