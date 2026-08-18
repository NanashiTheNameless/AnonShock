import { config, HARD } from "../config.ts";
import type { LinkDef, ShockerDef, UpstreamShare } from "../types.ts";

/**
 * The anonymization core. Everything a guest ever sees is built here, from the
 * link definition plus the upstream pause state. No upstream name, no upstream
 * UUID, no author identity, and no image is ever carried across.
 */

export interface GuestShockerView {
  alias: string;
  name: string;
  permissions: { shock: boolean; vibrate: boolean; sound: boolean };
  limits: { maxIntensity: number; maxDuration: number; minDuration: number };
  paused: boolean;
  cooldownMs: number;
}

export interface GuestDeviceView {
  alias: string;
  name: string;
  shockers: GuestShockerView[];
}

export interface GuestView {
  slug: string;
  title: string;
  author: string;
  status: "active" | "paused" | "expired" | "dead";
  expiresIn: number | null;
  guests: string;
  devices: GuestDeviceView[];
  policy: { rateLimitPerMin: number; botCheckRequired: boolean; passwordRequired: boolean };
  ephemeral: true;
}

/** Effective ceiling: instance, then link/shocker, then upstream. Never widens. */
export function effectiveIntensity(shocker: ShockerDef, upstreamMax: number | null): number {
  return Math.min(
    config.instanceMaxIntensity,
    shocker.maxIntensity,
    upstreamMax ?? HARD.maxIntensity,
    HARD.maxIntensity,
  );
}

export function effectiveDuration(shocker: ShockerDef, upstreamMax: number | null): number {
  return Math.min(
    config.instanceMaxDuration,
    shocker.maxDuration,
    upstreamMax ?? HARD.maxDuration,
    HARD.maxDuration,
  );
}

/** Upstream PauseReason is a bitfield (1 Shocker, 2 UserShare, 4 PublicShare). Guests get a boolean. */
export function pausedBoolean(reason: number | undefined): boolean {
  return (reason ?? 0) !== 0;
}

/** Coarsened so neither becomes a side channel. */
export function bucketGuests(n: number): string {
  if (n <= 0) return "0";
  if (n >= 5) return "5+";
  return String(n);
}

export function bucketExpiry(expiresAt: number, now = Date.now()): number | null {
  const secs = Math.floor((expiresAt - now) / 1000);
  if (secs <= 0) return 0;
  return Math.floor(secs / 60) * 60;
}

export interface UpstreamState {
  /** upstream shocker id -> live upstream facts, when known */
  byId: Map<string, { paused: number; maxIntensity: number | null; maxDuration: number | null;
    allowShock: boolean; allowVibrate: boolean; allowSound: boolean }>;
  /** true when the upstream share has gone away */
  dead: boolean;
}

export function emptyUpstreamState(): UpstreamState {
  return { byId: new Map(), dead: false };
}

export function upstreamStateFromShare(share: UpstreamShare): UpstreamState {
  const byId = new Map<string, {
    paused: number; maxIntensity: number | null; maxDuration: number | null;
    allowShock: boolean; allowVibrate: boolean; allowSound: boolean;
  }>();
  for (const device of share.devices) {
    for (const s of device.shockers) {
      byId.set(s.id, {
        paused: s.paused,
        maxIntensity: s.limits.intensity,
        maxDuration: s.limits.duration,
        allowShock: s.permissions.shock,
        allowVibrate: s.permissions.vibrate,
        allowSound: s.permissions.sound,
      });
    }
  }
  return { byId, dead: false };
}

export function buildGuestView(
  link: LinkDef,
  upstream: UpstreamState,
  guestCount: number,
  now = Date.now(),
): GuestView {
  const expired = link.expiresAt <= now;
  const status: GuestView["status"] = expired
    ? "expired"
    : link.status === "killed"
      ? "paused"
      : link.status === "active"
        ? "active"
        : "dead";

  const devices: GuestDeviceView[] = [];
  for (const device of link.devices) {
    const shockers = link.shockers
      .filter((s) => s.deviceAlias === device.alias && !s.hidden)
      .sort((a, b) => a.sort - b.sort)
      .map((s) => {
        const up = upstream.byId.get(s.upstreamId);
        return {
          alias: s.alias,
          name: s.displayName,
          permissions: {
            shock: s.allowShock && (up?.allowShock ?? true),
            vibrate: s.allowVibrate && (up?.allowVibrate ?? true),
            sound: s.allowSound && (up?.allowSound ?? true),
          },
          limits: {
            maxIntensity: effectiveIntensity(s, up?.maxIntensity ?? null),
            maxDuration: effectiveDuration(s, up?.maxDuration ?? null),
            minDuration: HARD.minDuration,
          },
          paused: pausedBoolean(up?.paused),
          cooldownMs: s.cooldownMs,
        } satisfies GuestShockerView;
      });
    if (shockers.length > 0) {
      devices.push({ alias: device.alias, name: device.displayName, shockers });
    }
  }

  return {
    slug: link.slug,
    title: link.title,
    author: link.authorText,
    status,
    expiresIn: bucketExpiry(link.expiresAt, now),
    guests: bucketGuests(guestCount),
    devices,
    policy: {
      rateLimitPerMin: link.rlPerGuestPerMin,
      botCheckRequired: link.requireBotCheck,
      passwordRequired: link.guestPasswordHash !== undefined,
    },
    ephemeral: true,
  };
}
