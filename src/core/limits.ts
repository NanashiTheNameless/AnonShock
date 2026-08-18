import { createHmac, randomBytes } from "node:crypto";

export interface TokenBucket {
  tokens: number;
  capacity: number;
  refillPerMs: number;
  last: number;
}

export function makeBucket(perMinute: number, burst?: number): TokenBucket {
  const capacity = burst ?? Math.max(1, Math.ceil(perMinute / 2));
  return { tokens: capacity, capacity, refillPerMs: perMinute / 60_000, last: Date.now() };
}

/** Returns true if a token was available and consumed. */
export function take(bucket: TokenBucket, now = Date.now()): boolean {
  const elapsed = Math.max(0, now - bucket.last);
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Seconds until the bucket has a token again. */
export function retryAfter(bucket: TokenBucket, now = Date.now()): number {
  const elapsed = Math.max(0, now - bucket.last);
  const tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
  if (tokens >= 1) return 0;
  return Math.ceil((1 - tokens) / bucket.refillPerMs / 1000);
}

/**
 * IP hashing for rate limiting only. The key is generated at boot, kept in
 * memory, and rotated hourly, so an IP-derived value is unlinkable after an
 * hour and gone entirely at restart. Raw IPs are never stored.
 */
let ipKey = randomBytes(32);
let ipKeyRotatedAt = Date.now();

export function hashIp(ip: string): string {
  if (Date.now() - ipKeyRotatedAt > 3_600_000) rotateIpKey();
  return createHmac("sha256", ipKey).update(ip).digest("base64url").slice(0, 22);
}

export function rotateIpKey(): void {
  ipKey = randomBytes(32);
  ipKeyRotatedAt = Date.now();
}

/** Simple in-memory counter with a rolling window, for per-IP creation limits. */
export class WindowCounter {
  #hits = new Map<string, number[]>();
  readonly windowMs: number;
  readonly limit: number;

  constructor(windowMs: number, limit: number) {
    this.windowMs = windowMs;
    this.limit = limit;
  }

  check(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const list = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.limit) {
      this.#hits.set(key, list);
      return false;
    }
    list.push(now);
    this.#hits.set(key, list);
    return true;
  }

  prune(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.#hits) {
      const kept = list.filter((t) => t > cutoff);
      if (kept.length === 0) this.#hits.delete(key);
      else this.#hits.set(key, kept);
    }
  }
}
