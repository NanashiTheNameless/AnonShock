import { randomUUID } from "node:crypto";
import { getDb } from "./db.ts";
import { open, seal } from "./crypto.ts";
import type { DeviceDef, LinkDef, LinkStatus, ShockerDef } from "../types.ts";

export function newId(): string {
  // Time-ordered id: millisecond prefix plus randomness. Sortable, opaque.
  return Date.now().toString(36).padStart(9, "0") + randomUUID().replace(/-/g, "").slice(0, 14);
}

/* ---------------------------------------------------------------- holders */

export function createHolder(tokenHashValue: Buffer): string {
  const id = newId();
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO holders (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .run(id, tokenHashValue, now, now);
  return id;
}

export function findHolderByHash(tokenHashValue: Buffer): string | null {
  const row = getDb().prepare("SELECT id FROM holders WHERE token_hash = ?").get(tokenHashValue);
  return row ? String(row["id"]) : null;
}

export function touchHolder(holderId: string): void {
  // Coarsened to the day: this exists to prune empty holders, not to track use.
  const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  getDb().prepare("UPDATE holders SET last_seen_at = ? WHERE id = ?").run(day, holderId);
}

export function rotateHolderToken(holderId: string, tokenHashValue: Buffer): void {
  getDb().prepare("UPDATE holders SET token_hash = ? WHERE id = ?").run(tokenHashValue, holderId);
}

export function deleteHolder(holderId: string): void {
  getDb().prepare("DELETE FROM holders WHERE id = ?").run(holderId);
}

export function pruneEmptyHolders(): number {
  const res = getDb()
    .prepare("DELETE FROM holders WHERE id NOT IN (SELECT DISTINCT holder_id FROM links)")
    .run();
  return Number(res.changes);
}

/* ------------------------------------------------------------------ links */

export function countLinks(): number {
  return Number(getDb().prepare("SELECT COUNT(*) c FROM links").get()!["c"]);
}

export function countLinksForHolder(holderId: string): number {
  return Number(
    getDb().prepare("SELECT COUNT(*) c FROM links WHERE holder_id = ?").get(holderId)!["c"],
  );
}

export function slugExists(slug: string): boolean {
  return getDb().prepare("SELECT 1 FROM links WHERE slug = ?").get(slug) !== undefined;
}

export interface InsertLinkInput {
  id: string;
  holderId: string;
  slug: string;
  manageTokenHash: Buffer;
  mode: "share" | "token";
  upstreamBase: string;
  upstreamShareId?: string;
  upstreamToken?: string;
  title: string;
  authorText: string;
  expiresAt: number;
  rlPerGuestPerMin: number;
  rlPerLinkPerMin: number;
  requireBotCheck: boolean;
  guestPasswordHash?: Buffer;
  devices: DeviceDef[];
  shockers: ShockerDef[];
}

export function insertLink(input: InsertLinkInput): void {
  const db = getDb();
  const now = Date.now();
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO links (id, holder_id, slug, manage_token_hash, mode, upstream_base,
         sealed_share_id, sealed_token, title, author_text, status, expires_at,
         rl_per_guest_per_min, rl_per_link_per_min, require_bot_check, guest_password_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.holderId,
      input.slug,
      input.manageTokenHash,
      input.mode,
      input.upstreamBase,
      input.upstreamShareId ? seal(input.upstreamShareId, input.id) : null,
      input.upstreamToken ? seal(input.upstreamToken, input.id) : null,
      input.title,
      input.authorText,
      input.expiresAt,
      input.rlPerGuestPerMin,
      input.rlPerLinkPerMin,
      input.requireBotCheck ? 1 : 0,
      input.guestPasswordHash ?? null,
      now,
    );

    const devStmt = db.prepare(
      "INSERT INTO link_devices (link_id, alias, sealed_id, display_name, sort) VALUES (?, ?, ?, ?, ?)",
    );
    for (const d of input.devices) {
      devStmt.run(input.id, d.alias, seal(d.upstreamId, input.id), d.displayName, d.sort);
    }

    const shkStmt = db.prepare(
      `INSERT INTO link_shockers (link_id, alias, sealed_id, device_alias, display_name,
         max_intensity, max_duration, allow_shock, allow_vibrate, allow_sound, hidden, cooldown_ms, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of input.shockers) {
      shkStmt.run(
        input.id,
        s.alias,
        seal(s.upstreamId, input.id),
        s.deviceAlias,
        s.displayName,
        s.maxIntensity,
        s.maxDuration,
        s.allowShock ? 1 : 0,
        s.allowVibrate ? 1 : 0,
        s.allowSound ? 1 : 0,
        s.hidden ? 1 : 0,
        s.cooldownMs,
        s.sort,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function hydrate(row: Record<string, unknown>): LinkDef {
  const id = String(row["id"]);
  const db = getDb();
  const devices = db
    .prepare("SELECT * FROM link_devices WHERE link_id = ? ORDER BY sort")
    .all(id)
    .map((d) => ({
      alias: String(d["alias"]),
      upstreamId: open(d["sealed_id"] as Buffer, id),
      displayName: String(d["display_name"]),
      sort: Number(d["sort"]),
    }));
  const shockers = db
    .prepare("SELECT * FROM link_shockers WHERE link_id = ? ORDER BY sort")
    .all(id)
    .map((s) => ({
      alias: String(s["alias"]),
      upstreamId: open(s["sealed_id"] as Buffer, id),
      deviceAlias: String(s["device_alias"]),
      displayName: String(s["display_name"]),
      maxIntensity: Number(s["max_intensity"]),
      maxDuration: Number(s["max_duration"]),
      allowShock: Number(s["allow_shock"]) === 1,
      allowVibrate: Number(s["allow_vibrate"]) === 1,
      allowSound: Number(s["allow_sound"]) === 1,
      hidden: Number(s["hidden"]) === 1,
      cooldownMs: Number(s["cooldown_ms"]),
      sort: Number(s["sort"]),
    }));

  const link: LinkDef = {
    id,
    holderId: String(row["holder_id"]),
    slug: String(row["slug"]),
    mode: String(row["mode"]) as LinkDef["mode"],
    upstreamBase: String(row["upstream_base"]),
    title: String(row["title"]),
    authorText: String(row["author_text"]),
    status: String(row["status"]) as LinkStatus,
    expiresAt: Number(row["expires_at"]),
    rlPerGuestPerMin: Number(row["rl_per_guest_per_min"]),
    rlPerLinkPerMin: Number(row["rl_per_link_per_min"]),
    requireBotCheck: Number(row["require_bot_check"]) === 1,
    createdAt: Number(row["created_at"]),
    devices,
    shockers,
  };
  if (row["sealed_share_id"]) link.upstreamShareId = open(row["sealed_share_id"] as Buffer, id);
  if (row["sealed_token"]) link.upstreamToken = open(row["sealed_token"] as Buffer, id);
  if (row["guest_password_hash"]) link.guestPasswordHash = row["guest_password_hash"] as Buffer;
  return link;
}

export function getLinkBySlug(slug: string): LinkDef | null {
  const row = getDb().prepare("SELECT * FROM links WHERE slug = ?").get(slug);
  return row ? hydrate(row as Record<string, unknown>) : null;
}

export function getLinkById(id: string): LinkDef | null {
  const row = getDb().prepare("SELECT * FROM links WHERE id = ?").get(id);
  return row ? hydrate(row as Record<string, unknown>) : null;
}

export function getLinkByManageHash(hash: Buffer): LinkDef | null {
  const row = getDb().prepare("SELECT * FROM links WHERE manage_token_hash = ?").get(hash);
  return row ? hydrate(row as Record<string, unknown>) : null;
}

export function listLinksForHolder(holderId: string): LinkDef[] {
  return getDb()
    .prepare("SELECT * FROM links WHERE holder_id = ? ORDER BY created_at DESC")
    .all(holderId)
    .map((r) => hydrate(r as Record<string, unknown>));
}

export function setLinkStatus(id: string, status: LinkStatus): void {
  getDb().prepare("UPDATE links SET status = ? WHERE id = ?").run(status, id);
}

export function setManageTokenHash(id: string, hash: Buffer): void {
  getDb().prepare("UPDATE links SET manage_token_hash = ? WHERE id = ?").run(hash, id);
}

export function setSlug(id: string, slug: string): void {
  getDb().prepare("UPDATE links SET slug = ? WHERE id = ?").run(slug, id);
}

export function updateLinkSettings(
  id: string,
  patch: Partial<
    Pick<
      LinkDef,
      "title" | "authorText" | "expiresAt" | "rlPerGuestPerMin" | "rlPerLinkPerMin" | "requireBotCheck"
    >
  >,
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.title !== undefined) (sets.push("title = ?"), vals.push(patch.title));
  if (patch.authorText !== undefined) (sets.push("author_text = ?"), vals.push(patch.authorText));
  if (patch.expiresAt !== undefined) (sets.push("expires_at = ?"), vals.push(patch.expiresAt));
  if (patch.rlPerGuestPerMin !== undefined)
    (sets.push("rl_per_guest_per_min = ?"), vals.push(patch.rlPerGuestPerMin));
  if (patch.rlPerLinkPerMin !== undefined)
    (sets.push("rl_per_link_per_min = ?"), vals.push(patch.rlPerLinkPerMin));
  if (patch.requireBotCheck !== undefined)
    (sets.push("require_bot_check = ?"), vals.push(patch.requireBotCheck ? 1 : 0));
  if (sets.length === 0) return;
  vals.push(id);
  getDb()
    .prepare(`UPDATE links SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(vals as never[]));
}

export function updateShocker(
  linkId: string,
  alias: string,
  patch: Partial<
    Pick<
      ShockerDef,
      | "displayName"
      | "maxIntensity"
      | "maxDuration"
      | "allowShock"
      | "allowVibrate"
      | "allowSound"
      | "hidden"
      | "cooldownMs"
    >
  >,
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.displayName !== undefined) (sets.push("display_name = ?"), vals.push(patch.displayName));
  if (patch.maxIntensity !== undefined) (sets.push("max_intensity = ?"), vals.push(patch.maxIntensity));
  if (patch.maxDuration !== undefined) (sets.push("max_duration = ?"), vals.push(patch.maxDuration));
  if (patch.allowShock !== undefined) (sets.push("allow_shock = ?"), vals.push(patch.allowShock ? 1 : 0));
  if (patch.allowVibrate !== undefined)
    (sets.push("allow_vibrate = ?"), vals.push(patch.allowVibrate ? 1 : 0));
  if (patch.allowSound !== undefined) (sets.push("allow_sound = ?"), vals.push(patch.allowSound ? 1 : 0));
  if (patch.hidden !== undefined) (sets.push("hidden = ?"), vals.push(patch.hidden ? 1 : 0));
  if (patch.cooldownMs !== undefined) (sets.push("cooldown_ms = ?"), vals.push(patch.cooldownMs));
  if (sets.length === 0) return;
  vals.push(linkId, alias);
  getDb()
    .prepare(`UPDATE link_shockers SET ${sets.join(", ")} WHERE link_id = ? AND alias = ?`)
    .run(...(vals as never[]));
}

export function replaceAliases(
  linkId: string,
  devices: DeviceDef[],
  shockers: ShockerDef[],
): void {
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM link_devices WHERE link_id = ?").run(linkId);
    db.prepare("DELETE FROM link_shockers WHERE link_id = ?").run(linkId);
    const devStmt = db.prepare(
      "INSERT INTO link_devices (link_id, alias, sealed_id, display_name, sort) VALUES (?, ?, ?, ?, ?)",
    );
    for (const d of devices) {
      devStmt.run(linkId, d.alias, seal(d.upstreamId, linkId), d.displayName, d.sort);
    }
    const shkStmt = db.prepare(
      `INSERT INTO link_shockers (link_id, alias, sealed_id, device_alias, display_name,
         max_intensity, max_duration, allow_shock, allow_vibrate, allow_sound, hidden, cooldown_ms, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of shockers) {
      shkStmt.run(
        linkId,
        s.alias,
        seal(s.upstreamId, linkId),
        s.deviceAlias,
        s.displayName,
        s.maxIntensity,
        s.maxDuration,
        s.allowShock ? 1 : 0,
        s.allowVibrate ? 1 : 0,
        s.allowSound ? 1 : 0,
        s.hidden ? 1 : 0,
        s.cooldownMs,
        s.sort,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function deleteLink(id: string): void {
  getDb().prepare("DELETE FROM links WHERE id = ?").run(id);
}

export function deleteAllLinks(): number {
  const db = getDb();
  const n = countLinks();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM links").run();
    db.prepare("DELETE FROM holders").run();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return n;
}

export function expiredLinkIds(now: number = Date.now()): string[] {
  return getDb()
    .prepare("SELECT id FROM links WHERE expires_at <= ?")
    .all(now)
    .map((r) => String(r["id"]));
}
