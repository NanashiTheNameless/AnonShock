import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startMockUpstream, SENTINEL, type MockUpstream } from "./mock-upstream.ts";

/**
 * Everything here runs against a real server on a real Unix socket, which is
 * how production listens. The rest of the suite drives `app.fetch` directly and
 * so never touches the HTTP adaptor, the upgrade handler, or the live feed.
 */

const SHARE_URL = `https://openshock.app/s/${SENTINEL.shareId}`;

let upstream: MockUpstream;
let dir: string;
let socketPath: string;
let stop: () => Promise<void>;

interface Res {
  status: number;
  text: string;
  setCookie: string[];
}

function call(
  path: string,
  opts: { method?: string; body?: unknown; raw?: string; cookie?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.cookie) headers["cookie"] = opts.cookie;
    const req = request(
      { socketPath, path, method: opts.method ?? "GET", headers },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text,
            setCookie: res.headers["set-cookie"] ?? [],
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.raw !== undefined) req.write(opts.raw);
    else if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

async function makeLink(title = "Live test"): Promise<{ slug: string; alias: string }> {
  const inspected = await call("/api/links/inspect", {
    method: "POST",
    body: { mode: "share", shareUrl: SHARE_URL },
  });
  assert.equal(inspected.status, 200);
  const devices = (JSON.parse(inspected.text) as { devices: any[] }).devices;

  const created = await call("/api/links", {
    method: "POST",
    body: {
      mode: "share",
      shareUrl: SHARE_URL,
      acknowledgements: { limitsReviewed: true, aliasesArePublic: true, manageLinkSaved: true },
      settings: {
        title,
        author: "Tester",
        ttlSeconds: 3600,
        requireBotCheck: false,
        guestPassword: null,
        rateLimitPerMin: 120,
        linkRateLimitPerMin: 600,
        devices: devices.map((d) => ({
          upstreamId: d.upstreamId,
          displayName: d.suggestedName,
          shockers: d.shockers.map((s: any) => ({
            upstreamId: s.upstreamId,
            displayName: s.suggestedName,
            maxIntensity: Math.min(s.upstreamMaxIntensity, 50),
            maxDuration: Math.min(s.upstreamMaxDuration, 5000),
            cooldownMs: 0,
            allowShock: s.upstreamAllowShock,
            allowVibrate: s.upstreamAllowVibrate,
            allowSound: s.upstreamAllowSound,
            hidden: false,
          })),
        })),
      },
    },
  });
  assert.equal(created.status, 201);
  const slug = (JSON.parse(created.text) as { slug: string }).slug;

  const view = await call(`/api/s/${slug}`);
  const alias = (JSON.parse(view.text) as any).devices[0].shockers[0].alias;
  return { slug, alias };
}

async function openSession(slug: string): Promise<string> {
  const res = await call(`/api/s/${slug}/session`, { method: "POST", body: {} });
  assert.equal(res.status, 200);
  const cookie = res.setCookie
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith("__Host-as_sess="));
  assert.ok(cookie);
  return cookie;
}

function liveSocket(slug: string, cookie?: string): WebSocket {
  return new WebSocket(`ws+unix://${socketPath}:/api/s/${slug}/live`, {
    headers: cookie ? { cookie } : {},
  });
}

before(async () => {
  upstream = await startMockUpstream();
  dir = mkdtempSync(join(tmpdir(), "anonshock-live-"));
  socketPath = join(dir, "s.sock");
  process.env["NODE_ENV"] = "test";
  process.env["DB_PATH"] = join(dir, "test.db");
  process.env["SOCKET_PATH"] = socketPath;
  process.env["PUBLIC_ORIGIN"] = "http://localhost:8080";
  process.env["UPSTREAM_BASE"] = upstream.url;
  process.env["APP_VERSION"] = "0.1-test";
  process.env["STORE_KEY"] = Buffer.alloc(32, 7).toString("base64");
  process.env["TOKEN_PEPPER"] = Buffer.alloc(32, 9).toString("base64");
  process.env["LOG_LEVEL"] = "off";
  process.env["ALTCHA_HMAC_KEY"] = "";
  process.env["MAX_LINKS_PER_IP_PER_DAY"] = "10000";
  process.env["MAX_SESSIONS_PER_IP_PER_10MIN"] = "10000";

  const { start } = await import("../src/server.ts");
  stop = start().close;
  await new Promise((r) => setTimeout(r, 200));
});

after(async () => {
  await stop();
  await upstream.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("live server", () => {
  it("serves over a Unix socket", async () => {
    const health = await call("/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.text, '{"ok":true}');

    const asset = await call("/assets/app.css");
    assert.equal(asset.status, 200);

    const missing = await call("/api/nope");
    assert.equal(missing.status, 404);
  });

  it("refuses a live socket that carries no session", async () => {
    const { slug } = await makeLink();
    const ws = liveSocket(slug);
    const outcome = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("opened"));
      ws.on("error", () => resolve("refused"));
      setTimeout(() => resolve("hung"), 2000);
    });
    ws.close();
    assert.equal(outcome, "refused");
  });

  it("upgrades a live socket that carries one, and broadcasts control on it", async () => {
    const { slug, alias } = await makeLink();
    const cookie = await openSession(slug);
    const ws = liveSocket(slug, cookie);
    const frames: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data) => {
        frames.push(String(data));
        resolve();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("no state frame")), 3000);
    });
    assert.match(frames[0]!, /"t":"state"/);

    const activity = new Promise<string>((resolve) => {
      ws.on("message", (data) => {
        if (String(data).includes('"t":"activity"')) resolve(String(data));
      });
      setTimeout(() => resolve("none"), 3000);
    });
    const sent = await call(`/api/s/${slug}/control`, {
      method: "POST",
      cookie,
      body: { commands: [{ alias, type: "Vibrate", intensity: 10, duration: 1000 }] },
    });
    assert.equal(sent.status, 200);
    const frame = await activity;
    assert.match(frame, /"type":"Vibrate"/);
    assert.match(frame, new RegExp(`"alias":"${alias}"`));
    ws.close();
  });

  it("closes a live socket that sends an oversized frame", async () => {
    const { slug } = await makeLink();
    const cookie = await openSession(slug);
    const ws = liveSocket(slug, cookie);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    const closed = new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
      setTimeout(() => resolve(0), 3000);
    });
    ws.send("x".repeat(64 * 1024));
    // 1009 is "message too big": ws refuses the frame instead of buffering it.
    assert.equal(await closed, 1009);
  });

  it("coalesces a repeated stop into one upstream invocation", async () => {
    const { slug, alias } = await makeLink();
    const cookie = await openSession(slug);
    const before = upstream.state.hubInvocations.length;
    const stopCommand = {
      commands: [{ alias, type: "Stop", intensity: 0, duration: 300 }],
    };
    for (let i = 0; i < 5; i++) {
      const res = await call(`/api/s/${slug}/control`, {
        method: "POST",
        cookie,
        body: stopCommand,
      });
      // A stop is never refused, coalesced or not.
      assert.equal(res.status, 200);
    }
    assert.equal(upstream.state.hubInvocations.length - before, 1);
  });

  it("rejects a body past the limit instead of buffering it", async () => {
    const huge = JSON.stringify({ mode: "share", shareUrl: "x".repeat(512 * 1024) });
    const res = await call("/api/links/inspect", { method: "POST", raw: huge });
    assert.equal(res.status, 413);

    const { slug } = await makeLink();
    const smaller = JSON.stringify({ password: "y".repeat(32 * 1024) });
    const session = await call(`/api/s/${slug}/session`, { method: "POST", raw: smaller });
    assert.equal(session.status, 413);
  });

  it("prints the CSP nonce once, never into page text", async () => {
    // A title that contains the placeholder must not be handed the live nonce.
    const { slug } = await makeLink("__CSP_NONCE__");
    const page = await call(`/s/${slug}`);
    assert.equal(page.status, 200);

    const nonce = page.text.match(/<meta name="csp-nonce" content="([^"]+)">/)?.[1];
    assert.ok(nonce && nonce.length > 0);
    assert.equal(page.text.split(nonce).length - 1, 1);
    assert.doesNotMatch(page.text, /__CSP_NONCE__/);
  });
});
