import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockUpstream, SENTINEL, type MockUpstream } from "./mock-upstream.ts";

/** Environment must be set before any module reads config. */
export function prepareEnv(upstreamUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "anonshock-test-"));
  const dbPath = join(dir, "test.db");
  process.env["NODE_ENV"] = "test";
  process.env["DB_PATH"] = dbPath;
  process.env["PUBLIC_ORIGIN"] = "https://test.example";
  process.env["UPSTREAM_BASE"] = upstreamUrl;
  process.env["APP_VERSION"] = "0.1-test";
  process.env["STORE_KEY"] = Buffer.alloc(32, 7).toString("base64");
  process.env["TOKEN_PEPPER"] = Buffer.alloc(32, 9).toString("base64");
  process.env["LOG_LEVEL"] = "off";
  process.env["ALTCHA_HMAC_KEY"] = "";
  process.env["MAX_LINKS_PER_IP_PER_DAY"] = "10000";
  process.env["MAX_SESSIONS_PER_IP_PER_10MIN"] = "10000";
  return dbPath;
}

export interface Harness {
  upstream: MockUpstream;
  fetch: (path: string, init?: RequestInit & { cookies?: string[] }) => Promise<TestResponse>;
  close: () => Promise<void>;
  dbPath: string;
}

export interface TestResponse {
  status: number;
  text: string;
  json: unknown;
  headers: Headers;
  cookies: string[];
}

export async function startHarness(): Promise<Harness> {
  const upstream = await startMockUpstream();
  const dbPath = prepareEnv(upstream.url);

  const { openStore, closeStore } = await import("../src/store/db.ts");
  const { buildApp } = await import("../src/server.ts");
  const { disposeAllRooms } = await import("../src/core/rooms.ts");
  openStore(dbPath);
  const app = buildApp();

  const call = async (
    path: string,
    init: RequestInit & { cookies?: string[] } = {},
  ): Promise<TestResponse> => {
    const headers = new Headers(init.headers);
    if (init.cookies?.length) headers.set("cookie", init.cookies.join("; "));
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    headers.set("cf-connecting-ip", headers.get("cf-connecting-ip") ?? "203.0.113.7");

    const res = await app.fetch(new Request(`https://test.example${path}`, { ...init, headers }));
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return {
      status: res.status,
      text,
      json: parsed,
      headers: res.headers,
      cookies: res.headers.getSetCookie(),
    };
  };

  return {
    upstream,
    fetch: call,
    dbPath,
    close: async () => {
      disposeAllRooms();
      closeStore();
      await upstream.close();
      rmSync(dbPath, { force: true });
      rmSync(dbPath + "-wal", { force: true });
      rmSync(dbPath + "-shm", { force: true });
    },
  };
}

export function cookieValue(cookies: string[], name: string): string | undefined {
  for (const c of cookies) {
    if (c.startsWith(`${name}=`)) return c.slice(name.length + 1).split(";")[0];
  }
  return undefined;
}

/** A complete, valid create payload: every setting stated. */
export function createPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "share",
    shareUrl: `https://openshock.app/public/shares/links/${SENTINEL.shareId}`,
    settings: {
      title: "Shared controls",
      author: "Anonymous",
      ttlSeconds: 3600,
      requireBotCheck: false,
      guestPassword: null,
      rateLimitPerMin: 60,
      linkRateLimitPerMin: 120,
      devices: [
        {
          upstreamId: SENTINEL.hubId,
          displayName: "Hub 1",
          shockers: [
            {
              upstreamId: SENTINEL.shockerAId,
              displayName: "Shocker A",
              maxIntensity: 30,
              maxDuration: 3000,
              cooldownMs: 0,
              allowShock: true,
              allowVibrate: true,
              allowSound: true,
              hidden: false,
            },
            {
              upstreamId: SENTINEL.shockerBId,
              displayName: "Shocker B",
              maxIntensity: 20,
              maxDuration: 1000,
              cooldownMs: 0,
              allowShock: false,
              allowVibrate: true,
              allowSound: false,
              hidden: false,
            },
          ],
        },
      ],
    },
    acknowledgements: { limitsReviewed: true, aliasesArePublic: true, manageLinkSaved: true },
    ...overrides,
  };
}

export { SENTINEL };
