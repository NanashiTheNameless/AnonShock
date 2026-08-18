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

/**
 * Second key for limits whose window is longer than an hour. Rotating the fast
 * key hourly would hand every address a fresh bucket 24 times a day, which
 * silently turned the per-day link cap into a per-hour one. This key lives for
 * a full day instead, so a day-long window survives. A rotation still resets
 * the window it covers, so the worst case at a boundary is one extra allowance.
 * Same guarantees otherwise: memory only, gone at restart, never written down.
 */
const SLOW_IP_KEY_TTL_MS = 24 * 60 * 60 * 1000;
let slowIpKey = randomBytes(32);
let slowIpKeyRotatedAt = Date.now();

export function hashIpSlow(ip: string): string {
  if (Date.now() - slowIpKeyRotatedAt > SLOW_IP_KEY_TTL_MS) rotateSlowIpKey();
  return createHmac("sha256", slowIpKey).update(ip).digest("base64url").slice(0, 22);
}

export function rotateSlowIpKey(): void {
  slowIpKey = randomBytes(32);
  slowIpKeyRotatedAt = Date.now();
}

/**
 * Every counter registers itself so the sweeper can prune them all. Without
 * that, a key stays in the map forever after its last hit, and an attacker who
 * can vary the client identity grows the map without bound.
 */
const counters = new Set<WindowCounter>();

export function pruneAllCounters(now = Date.now()): void {
  for (const counter of counters) counter.prune(now);
}

/** Simple in-memory counter with a rolling window, for per-IP creation limits. */
export class WindowCounter {
  #hits = new Map<string, number[]>();
  readonly windowMs: number;
  readonly limit: number;

  constructor(windowMs: number, limit: number) {
    this.windowMs = windowMs;
    this.limit = limit;
    counters.add(this);
  }

  /** Number of keys currently retained. Pruning is what keeps this bounded. */
  get size(): number {
    return this.#hits.size;
  }

  check(key: string, now = Date.now()): boolean {
    // Backstop between sweeps: a burst of distinct keys must not outrun pruning.
    if (this.#hits.size > 100_000) this.prune(now);
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

/**
 * Bounds how much expensive work (scrypt) can be in flight at once. The thread
 * pool is small and shared, so unbounded concurrency there stalls the whole
 * process just as surely as running the work inline did. Callers past the queue
 * limit are shed rather than parked, so a flood costs no memory either.
 */
export class Gate {
  #active = 0;
  #waiting: (() => void)[] = [];
  readonly concurrency: number;
  readonly maxQueue: number;

  constructor(concurrency: number, maxQueue: number) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
  }

  get pending(): number {
    return this.#waiting.length;
  }

  /** Resolves to `null` when the queue is full: shed the request, do not wait. */
  async run<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.#active >= this.concurrency) {
      if (this.#waiting.length >= this.maxQueue) return null;
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active += 1;
    try {
      return await fn();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
}
