import { chmodSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createAdaptorServer, serve, type ServerType } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.ts";
import { logError } from "./log.ts";
import { closeStore, instanceId, isPaused, openStore } from "./store/db.ts";
import { disposeAllRooms, roomBySlug, startSweeper, stopSweeper } from "./core/rooms.ts";
import { isSlug } from "./core/aliasing.ts";
import { upstreamReachable } from "./upstream/rest.ts";
import { guest, SESSION_COOKIE } from "./routes/guest.ts";
import { create } from "./routes/create.ts";
import { holder } from "./routes/holder.ts";
import { manage } from "./routes/manage.ts";
import { pages } from "./routes/pages.ts";
import { GUEST_HEADERS, deadLinkPage, problem } from "./routes/http.ts";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

/**
 * Nothing here reads a large body. Creation carries a settings document for up
 * to MAX_SHOCKERS_PER_LINK shockers, which is the only reason anything above a
 * few kilobytes is allowed. Without this every unauthenticated endpoint would
 * buffer whatever arrived, and the bot check does not help: the body is parsed
 * before the challenge is verified.
 */
const CREATE_BODY_BYTES = 256 * 1024;
const DEFAULT_BODY_BYTES = 16 * 1024;
const CREATE_PATHS = new Set(["/api/links", "/api/links/inspect"]);
const READINESS_TTL_MS = 10_000;

export function buildApp(): Hono {
  const app = new Hono();

  const tooLarge = (c: Context): Response => problem(c, 413, "payload_too_large");
  const createLimit = bodyLimit({ maxSize: CREATE_BODY_BYTES, onError: tooLarge });
  const defaultLimit = bodyLimit({ maxSize: DEFAULT_BODY_BYTES, onError: tooLarge });
  app.use("*", (c, next) =>
    (CREATE_PATHS.has(c.req.path) ? createLimit : defaultLimit)(c, next),
  );

  app.use("*", async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(GUEST_HEADERS)) {
      if (!c.res.headers.has(k)) c.res.headers.set(k, v);
    }
    c.res.headers.delete("x-powered-by");
  });

  app.route("/", pages);
  app.route("/", create);
  app.route("/", holder);
  app.route("/", manage);
  app.route("/", guest);

  app.get("/assets/:file{.+}", (c) => {
    const file = c.req.param("file");
    // Flat names, plus vendor/ and vendor/fonts/ for the third-party assets.
    if (!/^(vendor\/(fonts\/)?)?[a-z0-9._-]+$/i.test(file) || file.includes("..")) {
      return c.notFound();
    }
    const path = normalize(join(publicDir, file));
    if (!path.startsWith(publicDir)) return c.notFound();

    let body: Buffer;
    try {
      body = readFileSync(path);
    } catch {
      return c.notFound();
    }

    const type = file.endsWith(".css")
      ? "text/css; charset=utf-8"
      : file.endsWith(".woff2")
        ? "font/woff2"
        : file.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "text/plain; charset=utf-8";
    return new Response(new Uint8Array(body), {
      headers: { "content-type": type, "cache-control": "public, max-age=300" },
    });
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  // Cached: every uncached hit is an outbound request, which makes an
  // unauthenticated probe endpoint into a way to generate upstream traffic.
  let readiness = { at: 0, reachable: false };
  app.get("/readyz", async (c) => {
    if (isPaused()) return c.json({ ok: false, reason: "paused" }, 503);
    const now = Date.now();
    if (now - readiness.at > READINESS_TTL_MS) {
      readiness = { at: now, reachable: await upstreamReachable() };
    }
    return readiness.reachable ? c.json({ ok: true }) : c.json({ ok: false, reason: "upstream" }, 503);
  });

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return new Response(JSON.stringify({ type: "not_found", status: 404 }), {
        status: 404,
        headers: { ...GUEST_HEADERS, "content-type": "application/problem+json; charset=utf-8" },
      });
    }
    return deadLinkPage(c);
  });

  app.onError((err) => {
    logError("unhandled_error", err instanceof Error ? err.name : "unknown");
    return new Response(JSON.stringify({ type: "server_error", status: 500 }), {
      status: 500,
      headers: { ...GUEST_HEADERS, "content-type": "application/problem+json; charset=utf-8" },
    });
  });

  return app;
}

/** Live feed: server to client only. Control never travels over this socket. */
function attachLiveFeed(server: ServerType): WebSocketServer {
  // The 64-character rule below is enforced after ws has buffered the frame, so
  // the frame itself has to be small: ws would otherwise accept 100 MiB first.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/api\/s\/([0-9A-Za-z]{11})\/live$/);
    if (!match || !isSlug(match[1])) {
      socket.destroy();
      return;
    }
    const slug = match[1]!;
    const room = roomBySlug(slug);
    if (!room || room.link.expiresAt <= Date.now()) {
      socket.destroy();
      return;
    }

    // A live socket requires a guest session for this link, so an unopened link
    // cannot be watched from outside.
    const cookies = req.headers.cookie ?? "";
    const raw = cookies
      .split(";")
      .map((part: string) => part.trim())
      .find((part: string) => part.startsWith(`${SESSION_COOKIE}=`));
    const value = raw?.slice(SESSION_COOKIE.length + 1) ?? "";
    if (!value.startsWith(`${slug}.`) || !room.getSession(value.slice(slug.length + 1))) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const live = {
        send: (data: string) => ws.send(data),
        close: () => ws.close(),
      };
      if (!room.addSocket(live)) {
        ws.close();
        return;
      }
      ws.on("message", (data: unknown) => {
        // The only accepted client frame is a ping.
        if (String(data).length > 64) ws.close();
      });
      ws.on("close", () => room.removeSocket(live));
      ws.on("error", () => room.removeSocket(live));
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    ws.on("error", () => ws.close());
  });

  return wss;
}

export function start(): { server: ServerType; close: () => Promise<void> } {
  openStore();
  instanceId();
  startSweeper();

  const app = buildApp();
  let server: ServerType;
  if (config.socketPath) {
    try {
      const existing = lstatSync(config.socketPath);
      if (!existing.isSocket()) throw new Error(`SOCKET_PATH exists and is not a socket: ${config.socketPath}`);
      unlinkSync(config.socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    server = createAdaptorServer({ fetch: app.fetch });
    server.listen(config.socketPath, () => chmodSync(config.socketPath, 0o666));
  } else {
    server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" });
  }
  const wss = attachLiveFeed(server);

  const close = async (): Promise<void> => {
    stopSweeper();
    disposeAllRooms();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (config.socketPath) {
      try {
        unlinkSync(config.socketPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    closeStore();
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void close().then(() => process.exit(0));
    });
  }

  return { server, close };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  start();
}
