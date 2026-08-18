import { Hono } from "hono";
import { config, HARD, botCheckAvailable } from "../config.ts";
import { isPaused } from "../store/db.ts";
import { roomBySlug } from "../core/rooms.ts";
import { verifyGuestPassword } from "../core/links.ts";
import { isShockerAlias, isSlug } from "../core/aliasing.ts";
import { WindowCounter } from "../core/limits.ts";
import { verifyAltcha } from "../core/altcha.ts";
import {
  clientIpHash,
  cookie,
  deadLinkPage,
  escapeHtml,
  guestJson,
  html,
  page,
  problem,
  readCookie,
} from "./http.ts";
import type { ControlCommand, ControlType } from "../types.ts";
import { CONTROL_TYPES } from "../types.ts";

export const SESSION_COOKIE = "__Host-as_sess";
const SESSION_TTL_SECONDS = 2 * 60 * 60;

const viewLimiter = new WindowCounter(60_000, 60);
const sessionLimiter = new WindowCounter(600_000, config.maxSessionsPerIpPer10Min);

export const guest = new Hono();

/* ------------------------------------------------------------- maintenance */

guest.use("/api/s/*", async (c, next) => {
  if (isPaused() && c.req.method !== "GET") {
    // Stop is still deliverable while paused; the room enforces that.
    if (!c.req.path.endsWith("/control")) return problem(c, 503, "instance_paused");
  }
  await next();
});

/* ------------------------------------------------------------- the page */

guest.get("/s/:slug", (c) => {
  const slug = c.req.param("slug");
  if (!isSlug(slug)) return deadLinkPage(c);
  const room = roomBySlug(slug);
  if (!room || room.link.expiresAt <= Date.now()) return deadLinkPage(c);

  const botCheck = room.link.requireBotCheck && botCheckAvailable();
  const body = `
<h1 id="link-title">${escapeHtml(room.link.title)}</h1>
<p class="author">Shared by ${escapeHtml(room.link.authorText)}</p>
<div id="app" data-slug="${escapeHtml(slug)}"${botCheck ? ' data-botcheck="1"' : ""}>
  <p>Loading controls...</p>
</div>
<noscript><p>This page needs JavaScript to send commands.</p></noscript>`;
  return html(c, page(room.link.title, body, { script: "/assets/guest.js" }));
});

/* -------------------------------------------------------------- the view */

guest.get("/api/s/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isSlug(slug)) return problem(c, 404, "link_dead");
  if (!viewLimiter.check(clientIpHash(c))) return problem(c, 429, "rate_limited", { retryAfter: 60 });

  const room = roomBySlug(slug);
  if (!room || room.link.expiresAt <= Date.now()) return problem(c, 404, "link_dead");

  const view = await room.view();
  return guestJson(c, view);
});

/* ----------------------------------------------------------- the session */

guest.post("/api/s/:slug/session", async (c) => {
  const slug = c.req.param("slug");
  if (!isSlug(slug)) return problem(c, 404, "link_dead");
  const ip = clientIpHash(c);
  if (!sessionLimiter.check(ip)) return problem(c, 429, "rate_limited", { retryAfter: 600 });

  const room = roomBySlug(slug);
  if (!room || room.link.expiresAt <= Date.now()) return problem(c, 404, "link_dead");

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (room.link.requireBotCheck && botCheckAvailable()) {
    const solution = typeof body["altcha"] === "string" ? body["altcha"] : "";
    if (!(await verifyAltcha(solution))) return problem(c, 401, "invalid_bot_check");
  }

  if (room.link.guestPasswordHash) {
    const password = typeof body["password"] === "string" ? body["password"] : "";
    if (!verifyGuestPassword(room.link.guestPasswordHash, password)) {
      return problem(c, 401, "invalid_password");
    }
  }

  const session = room.createSession();
  const res = guestJson(c, { pseudonym: session.pseudonym, expiresIn: SESSION_TTL_SECONDS });
  res.headers.append("set-cookie", cookie(SESSION_COOKIE, `${slug}.${session.id}`, SESSION_TTL_SECONDS));
  return res;
});

/* ----------------------------------------------------------- the control */

function parseCommands(input: unknown): ControlCommand[] | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as Record<string, unknown>)["commands"];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) return null;

  const seen = new Set<string>();
  const out: ControlCommand[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const o = item as Record<string, unknown>;
    const alias = o["alias"];
    const type = o["type"];
    const intensity = o["intensity"];
    const duration = o["duration"];

    if (!isShockerAlias(alias) || seen.has(alias)) return null;
    if (typeof type !== "string" || !CONTROL_TYPES.includes(type as ControlType)) return null;
    if (!Number.isInteger(intensity) || (intensity as number) < HARD.minIntensity) return null;
    if ((intensity as number) > HARD.maxIntensity) return null;
    if (!Number.isInteger(duration) || (duration as number) < HARD.minDuration) return null;
    if ((duration as number) > HARD.maxDuration) return null;

    seen.add(alias);
    out.push({
      alias,
      type: type as ControlType,
      intensity: intensity as number,
      duration: duration as number,
      exclusive: false,
    });
  }
  return out;
}

guest.post("/api/s/:slug/control", async (c) => {
  const slug = c.req.param("slug");
  if (!isSlug(slug)) return problem(c, 404, "link_dead");

  const room = roomBySlug(slug);
  if (!room || room.link.expiresAt <= Date.now()) return problem(c, 410, "link_dead");

  const raw = readCookie(c, SESSION_COOKIE);
  const sessionId = raw && raw.startsWith(`${slug}.`) ? raw.slice(slug.length + 1) : undefined;
  const session = room.getSession(sessionId);
  if (!session) return problem(c, 401, "session_required");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return problem(c, 400, "invalid_command");
  }
  const commands = parseCommands(body);
  if (!commands) return problem(c, 400, "invalid_command");

  const result = await room.dispatch(session, commands);
  if (!result.ok) {
    const extra: Record<string, unknown> = {};
    if (result.retryAfter !== undefined) extra["retryAfter"] = result.retryAfter;
    return problem(c, result.status, result.type, extra);
  }
  return guestJson(c, { ok: true, applied: result.applied });
});
