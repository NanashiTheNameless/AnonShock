import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockUpstream, SENTINEL, type MockUpstream } from "./mock-upstream.ts";

/**
 * The bot check is self hosted: this instance issues the challenge and verifies
 * the solution, so these tests cover the whole loop with no third party.
 */

let upstream: MockUpstream;
let dbPath: string;
let app: { fetch: (req: Request) => Promise<Response> };
let altcha: typeof import("../src/core/altcha.ts");
let lib: typeof import("altcha-lib");
let pbkdf2: typeof import("altcha-lib/algorithms/pbkdf2");

before(async () => {
  upstream = await startMockUpstream();
  const dir = mkdtempSync(join(tmpdir(), "anonshock-altcha-"));
  dbPath = join(dir, "test.db");
  process.env["NODE_ENV"] = "test";
  process.env["DB_PATH"] = dbPath;
  process.env["PUBLIC_ORIGIN"] = "https://test.example";
  process.env["UPSTREAM_BASE"] = upstream.url;
  process.env["APP_VERSION"] = "0.1-test";
  process.env["STORE_KEY"] = Buffer.alloc(32, 7).toString("base64");
  process.env["TOKEN_PEPPER"] = Buffer.alloc(32, 9).toString("base64");
  process.env["LOG_LEVEL"] = "off";
  process.env["MAX_LINKS_PER_IP_PER_DAY"] = "10000";
  process.env["MAX_SESSIONS_PER_IP_PER_10MIN"] = "10000";
  // The key being set is what turns the check on.
  process.env["ALTCHA_HMAC_KEY"] = "test-altcha-key";
  process.env["ALTCHA_COST"] = "500";

  const { openStore } = await import("../src/store/db.ts");
  openStore(dbPath);
  altcha = await import("../src/core/altcha.ts");
  lib = await import("altcha-lib");
  pbkdf2 = await import("altcha-lib/algorithms/pbkdf2");
  const { buildApp } = await import("../src/server.ts");
  app = buildApp();
});

after(async () => {
  const { closeStore } = await import("../src/store/db.ts");
  const { disposeAllRooms } = await import("../src/core/rooms.ts");
  disposeAllRooms();
  closeStore();
  await upstream.close();
  rmSync(dbPath, { force: true });
});

/**
 * Solves with the official library and encodes the payload exactly as the v3
 * widget does: { challenge: { parameters, signature }, solution }.
 */
async function payloadFor(challenge: Awaited<ReturnType<typeof altcha.createChallenge>>): Promise<string> {
  const solution = await lib.solveChallenge({ challenge, deriveKey: pbkdf2.deriveKey });
  assert.ok(solution, "the challenge must be solvable");
  return Buffer.from(
    JSON.stringify({
      challenge: { parameters: challenge.parameters, signature: challenge.signature },
      solution,
    }),
  ).toString("base64");
}

async function solve(): Promise<string> {
  return payloadFor(await altcha.createChallenge());
}

async function call(path: string, init: RequestInit & { cookies?: string[] } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookies?.length) headers.set("cookie", init.cookies.join("; "));
  if (init.body) headers.set("content-type", "application/json");
  headers.set("cf-connecting-ip", "203.0.113.9");
  const res = await app.fetch(new Request(`https://test.example${path}`, { ...init, headers }));
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json, cookies: res.headers.getSetCookie() };
}

function payload(solution?: string) {
  const body: Record<string, unknown> = {
    mode: "share",
    shareUrl: `https://openshock.app/public/shares/links/${SENTINEL.shareId}`,
    settings: {
      title: "Shared controls",
      author: "Anonymous",
      ttlSeconds: 3600,
      requireBotCheck: true,
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
  };
  if (solution) body["altcha"] = solution;
  return JSON.stringify(body);
}

describe("altcha challenge", () => {
  it("issues a signed v3 challenge", async () => {
    const res = await call("/api/altcha/challenge");
    assert.equal(res.status, 200);
    const challenge = res.json as any;
    assert.equal(challenge.parameters.algorithm, "PBKDF2/SHA-256");
    assert.equal(challenge.parameters.cost, 500);
    assert.ok(challenge.parameters.salt && challenge.parameters.nonce);
    assert.ok(challenge.parameters.expiresAt > Math.floor(Date.now() / 1000));
    assert.ok(typeof challenge.signature === "string" && challenge.signature.length > 0);
  });

  it("accepts a correct solution and rejects everything else", async () => {
    assert.equal(await altcha.verifyAltcha(await solve()), true);

    assert.equal(await altcha.verifyAltcha(""), false);
    assert.equal(await altcha.verifyAltcha("not-base64-json"), false);

    const challenge = await altcha.createChallenge();
    const solution = await lib.solveChallenge({ challenge, deriveKey: pbkdf2.deriveKey });
    const wrongCounter = Buffer.from(
      JSON.stringify({
        challenge: { parameters: challenge.parameters, signature: challenge.signature },
        solution: { ...solution, counter: solution!.counter + 1 },
      }),
    ).toString("base64");
    assert.equal(await altcha.verifyAltcha(wrongCounter), false, "a wrong counter must not pass");

    const forged = await altcha.createChallenge();
    const forgedSolution = await lib.solveChallenge({ challenge: forged, deriveKey: pbkdf2.deriveKey });
    const forgedPayload = Buffer.from(
      JSON.stringify({
        challenge: { parameters: forged.parameters, signature: "0".repeat(64) },
        solution: forgedSolution,
      }),
    ).toString("base64");
    assert.equal(await altcha.verifyAltcha(forgedPayload), false, "a forged signature must not pass");
  });

  it("refuses to accept the same solution twice", async () => {
    const solution = await solve();
    assert.equal(await altcha.verifyAltcha(solution), true);
    assert.equal(await altcha.verifyAltcha(solution), false, "a spent solution must not be replayable");
  });

  it("refuses an expired challenge", async () => {
    const expired = await altcha.createChallenge(new Date(Date.now() - 3_600_000));
    assert.equal(await altcha.verifyAltcha(await payloadFor(expired)), false);
  });
});

describe("altcha gates the real endpoints", () => {
  it("blocks link creation without a solution, and allows it with one", async () => {
    const without = await call("/api/links", { method: "POST", body: payload() });
    assert.equal(without.status, 401);
    assert.equal((without.json as { type: string }).type, "invalid_bot_check");

    const withSolution = await call("/api/links", { method: "POST", body: payload(await solve()) });
    assert.equal(withSolution.status, 201, withSolution.text);
  });

  it("blocks a guest session on a link that requires the check", async () => {
    const created = await call("/api/links", { method: "POST", body: payload(await solve()) });
    assert.equal(created.status, 201, created.text);
    const slug = (created.json as { slug: string }).slug;

    const without = await call(`/api/s/${slug}/session`, { method: "POST", body: "{}" });
    assert.equal(without.status, 401);
    assert.equal((without.json as { type: string }).type, "invalid_bot_check");

    const withSolution = await call(`/api/s/${slug}/session`, {
      method: "POST",
      body: JSON.stringify({ altcha: await solve() }),
    });
    assert.equal(withSolution.status, 200, withSolution.text);
    assert.ok(withSolution.cookies.some((cookie) => cookie.startsWith("__Host-as_sess=")));
  });

  it("allows the widget's style with a per-response nonce, never 'unsafe-inline'", async () => {
    const first = await app.fetch(new Request("https://test.example/new"));
    const body = await first.text();
    const policy = first.headers.get("content-security-policy") ?? "";

    assert.ok(!policy.includes("unsafe-inline"), `policy still allows inline styles: ${policy}`);
    assert.ok(!policy.includes("unsafe-eval"), "policy must not allow eval");

    const fromHeader = /style-src [^;]*'nonce-([^']+)'/.exec(policy)?.[1];
    const fromMeta = /csp-nonce" content="([^"]+)"/.exec(body)?.[1];
    assert.ok(fromHeader, "style-src carries a nonce");
    assert.equal(fromHeader, fromMeta, "the widget reads the nonce from the meta tag, so they must agree");

    const second = await app.fetch(new Request("https://test.example/new"));
    const secondNonce = /style-src [^;]*'nonce-([^']+)'/.exec(
      second.headers.get("content-security-policy") ?? "",
    )?.[1];
    assert.notEqual(fromHeader, secondNonce, "a nonce must not be reused across responses");
  });

  it("keeps workers same origin, never blob:", async () => {
    const res = await app.fetch(new Request("https://test.example/new"));
    const policy = res.headers.get("content-security-policy") ?? "";
    assert.match(policy, /worker-src 'self'/);
    assert.ok(!policy.includes("blob:"), `policy still allows blob workers: ${policy}`);

    const client = readFileSync(new URL("../public/altcha.js", import.meta.url), "utf8");
    assert.match(client, /algorithms/, "the client overrides the blob worker registry");
    assert.match(client, /registry\.set\(algorithm, \(\) => new Worker\(url\)\)/);
    assert.match(client, /"\/assets\/vendor\/altcha-pbkdf2\.worker\.js"/);
    assert.ok(!client.includes("createObjectURL"), "the client never builds a blob worker itself");
  });

  it("serves the self-hosted 0xProto font under the content security policy", async () => {
    const page = await app.fetch(new Request("https://test.example/new"));
    const policy = page.headers.get("content-security-policy") ?? "";
    assert.match(policy, /font-src 'self'/);

    const font = await app.fetch(
      new Request("https://test.example/assets/vendor/fonts/0xProto-Regular.woff2"),
    );
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    assert.ok((await font.arrayBuffer()).byteLength > 0);
  });

  it("keeps the content security policy free of external origins", async () => {
    const created = await call("/api/links", { method: "POST", body: payload(await solve()) });
    const slug = (created.json as { slug: string }).slug;

    for (const path of [`/s/${slug}`, "/new"]) {
      const res = await app.fetch(new Request(`https://test.example${path}`));
      const policy = res.headers.get("content-security-policy") ?? "";
      assert.match(policy, /default-src 'self'/);
      assert.ok(!policy.includes("http"), `${path} allows an external origin: ${policy}`);
    }
  });
});
