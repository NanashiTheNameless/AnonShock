import { Hono } from "hono";
import type { Context } from "hono";
import { config, HARD } from "../config.ts";
import { isPaused } from "../store/db.ts";
import * as q from "../store/queries.ts";
import { newToken, tokenHash } from "../store/crypto.ts";
import { deviceAlias, newSlug, shockerAlias } from "../core/aliasing.ts";
import { dropRoom, existingRoom, roomForLink } from "../core/rooms.ts";
import { inspectDevices, inspectShare, loadShare, loadTokenDevices } from "../core/links.ts";
import { escapeHtml, guestJson, html, page, problem } from "./http.ts";
import type { LinkDef } from "../types.ts";

export const manage = new Hono();

function linkFor(c: Context): LinkDef | null {
  const token = c.req.param("token");
  if (!token || token.length < 20) return null;
  return q.getLinkByManageHash(tokenHash(token));
}

/* -------------------------------------------------------------- the page */

manage.get("/m/:token", (c) => {
  const link = linkFor(c);
  if (!link) {
    return html(
      c,
      page(
        "Link not found",
        `<h1>Link not found</h1><p>This manage link is not valid, or the link it managed is gone.</p>`,
      ),
      404,
    );
  }
  const body = `
<h1>Manage: ${escapeHtml(link.title)}</h1>
<p class="note">This link's settings are stored on this instance until it expires.
Nothing about who used it is recorded anywhere.</p>
<div id="manage" data-token="${escapeHtml(c.req.param("token"))}"><p>Loading...</p></div>`;
  return html(c, page(`Manage ${link.title}`, body, { script: "/assets/manage.js" }));
});

/* --------------------------------------------------------------- the API */

manage.get("/api/m/:token", (c) => {
  const link = linkFor(c);
  if (!link) return problem(c, 404, "link_dead");
  const room = existingRoom(link.id);
  return guestJson(c, {
    slug: link.slug,
    guestUrl: `${config.publicOrigin}/s/${link.slug}`,
    title: link.title,
    author: link.authorText,
    mode: link.mode,
    status: link.expiresAt <= Date.now() ? "expired" : link.status,
    expiresAt: link.expiresAt,
    rateLimitPerMin: link.rlPerGuestPerMin,
    linkRateLimitPerMin: link.rlPerLinkPerMin,
    requireBotCheck: link.requireBotCheck,
    passwordSet: link.guestPasswordHash !== undefined,
    guests: room ? room.guestCount : 0,
    instanceMaxIntensity: config.instanceMaxIntensity,
    instanceMaxDuration: config.instanceMaxDuration,
    devices: link.devices.map((d) => ({
      alias: d.alias,
      displayName: d.displayName,
      shockers: link.shockers
        .filter((s) => s.deviceAlias === d.alias)
        .map((s) => ({
          alias: s.alias,
          displayName: s.displayName,
          maxIntensity: s.maxIntensity,
          maxDuration: s.maxDuration,
          cooldownMs: s.cooldownMs,
          allowShock: s.allowShock,
          allowVibrate: s.allowVibrate,
          allowSound: s.allowSound,
          hidden: s.hidden,
        })),
    })),
  });
});

manage.patch("/api/m/:token", async (c) => {
  if (isPaused()) return problem(c, 503, "instance_paused");
  const link = linkFor(c);
  if (!link) return problem(c, 404, "link_dead");

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return problem(c, 400, "invalid_request");
  }

  const patch: Parameters<typeof q.updateLinkSettings>[1] = {};
  if (typeof body["title"] === "string" && body["title"].trim() && body["title"].length <= 64) {
    patch.title = body["title"];
  }
  if (typeof body["author"] === "string" && body["author"].trim() && body["author"].length <= 32) {
    patch.authorText = body["author"];
  }
  if (Number.isInteger(body["ttlSeconds"])) {
    const ttl = body["ttlSeconds"] as number;
    if (ttl < 1 || ttl > config.maxLinkTtlSeconds) return problem(c, 400, "invalid_request", { field: "ttlSeconds" });
    patch.expiresAt = Date.now() + ttl * 1000;
  }
  if (Number.isInteger(body["rateLimitPerMin"])) {
    const v = body["rateLimitPerMin"] as number;
    if (v < 0 || v > 120) return problem(c, 400, "invalid_request", { field: "rateLimitPerMin" });
    patch.rlPerGuestPerMin = v;
  }
  if (Number.isInteger(body["linkRateLimitPerMin"])) {
    const v = body["linkRateLimitPerMin"] as number;
    if (v < 0 || v > 600) return problem(c, 400, "invalid_request", { field: "linkRateLimitPerMin" });
    patch.rlPerLinkPerMin = v;
  }
  if (typeof body["requireBotCheck"] === "boolean") patch.requireBotCheck = body["requireBotCheck"];
  q.updateLinkSettings(link.id, patch);

  const shockers = Array.isArray(body["shockers"]) ? (body["shockers"] as Record<string, unknown>[]) : [];
  for (const s of shockers) {
    const alias = typeof s["alias"] === "string" ? s["alias"] : "";
    const current = link.shockers.find((x) => x.alias === alias);
    if (!current) continue;

    const sp: Parameters<typeof q.updateShocker>[2] = {};
    if (typeof s["displayName"] === "string" && s["displayName"].trim() && s["displayName"].length <= 64) {
      sp.displayName = s["displayName"];
    }
    if (Number.isInteger(s["maxIntensity"])) {
      const v = s["maxIntensity"] as number;
      // Ceilings may only narrow: a value above the current one would need
      // re-checking against upstream, which is what refresh is for.
      if (v < HARD.minIntensity || v > current.maxIntensity) {
        return problem(c, 400, "limit_exceeds_current", { field: "maxIntensity" });
      }
      sp.maxIntensity = v;
    }
    if (Number.isInteger(s["maxDuration"])) {
      const v = s["maxDuration"] as number;
      if (v < HARD.minDuration || v > current.maxDuration) {
        return problem(c, 400, "limit_exceeds_current", { field: "maxDuration" });
      }
      sp.maxDuration = v;
    }
    if (Number.isInteger(s["cooldownMs"])) {
      const v = s["cooldownMs"] as number;
      if (v < 0 || v > 600_000) return problem(c, 400, "invalid_request", { field: "cooldownMs" });
      sp.cooldownMs = v;
    }
    // Permissions may only be turned off here; turning one on needs a refresh
    // so it can be re-checked against upstream.
    if (s["allowShock"] === false) sp.allowShock = false;
    if (s["allowVibrate"] === false) sp.allowVibrate = false;
    if (s["allowSound"] === false) sp.allowSound = false;
    if (typeof s["hidden"] === "boolean") sp.hidden = s["hidden"];
    q.updateShocker(link.id, alias, sp);
  }

  const updated = q.getLinkById(link.id)!;
  existingRoom(link.id)?.reload(updated);
  return guestJson(c, { ok: true });
});

manage.post("/api/m/:token/kill", async (c) => {
  const link = linkFor(c);
  if (!link) return problem(c, 404, "link_dead");
  const room = existingRoom(link.id) ?? roomForLink(link);
  await room.kill();
  return guestJson(c, { ok: true, status: "killed" });
});

manage.post("/api/m/:token/resume", (c) => {
  if (isPaused()) return problem(c, 503, "instance_paused");
  const link = linkFor(c);
  if (!link) return problem(c, 404, "link_dead");
  const room = existingRoom(link.id) ?? roomForLink(link);
  if (!room.resume()) return problem(c, 409, "not_resumable", { status: link.status });
  return guestJson(c, { ok: true, status: "active" });
});

/** Re-reads upstream: adds and drops shockers, keeping existing aliases. */
manage.post("/api/m/:token/refresh", async (c) => {
  if (isPaused()) return problem(c, 503, "instance_paused");
  const link = linkFor(c);
  if (!link) return problem(c, 404, "link_dead");

  try {
    const discovered = link.mode === "share" && link.upstreamShareId
      ? inspectShare(await loadShare(link.upstreamShareId, link.upstreamBase))
      : link.mode === "token" && link.upstreamToken
        ? inspectDevices(await loadTokenDevices(link.upstreamToken, link.upstreamBase))
        : null;
    if (!discovered) return problem(c, 400, "refresh_unavailable");
    const knownDevices = new Map(link.devices.map((d) => [d.upstreamId, d]));
    const knownShockers = new Map(link.shockers.map((s) => [s.upstreamId, s]));

    const devices: typeof link.devices = [];
    const shockers: typeof link.shockers = [];
    let di = 0;
    let si = 0;
    const taken = new Set<string>([...knownDevices.values(), ...knownShockers.values()].map((x) => x.alias));

    for (const d of discovered) {
      const existing = knownDevices.get(d.upstreamId);
      let alias = existing?.alias;
      if (!alias) {
        alias = deviceAlias();
        while (taken.has(alias)) alias = deviceAlias();
        taken.add(alias);
      }
      devices.push({
        alias,
        upstreamId: d.upstreamId,
        displayName: existing?.displayName ?? `Hub ${di + 1}`,
        sort: di,
      });

      for (const s of d.shockers) {
        const known = knownShockers.get(s.upstreamId);
        let sAlias = known?.alias;
        if (!sAlias) {
          sAlias = shockerAlias();
          while (taken.has(sAlias)) sAlias = shockerAlias();
          taken.add(sAlias);
        }
        shockers.push({
          alias: sAlias,
          upstreamId: s.upstreamId,
          deviceAlias: alias,
          displayName: known?.displayName ?? `Shocker ${si + 1}`,
          // New shockers arrive hidden with the lowest ceilings: an addition
          // upstream must never widen a link without the holder saying so.
          maxIntensity: known ? Math.min(known.maxIntensity, s.maxIntensity) : 0,
          maxDuration: known ? Math.min(known.maxDuration, s.maxDuration) : HARD.minDuration,
          allowShock: known ? known.allowShock && s.allowShock : false,
          allowVibrate: known ? known.allowVibrate && s.allowVibrate : false,
          allowSound: known ? known.allowSound && s.allowSound : false,
          hidden: known ? known.hidden : true,
          cooldownMs: known?.cooldownMs ?? 1500,
          sort: si,
        });
        si += 1;
      }
      di += 1;
    }

    q.replaceAliases(link.id, devices, shockers);
    if (link.status === "dead_upstream") q.setLinkStatus(link.id, "active");
    existingRoom(link.id)?.reload(q.getLinkById(link.id)!);
    return guestJson(c, { ok: true, added: shockers.filter((s) => !knownShockers.has(s.upstreamId)).length });
  } catch {
    return problem(c, 503, "upstream_unreachable");
  }
});

manage.post("/api/m/:token/rotate-aliases", (c) => {
  const link = linkFor(c);
  if (!link) return problem(c, 404, "link_dead");

  const taken = new Set<string>();
  const deviceMap = new Map<string, string>();
  const devices = link.devices.map((d) => {
    let alias = deviceAlias();
    while (taken.has(alias)) alias = deviceAlias();
    taken.add(alias);
    deviceMap.set(d.alias, alias);
    return { ...d, alias };
  });
  const shockers = link.shockers.map((s) => {
    let alias = shockerAlias();
    while (taken.has(alias)) alias = shockerAlias();
    taken.add(alias);
    return { ...s, alias, deviceAlias: deviceMap.get(s.deviceAlias) ?? s.deviceAlias };
  });

  q.replaceAliases(link.id, devices, shockers);
  existingRoom(link.id)?.reload(q.getLinkById(link.id)!);
  return guestJson(c, { ok: true });
});

manage.post("/api/m/:token/rotate-slug", (c) => {
  const link = linkFor(c);
  if (!link) return problem(c, 404, "link_dead");
  let slug = newSlug();
  while (q.slugExists(slug)) slug = newSlug();
  q.setSlug(link.id, slug);
  existingRoom(link.id)?.reload(q.getLinkById(link.id)!);
  return guestJson(c, { ok: true, slug, guestUrl: `${config.publicOrigin}/s/${slug}` });
});

manage.post("/api/m/:token/rotate-manage-token", (c) => {
  const link = linkFor(c);
  if (!link) return problem(c, 404, "link_dead");
  const token = newToken();
  q.setManageTokenHash(link.id, tokenHash(token));
  return guestJson(c, { ok: true, manageUrl: `${config.publicOrigin}/m/${token}` });
});

manage.delete("/api/m/:token", async (c) => {
  const link = linkFor(c);
  if (!link) return problem(c, 404, "link_dead");
  const room = existingRoom(link.id) ?? roomForLink(link);
  await room.stopAll();
  dropRoom(link.id);
  q.deleteLink(link.id);
  q.pruneEmptyHolders();
  return guestJson(c, { ok: true });
});
