import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config, HARD } from "../config.ts";
import * as q from "../store/queries.ts";
import { newToken, tokenHash } from "../store/crypto.ts";
import { getPublicShare, getTokenDevices, getTokenSelf } from "../upstream/rest.ts";
import {
  defaultDeviceName,
  defaultShockerName,
  deviceAlias,
  newSlug,
  shockerAlias,
} from "./aliasing.ts";
import type { DeviceDef, LinkDef, ShockerDef, UpstreamDevice, UpstreamShare } from "../types.ts";

export class CreateError extends Error {
  readonly type: string;
  readonly status: number;
  readonly field?: string;

  constructor(type: string, status: number, message: string, field?: string) {
    super(message);
    this.type = type;
    this.status = status;
    if (field !== undefined) this.field = field;
  }
}

/* ------------------------------------------------------------- passwords */

/**
 * scrypt is deliberately expensive, so it must never run on the event loop:
 * the sync form froze every other request in the process for the duration of
 * one guest's password attempt. The async form hands the work to the thread
 * pool instead.
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/** Long enough for any real passphrase, short enough that scrypt cost is bounded. */
export const MAX_GUEST_PASSWORD = 128;

export async function hashGuestPassword(password: string): Promise<Buffer> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32);
  return Buffer.concat([salt, key]);
}

export async function verifyGuestPassword(stored: Buffer, password: string): Promise<boolean> {
  if (stored.length !== 48) return false;
  if (password.length > MAX_GUEST_PASSWORD) return false;
  const salt = stored.subarray(0, 16);
  const expected = stored.subarray(16);
  const actual = await scryptAsync(password, salt, 32);
  return timingSafeEqual(expected, actual);
}

/* ---------------------------------------------------------------- inspect */

export interface InspectedShocker {
  upstreamId: string;
  name: string;
  maxIntensity: number;
  maxDuration: number;
  allowShock: boolean;
  allowVibrate: boolean;
  allowSound: boolean;
}

export interface InspectedDevice {
  upstreamId: string;
  name: string;
  shockers: InspectedShocker[];
}

export function inspectShare(share: UpstreamShare): InspectedDevice[] {
  return inspectDevices(share.devices);
}

export function inspectDevices(devices: UpstreamDevice[]): InspectedDevice[] {
  return devices.map((d) => ({
    upstreamId: d.id,
    name: d.name,
    shockers: d.shockers.map((s) => ({
      upstreamId: s.id,
      name: s.name,
      maxIntensity: Math.min(s.limits.intensity ?? HARD.maxIntensity, HARD.maxIntensity),
      maxDuration: Math.min(s.limits.duration ?? HARD.maxDuration, HARD.maxDuration),
      allowShock: s.permissions.shock,
      allowVibrate: s.permissions.vibrate,
      allowSound: s.permissions.sound,
    })),
  }));
}

export async function loadTokenDevices(token: string, base?: string): Promise<UpstreamDevice[]> {
  return getTokenDevices(token, base);
}

export function parseShareId(input: string): string {
  const match = input.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (!match) throw new CreateError("invalid_share", 400, "no share id found in the input");
  return match[0].toLowerCase();
}

export async function loadShare(shareUrlOrId: string, base?: string): Promise<UpstreamShare> {
  return getPublicShare(parseShareId(shareUrlOrId), base);
}

export async function validateToken(token: string, base?: string): Promise<void> {
  const self = await getTokenSelf(token, base);
  const usable = self.permissions.some((p) => p.toLowerCase() === "shockers.use");
  if (!usable) {
    throw new CreateError("token_missing_permission", 400, "the token does not carry shockers.use");
  }
  if (self.paused) {
    throw new CreateError("token_paused", 400, "the token has shocker control paused");
  }
}

/* ----------------------------------------------------------------- create */

export interface SettingsShocker {
  upstreamId: string;
  displayName: string;
  maxIntensity: number;
  maxDuration: number;
  cooldownMs: number;
  allowShock: boolean;
  allowVibrate: boolean;
  allowSound: boolean;
  hidden: boolean;
}

export interface SettingsDevice {
  upstreamId: string;
  displayName: string;
  shockers: SettingsShocker[];
}

export interface CreateSettings {
  title: string;
  author: string;
  ttlSeconds: number;
  requireBotCheck: boolean;
  guestPassword: string | null;
  rateLimitPerMin: number;
  linkRateLimitPerMin: number;
  devices: SettingsDevice[];
}

export interface CreateInput {
  mode: "share" | "token";
  holderId: string;
  upstreamBase: string;
  upstreamShareId?: string;
  upstreamToken?: string;
  settings: CreateSettings;
  /** Everything the upstream reported, so nothing can be silently omitted. */
  discovered: InspectedDevice[];
}

/**
 * Every setting must be stated. A shocker that upstream reported must appear in
 * the submitted settings, configured or explicitly hidden: there is no
 * server-side default for it to fall back to.
 */
export function validateSettings(settings: CreateSettings, discovered: InspectedDevice[]): void {
  const req = (cond: boolean, field: string) => {
    if (!cond) throw new CreateError("incomplete_settings", 400, `missing or invalid ${field}`, field);
  };

  req(typeof settings.title === "string" && settings.title.trim().length > 0, "title");
  req(settings.title.length <= 64, "title");
  req(typeof settings.author === "string" && settings.author.trim().length > 0, "author");
  req(settings.author.length <= 32, "author");
  req(Number.isInteger(settings.ttlSeconds) && settings.ttlSeconds > 0, "ttlSeconds");
  req(settings.ttlSeconds <= config.maxLinkTtlSeconds, "ttlSeconds");
  req(typeof settings.requireBotCheck === "boolean", "requireBotCheck");
  req(settings.guestPassword === null || typeof settings.guestPassword === "string", "guestPassword");
  req(
    settings.guestPassword === null || settings.guestPassword.length <= MAX_GUEST_PASSWORD,
    "guestPassword",
  );
  req(Number.isInteger(settings.rateLimitPerMin) && settings.rateLimitPerMin >= 0, "rateLimitPerMin");
  req(settings.rateLimitPerMin <= 120, "rateLimitPerMin");
  req(
    Number.isInteger(settings.linkRateLimitPerMin) && settings.linkRateLimitPerMin >= 0,
    "linkRateLimitPerMin",
  );
  req(settings.linkRateLimitPerMin <= 600, "linkRateLimitPerMin");
  req(Array.isArray(settings.devices) && settings.devices.length > 0, "devices");

  const discoveredShockers = new Map<string, InspectedShocker>();
  for (const d of discovered) for (const s of d.shockers) discoveredShockers.set(s.upstreamId, s);

  const submitted = new Set<string>();
  let visible = 0;
  for (const device of settings.devices) {
    req(typeof device.upstreamId === "string", "devices[].upstreamId");
    req(
      typeof device.displayName === "string" && device.displayName.trim().length > 0,
      "devices[].displayName",
    );
    req(device.displayName.length <= 64, "devices[].displayName");
    req(Array.isArray(device.shockers), "devices[].shockers");

    for (const s of device.shockers) {
      const upstream = discoveredShockers.get(s.upstreamId);
      req(upstream !== undefined, "devices[].shockers[].upstreamId");
      req(
        typeof s.displayName === "string" && s.displayName.trim().length > 0,
        "devices[].shockers[].displayName",
      );
      req(s.displayName.length <= 64, "devices[].shockers[].displayName");
      req(typeof s.hidden === "boolean", "devices[].shockers[].hidden");
      req(typeof s.allowShock === "boolean", "devices[].shockers[].allowShock");
      req(typeof s.allowVibrate === "boolean", "devices[].shockers[].allowVibrate");
      req(typeof s.allowSound === "boolean", "devices[].shockers[].allowSound");
      req(
        Number.isInteger(s.maxIntensity) &&
          s.maxIntensity >= HARD.minIntensity &&
          s.maxIntensity <= HARD.maxIntensity,
        "devices[].shockers[].maxIntensity",
      );
      req(
        Number.isInteger(s.maxDuration) &&
          s.maxDuration >= HARD.minDuration &&
          s.maxDuration <= HARD.maxDuration,
        "devices[].shockers[].maxDuration",
      );
      req(Number.isInteger(s.cooldownMs) && s.cooldownMs >= 0 && s.cooldownMs <= 600_000,
        "devices[].shockers[].cooldownMs");

      // A ceiling above what upstream allows is refused, never silently clamped.
      if (s.maxIntensity > upstream!.maxIntensity) {
        throw new CreateError(
          "limit_exceeds_upstream",
          400,
          "intensity ceiling is above what upstream allows",
          "devices[].shockers[].maxIntensity",
        );
      }
      if (s.maxDuration > upstream!.maxDuration) {
        throw new CreateError(
          "limit_exceeds_upstream",
          400,
          "duration ceiling is above what upstream allows",
          "devices[].shockers[].maxDuration",
        );
      }
      if (s.maxIntensity > config.instanceMaxIntensity || s.maxDuration > config.instanceMaxDuration) {
        throw new CreateError(
          "limit_exceeds_instance",
          400,
          "a ceiling is above what this instance allows",
        );
      }
      if (s.allowShock && !upstream!.allowShock) {
        throw new CreateError("limit_exceeds_upstream", 400, "upstream does not permit shock", "allowShock");
      }
      if (s.allowVibrate && !upstream!.allowVibrate) {
        throw new CreateError("limit_exceeds_upstream", 400, "upstream does not permit vibrate", "allowVibrate");
      }
      if (s.allowSound && !upstream!.allowSound) {
        throw new CreateError("limit_exceeds_upstream", 400, "upstream does not permit sound", "allowSound");
      }

      submitted.add(s.upstreamId);
      if (!s.hidden) visible += 1;
    }
  }

  for (const id of discoveredShockers.keys()) {
    if (!submitted.has(id)) {
      throw new CreateError(
        "incomplete_settings",
        400,
        "every shocker must be configured or explicitly hidden",
        "devices[].shockers",
      );
    }
  }
  if (visible === 0) {
    throw new CreateError("incomplete_settings", 400, "at least one shocker must be visible", "devices");
  }
  if (submitted.size > config.maxShockersPerLink) {
    throw new CreateError("too_many_shockers", 400, "too many shockers for one link");
  }
}

export interface CreatedLink {
  link: LinkDef;
  slug: string;
  manageToken: string;
}

export async function createLink(input: CreateInput): Promise<CreatedLink> {
  if (q.countLinks() >= config.maxLinks) {
    throw new CreateError("instance_full", 503, "this instance is full");
  }
  if (q.countLinksForHolder(input.holderId) >= config.maxLinksPerHolder) {
    throw new CreateError("holder_link_limit", 409, "this browser has too many live links");
  }

  const id = q.newId();
  let slug = newSlug();
  while (q.slugExists(slug)) slug = newSlug();

  const manageToken = newToken();
  const takenAliases = new Set<string>();
  const devices: DeviceDef[] = [];
  const shockers: ShockerDef[] = [];

  let deviceIndex = 0;
  let shockerIndex = 0;
  for (const device of input.settings.devices) {
    let dAlias = deviceAlias();
    while (takenAliases.has(dAlias)) dAlias = deviceAlias();
    takenAliases.add(dAlias);

    devices.push({
      alias: dAlias,
      upstreamId: device.upstreamId,
      displayName: device.displayName || defaultDeviceName(deviceIndex),
      sort: deviceIndex,
    });

    for (const s of device.shockers) {
      let sAlias = shockerAlias();
      while (takenAliases.has(sAlias)) sAlias = shockerAlias();
      takenAliases.add(sAlias);

      shockers.push({
        alias: sAlias,
        upstreamId: s.upstreamId,
        deviceAlias: dAlias,
        displayName: s.displayName || defaultShockerName(shockerIndex),
        maxIntensity: s.maxIntensity,
        maxDuration: s.maxDuration,
        allowShock: s.allowShock,
        allowVibrate: s.allowVibrate,
        allowSound: s.allowSound,
        hidden: s.hidden,
        cooldownMs: s.cooldownMs,
        sort: shockerIndex,
      });
      shockerIndex += 1;
    }
    deviceIndex += 1;
  }

  const insert: q.InsertLinkInput = {
    id,
    holderId: input.holderId,
    slug,
    manageTokenHash: tokenHash(manageToken),
    mode: input.mode,
    upstreamBase: input.upstreamBase,
    title: input.settings.title,
    authorText: input.settings.author,
    expiresAt: Date.now() + input.settings.ttlSeconds * 1000,
    rlPerGuestPerMin: input.settings.rateLimitPerMin,
    rlPerLinkPerMin: input.settings.linkRateLimitPerMin,
    requireBotCheck: input.settings.requireBotCheck,
    devices,
    shockers,
  };
  if (input.upstreamShareId) insert.upstreamShareId = input.upstreamShareId;
  if (input.upstreamToken) insert.upstreamToken = input.upstreamToken;
  if (input.settings.guestPassword) {
    insert.guestPasswordHash = await hashGuestPassword(input.settings.guestPassword);
  }

  q.insertLink(insert);
  const link = q.getLinkById(id);
  if (!link) throw new CreateError("server_error", 500, "link vanished after insert");
  return { link, slug, manageToken };
}
