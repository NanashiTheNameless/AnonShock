import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./harness.ts";
import { SENTINEL } from "./mock-upstream.ts";

let h: Harness;
let limits: typeof import("../src/core/limits.ts");

before(async () => {
  h = await startHarness();
  limits = await import("../src/core/limits.ts");
});

after(async () => {
  await h.close();
});

const SHARE_URL = `https://openshock.app/s/${SENTINEL.shareId}`;

async function makeLink(guestPassword: string | null): Promise<{ slug: string; cookies: string[] }> {
  const inspected = await h.fetch("/api/links/inspect", {
    method: "POST",
    body: JSON.stringify({ mode: "share", shareUrl: SHARE_URL }),
  });
  const devices = (inspected.json as any).devices;
  const res = await h.fetch("/api/links", {
    method: "POST",
    body: JSON.stringify({
      mode: "share",
      shareUrl: SHARE_URL,
      acknowledgements: { limitsReviewed: true, aliasesArePublic: true, manageLinkSaved: true },
      settings: {
        title: "Password test",
        author: "Tester",
        ttlSeconds: 3600,
        requireBotCheck: false,
        guestPassword,
        rateLimitPerMin: 120,
        linkRateLimitPerMin: 600,
        devices: devices.map((d: any) => ({
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
    }),
  });
  assert.equal(res.status, 201, res.text);
  return { slug: (res.json as any).slug, cookies: res.cookies.map((c) => c.split(";")[0]!) };
}

describe("guest password", () => {
  it("accepts the right one and refuses the wrong one", async () => {
    const { slug } = await makeLink("correct horse battery");

    const wrong = await h.fetch(`/api/s/${slug}/session`, {
      method: "POST",
      body: JSON.stringify({ password: "wrong" }),
    });
    assert.equal(wrong.status, 401);
    assert.equal((wrong.json as any).type, "invalid_password");

    const right = await h.fetch(`/api/s/${slug}/session`, {
      method: "POST",
      body: JSON.stringify({ password: "correct horse battery" }),
    });
    assert.equal(right.status, 200);
  });

  it("refuses a password longer than the hashing cap", async () => {
    const inspected = await h.fetch("/api/links/inspect", {
      method: "POST",
      body: JSON.stringify({ mode: "share", shareUrl: SHARE_URL }),
    });
    const devices = (inspected.json as any).devices;
    const res = await h.fetch("/api/links", {
      method: "POST",
      body: JSON.stringify({
        mode: "share",
        shareUrl: SHARE_URL,
        acknowledgements: { limitsReviewed: true, aliasesArePublic: true, manageLinkSaved: true },
        settings: {
          title: "Too long",
          author: "Tester",
          ttlSeconds: 3600,
          requireBotCheck: false,
          // Unbounded input here used to run straight into scrypt.
          guestPassword: "z".repeat(5000),
          rateLimitPerMin: 120,
          linkRateLimitPerMin: 600,
          devices: devices.map((d: any) => ({
            upstreamId: d.upstreamId,
            displayName: d.suggestedName,
            shockers: d.shockers.map((s: any) => ({
              upstreamId: s.upstreamId,
              displayName: s.suggestedName,
              maxIntensity: 10,
              maxDuration: 1000,
              cooldownMs: 0,
              allowShock: false,
              allowVibrate: true,
              allowSound: false,
              hidden: false,
            })),
          })),
        },
      }),
    });
    assert.equal(res.status, 400);
    assert.equal((res.json as any).field, "guestPassword");
  });
});

describe("manage url issuance", () => {
  it("is a POST, because issuing one revokes the manage token before it", async () => {
    const { slug, cookies } = await makeLink(null);
    const listed = await h.fetch("/api/holder/links", { cookies });
    assert.equal(listed.status, 200);
    const id = (listed.json as any).links.find((l: any) => l.slug === slug).id;

    // A GET here rode along on SameSite=Lax from any page the holder clicked.
    const viaGet = await h.fetch(`/api/holder/links/${id}/manage-url`, { cookies });
    assert.equal(viaGet.status, 404);

    const viaPost = await h.fetch(`/api/holder/links/${id}/manage-url`, {
      method: "POST",
      cookies,
    });
    assert.equal(viaPost.status, 200);
    assert.match((viaPost.json as any).manageUrl, /\/m\/[A-Za-z0-9_-]{40,}$/);
  });
});

describe("limiter bookkeeping", () => {
  it("prunes keys once their window has passed", () => {
    const counter = new limits.WindowCounter(1_000, 5);
    const now = Date.now();
    for (let i = 0; i < 50; i++) counter.check(`ip-${i}`, now);
    limits.pruneAllCounters(now);
    assert.equal(counter.size, 50);
    // Every hit is now older than the window, so nothing should be retained.
    limits.pruneAllCounters(now + 2_000);
    assert.equal(counter.size, 0);
  });

  it("keeps the day key stable across an hourly rotation", () => {
    const fastBefore = limits.hashIp("198.51.100.4");
    const slowBefore = limits.hashIpSlow("198.51.100.4");
    limits.rotateIpKey();
    assert.notEqual(limits.hashIp("198.51.100.4"), fastBefore);
    assert.equal(limits.hashIpSlow("198.51.100.4"), slowBefore);
  });

  it("sheds work past the queue instead of parking it", async () => {
    const gate = new limits.Gate(1, 1);
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));

    const first = gate.run(() => blocked);
    const queued = gate.run(async () => "queued");
    const shed = await gate.run(async () => "shed");
    assert.equal(shed, null);

    release();
    assert.equal(await first, undefined);
    assert.equal(await queued, "queued");
  });
});
