import { Hono } from "hono";
import type { Context } from "hono";
import { config } from "../config.ts";
import { isPaused } from "../store/db.ts";
import * as q from "../store/queries.ts";
import { newToken, tokenHash } from "../store/crypto.ts";
import { dropRoom, existingRoom, roomForLink } from "../core/rooms.ts";
import { HOLDER_COOKIE } from "./create.ts";
import { clearCookie, cookie, guestJson, html, page, problem, readCookie } from "./http.ts";
import { WindowCounter } from "../core/limits.ts";

const manageUrlLimiter = new WindowCounter(3_600_000, 10);

export const holder = new Hono();

function holderId(c: Context): string | null {
  const raw = readCookie(c, HOLDER_COOKIE);
  if (!raw) return null;
  return q.findHolderByHash(tokenHash(raw));
}

/* ------------------------------------------------------------- the page */

holder.get("/links", (c) => {
  const id = holderId(c);
  const body = id
    ? `<h1>Your links</h1>
       <p class="note">Known only to this browser. There is no account, no email, and no password to recover.</p>
       <div id="links" data-holder="1"><p>Loading...</p></div>
       <section>
         <h2>Move access to another browser</h2>
         <form id="import-form">
           <label for="recovery">Recovery string</label>
           <input id="recovery" name="recovery" type="text" autocomplete="off" placeholder="as1_...">
           <button type="submit">Import</button>
         </form>
         <button id="rotate" type="button">Rotate my access token</button>
         <button id="cancel-all" type="button" class="danger">Cancel all of my links</button>
       </section>`
    : `<h1>Your links</h1>
       <p>This browser does not hold an access token, so there is nothing to show here.</p>
       <section>
         <h2>Have a recovery string?</h2>
         <form id="import-form">
           <label for="recovery">Recovery string</label>
           <input id="recovery" name="recovery" type="text" autocomplete="off" placeholder="as1_...">
           <button type="submit">Import</button>
         </form>
       </section>
       <p><a href="/new">Make a link</a></p>`;
  return html(c, page("Your links", body, { script: "/assets/links.js" }));
});

/* ---------------------------------------------------------------- the API */

holder.get("/api/holder/links", (c) => {
  const id = holderId(c);
  if (!id) return problem(c, 401, "no_holder");
  q.touchHolder(id);

  const links = q.listLinksForHolder(id).map((link) => {
    const room = existingRoom(link.id);
    return {
      id: link.id,
      slug: link.slug,
      title: link.title,
      status: link.expiresAt <= Date.now() ? "expired" : link.status,
      expiresAt: link.expiresAt,
      shockerCount: link.shockers.filter((s) => !s.hidden).length,
      guests: room ? room.guestCount : 0,
      guestUrl: `${config.publicOrigin}/s/${link.slug}`,
    };
  });
  return guestJson(c, { links });
});

/**
 * Issues a fresh manage token for one of this holder's links. This is the only
 * way to recover a manage URL that was not saved at creation.
 */
holder.get("/api/holder/links/:id/manage-url", (c) => {
  const id = holderId(c);
  if (!id) return problem(c, 401, "no_holder");
  if (!manageUrlLimiter.check(id)) return problem(c, 429, "rate_limited", { retryAfter: 3600 });

  const link = q.getLinkById(c.req.param("id"));
  if (!link || link.holderId !== id) return problem(c, 404, "link_dead");

  const token = newToken();
  q.setManageTokenHash(link.id, tokenHash(token));
  return guestJson(c, { manageUrl: `${config.publicOrigin}/m/${token}` });
});

holder.post("/api/holder/links/:id/pause", async (c) => {
  const id = holderId(c);
  if (!id) return problem(c, 401, "no_holder");
  const link = q.getLinkById(c.req.param("id"));
  if (!link || link.holderId !== id || link.expiresAt <= Date.now()) {
    return problem(c, 404, "link_dead");
  }
  if (link.status === "killed") return guestJson(c, { ok: true, status: "killed" });
  if (link.status !== "active") return problem(c, 409, "not_pausable", { status: link.status });

  const room = existingRoom(link.id) ?? roomForLink(link);
  await room.kill();
  return guestJson(c, { ok: true, status: "killed" });
});

holder.post("/api/holder/links/:id/resume", (c) => {
  if (isPaused()) return problem(c, 503, "instance_paused");
  const id = holderId(c);
  if (!id) return problem(c, 401, "no_holder");
  const link = q.getLinkById(c.req.param("id"));
  if (!link || link.holderId !== id || link.expiresAt <= Date.now()) {
    return problem(c, 404, "link_dead");
  }

  const room = existingRoom(link.id) ?? roomForLink(link);
  if (!room.resume()) return problem(c, 409, "not_resumable", { status: link.status });
  return guestJson(c, { ok: true, status: "active" });
});

holder.post("/api/holder/import", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return problem(c, 400, "invalid_request");
  }
  const raw = typeof body["recovery"] === "string" ? body["recovery"].trim() : "";
  const token = raw.startsWith("as1_") ? raw.slice(4) : raw;
  if (!token) return problem(c, 400, "invalid_request");

  const found = q.findHolderByHash(tokenHash(token));
  if (!found) return problem(c, 401, "invalid_recovery");

  const res = guestJson(c, { ok: true });
  res.headers.append("set-cookie", cookie(HOLDER_COOKIE, token, config.holderCookieDays * 86_400));
  return res;
});

holder.post("/api/holder/rotate", (c) => {
  const id = holderId(c);
  if (!id) return problem(c, 401, "no_holder");

  const token = newToken();
  q.rotateHolderToken(id, tokenHash(token));
  const res = guestJson(c, { recovery: `as1_${token}` });
  res.headers.append("set-cookie", cookie(HOLDER_COOKIE, token, config.holderCookieDays * 86_400));
  return res;
});

holder.delete("/api/holder", async (c) => {
  const id = holderId(c);
  if (!id) return problem(c, 401, "no_holder");

  for (const link of q.listLinksForHolder(id)) {
    const room = existingRoom(link.id) ?? roomForLink(link);
    await room.stopAll();
    dropRoom(link.id);
    q.deleteLink(link.id);
  }
  q.deleteHolder(id);

  const res = guestJson(c, { ok: true });
  res.headers.append("set-cookie", clearCookie(HOLDER_COOKIE));
  return res;
});
