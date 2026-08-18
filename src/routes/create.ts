import { Hono } from "hono";
import type { Context } from "hono";
import { config, botCheckAvailable } from "../config.ts";
import { isPaused } from "../store/db.ts";
import * as q from "../store/queries.ts";
import { newToken, tokenHash } from "../store/crypto.ts";
import {
  CreateError,
  createLink,
  inspectDevices,
  inspectShare,
  loadShare,
  loadTokenDevices,
  parseShareId,
  validateSettings,
  validateToken,
  type CreateSettings,
  type InspectedDevice,
} from "../core/links.ts";
import { defaultDeviceName, defaultShockerName } from "../core/aliasing.ts";
import { WindowCounter } from "../core/limits.ts";
import { roomForLink } from "../core/rooms.ts";
import { verifyAltcha } from "../core/altcha.ts";
import { UpstreamError } from "../upstream/rest.ts";
import { clientIpHash, cookie, guestJson, problem, readCookie } from "./http.ts";

export const HOLDER_COOKIE = "__Host-as_holder";

const inspectLimiter = new WindowCounter(3_600_000, 20);
const createLimiter = new WindowCounter(86_400_000, config.maxLinksPerIpPerDay);

export const create = new Hono();

/** Resolves the holder from the cookie, or mints one. */
export function resolveHolder(c: Context): { holderId: string; recovery: string; newHolder: boolean } {
  const raw = readCookie(c, HOLDER_COOKIE);
  if (raw) {
    const found = q.findHolderByHash(tokenHash(raw));
    if (found) {
      q.touchHolder(found);
      return { holderId: found, recovery: raw, newHolder: false };
    }
  }
  const token = newToken();
  const holderId = q.createHolder(tokenHash(token));
  return { holderId, recovery: token, newHolder: true };
}

/* ---------------------------------------------------------------- inspect */

create.post("/api/links/inspect", async (c) => {
  if (isPaused()) return problem(c, 503, "instance_paused");
  if (!inspectLimiter.check(clientIpHash(c))) {
    return problem(c, 429, "rate_limited", { retryAfter: 3600 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return problem(c, 400, "invalid_request");
  }

  const mode = body["mode"] === "token" ? "token" : "share";
  const base =
    typeof body["upstreamBase"] === "string" && body["upstreamBase"].startsWith("https://")
      ? body["upstreamBase"]
      : config.upstreamBase;

  if (botCheckAvailable()) {
    const solution = typeof body["altcha"] === "string" ? body["altcha"] : "";
    if (!(await verifyAltcha(solution))) return problem(c, 401, "invalid_bot_check");
  }

  try {
    if (mode === "share") {
      const shareUrl = typeof body["shareUrl"] === "string" ? body["shareUrl"] : "";
      const share = await loadShare(shareUrl, base);
      const devices = inspectShare(share);
      return c.json({ mode, devices: withDefaults(devices) });
    }

    if (!config.allowTokenMode) return problem(c, 403, "token_mode_disabled");
    const token = typeof body["token"] === "string" ? body["token"] : "";
    if (!token) return problem(c, 400, "invalid_request");
    await validateToken(token, base);
    const devices = inspectDevices(await loadTokenDevices(token, base));
    if (devices.length === 0) return problem(c, 400, "no_shockers");
    return c.json({ mode, devices: withDefaults(devices) });
  } catch (err) {
    return inspectError(c, err, mode);
  }
});

function withDefaults(devices: InspectedDevice[]): unknown[] {
  let shockerIndex = 0;
  return devices.map((d, i) => ({
    upstreamId: d.upstreamId,
    upstreamName: d.name,
    suggestedName: defaultDeviceName(i),
    shockers: d.shockers.map((s) => ({
      upstreamId: s.upstreamId,
      upstreamName: s.name,
      suggestedName: defaultShockerName(shockerIndex++),
      upstreamMaxIntensity: s.maxIntensity,
      upstreamMaxDuration: s.maxDuration,
      upstreamAllowShock: s.allowShock,
      upstreamAllowVibrate: s.allowVibrate,
      upstreamAllowSound: s.allowSound,
    })),
  }));
}

function inspectError(c: Context, err: unknown, mode: "share" | "token" = "share"): Response {
  if (err instanceof CreateError) return problem(c, err.status, err.type, err.field ? { field: err.field } : {});
  if (err instanceof UpstreamError) {
    if (err.kind === "not_found" && mode === "share") return problem(c, 400, "invalid_share");
    if (err.kind === "unauthorized" || err.kind === "forbidden") return problem(c, 400, "invalid_token");
    return problem(c, 503, "upstream_unreachable");
  }
  return problem(c, 400, "invalid_request");
}

/* ----------------------------------------------------------------- create */

create.post("/api/links", async (c) => {
  if (isPaused()) return problem(c, 503, "instance_paused");
  if (!createLimiter.check(clientIpHash(c))) {
    return problem(c, 429, "too_many_links", { retryAfter: 3600 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return problem(c, 400, "invalid_request");
  }

  const acks = (body["acknowledgements"] ?? {}) as Record<string, unknown>;
  if (acks["limitsReviewed"] !== true || acks["aliasesArePublic"] !== true || acks["manageLinkSaved"] !== true) {
    return problem(c, 400, "incomplete_settings", { field: "acknowledgements" });
  }

  const mode = body["mode"] === "token" ? "token" : "share";
  if (mode === "token" && !config.allowTokenMode) return problem(c, 403, "token_mode_disabled");

  const base =
    typeof body["upstreamBase"] === "string" && body["upstreamBase"].startsWith("https://")
      ? body["upstreamBase"]
      : config.upstreamBase;

  if (botCheckAvailable()) {
    const solution = typeof body["altcha"] === "string" ? body["altcha"] : "";
    if (!(await verifyAltcha(solution))) return problem(c, 401, "invalid_bot_check");
  }

  const settings = body["settings"] as CreateSettings | undefined;
  if (!settings || typeof settings !== "object") {
    return problem(c, 400, "incomplete_settings", { field: "settings" });
  }

  try {
    let discovered: InspectedDevice[];
    let shareId: string | undefined;
    let upstreamToken: string | undefined;
    if (mode === "share") {
      const shareUrl = typeof body["shareUrl"] === "string" ? body["shareUrl"] : "";
      if (!shareUrl) return problem(c, 400, "invalid_share");
      shareId = parseShareId(shareUrl);
      discovered = inspectShare(await loadShare(shareId, base));
    } else {
      const token = typeof body["token"] === "string" ? body["token"] : "";
      if (!token) return problem(c, 400, "invalid_token");
      await validateToken(token, base);
      upstreamToken = token;
      discovered = inspectDevices(await loadTokenDevices(token, base));
      if (discovered.length === 0) return problem(c, 400, "no_shockers");
    }

    validateSettings(settings, discovered);

    const holder = resolveHolder(c);
    const input: Parameters<typeof createLink>[0] = {
      mode,
      holderId: holder.holderId,
      upstreamBase: base,
      settings,
      discovered,
    };
    if (shareId) input.upstreamShareId = shareId;
    if (upstreamToken) input.upstreamToken = upstreamToken;

    let created;
    try {
      created = createLink(input);
    } catch (err) {
      // A holder minted for a creation that failed owns nothing; drop it rather
      // than leaving a row for the sweeper to find later.
      if (holder.newHolder) q.deleteHolder(holder.holderId);
      throw err;
    }
    roomForLink(created.link);

    const payload: Record<string, unknown> = {
      slug: created.slug,
      guestUrl: `${config.publicOrigin}/s/${created.slug}`,
      manageUrl: `${config.publicOrigin}/m/${created.manageToken}`,
      expiresAt: created.link.expiresAt,
    };
    payload["recovery"] = `as1_${holder.recovery}`;

    const res = guestJson(c, payload, 201);
    if (holder.newHolder) {
      res.headers.append(
        "set-cookie",
        cookie(HOLDER_COOKIE, holder.recovery, config.holderCookieDays * 86_400),
      );
    }
    return res;
  } catch (err) {
    if (err instanceof CreateError) {
      return problem(c, err.status, err.type, err.field ? { field: err.field } : {});
    }
    return inspectError(c, err, mode);
  }
});
