import { config } from "../config.ts";
import * as q from "../store/queries.ts";
import { LinkRoom } from "./room.ts";
import { pruneAllCounters, rotateIpKey } from "./limits.ts";
import type { LinkDef } from "../types.ts";

const rooms = new Map<string, LinkRoom>();
let sweeper: NodeJS.Timeout | null = null;

export function roomCount(): number {
  return rooms.size;
}

function evictIdle(): void {
  if (rooms.size < config.maxRooms) return;
  let oldest: LinkRoom | null = null;
  for (const room of rooms.values()) {
    if (room.guestCount > 0) continue;
    if (!oldest || room.lastTouched < oldest.lastTouched) oldest = room;
  }
  if (oldest) {
    oldest.dispose();
    rooms.delete(oldest.id);
  }
}

/** Hydrates a room from the store on first access. */
export function roomForLink(link: LinkDef): LinkRoom {
  const existing = rooms.get(link.id);
  if (existing) {
    existing.touch();
    return existing;
  }
  evictIdle();
  const room = new LinkRoom(link);
  rooms.set(link.id, room);
  return room;
}

export function roomBySlug(slug: string): LinkRoom | null {
  for (const room of rooms.values()) {
    if (room.link.slug === slug) return room;
  }
  const link = q.getLinkBySlug(slug);
  return link ? roomForLink(link) : null;
}

export function existingRoom(linkId: string): LinkRoom | null {
  return rooms.get(linkId) ?? null;
}

export function dropRoom(linkId: string): void {
  const room = rooms.get(linkId);
  if (room) {
    room.dispose();
    rooms.delete(linkId);
  }
}

export async function killAllRooms(): Promise<void> {
  for (const room of rooms.values()) {
    await room.stopAll();
  }
}

export function disposeAllRooms(): void {
  for (const room of rooms.values()) room.dispose();
  rooms.clear();
}

/** Expiry is a hard delete: an expired link leaves no row behind. */
export function sweep(now = Date.now()): void {
  for (const id of q.expiredLinkIds(now)) {
    dropRoom(id);
    q.deleteLink(id);
  }
  q.pruneEmptyHolders();
  // Limiter keys outlive their window otherwise: the map only ever grew.
  pruneAllCounters(now);
  for (const room of rooms.values()) {
    room.pruneSessions(now);
    room.closeIdleUpstream(now);
    const idle = now - room.lastTouched > config.roomIdleTtlSeconds * 1000;
    if (idle && room.guestCount === 0) {
      room.dispose();
      rooms.delete(room.id);
    }
  }
}

export function startSweeper(): void {
  if (sweeper) return;
  let ticks = 0;
  sweeper = setInterval(() => {
    ticks += 1;
    try {
      sweep();
      if (ticks % 120 === 0) rotateIpKey();
    } catch {
      // never let a sweep failure take the process down
    }
  }, 30_000);
  sweeper.unref?.();
}

export function stopSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
