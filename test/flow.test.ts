import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPayload, cookieValue, startHarness, type Harness } from "./harness.ts";
import { SENTINEL } from "./mock-upstream.ts";

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

async function makeLink(payload = createPayload()) {
  const res = await h.fetch("/api/links", { method: "POST", body: JSON.stringify(payload) });
  assert.equal(res.status, 201, res.text);
  const body = res.json as Record<string, string>;
  return {
    slug: body["slug"]!,
    manageToken: body["manageUrl"]!.split("/m/")[1]!,
    holderCookie: cookieValue(res.cookies, "__Host-as_holder"),
    recovery: body["recovery"],
  };
}

async function startSession(slug: string) {
  const res = await h.fetch(`/api/s/${slug}/session`, { method: "POST", body: "{}" });
  assert.equal(res.status, 200, res.text);
  const cookie = res.cookies.find((c) => c.startsWith("__Host-as_sess="))!.split(";")[0]!;
  return { cookie, pseudonym: (res.json as { pseudonym: string }).pseudonym };
}

describe("create", () => {
  it("creates a link and issues holder and manage capabilities", async () => {
    const link = await makeLink();
    assert.match(link.slug, /^[0-9A-Za-z]{11}$/);
    assert.ok(link.manageToken.length >= 40);
    assert.ok(link.holderCookie, "a holder cookie is set on first creation");
    assert.ok(link.recovery?.startsWith("as1_"), "a recovery string is shown");
  });

  it("keeps showing the recovery field when this browser creates another link", async () => {
    const first = await makeLink();
    const second = await h.fetch("/api/links", {
      method: "POST",
      cookies: [`__Host-as_holder=${first.holderCookie}`],
      body: JSON.stringify(createPayload()),
    });
    assert.equal(second.status, 201, second.text);
    assert.equal((second.json as any).recovery, first.recovery);
  });

  it("uses an API token and discovers only the token holder's own shockers", async () => {
    const inspect = await h.fetch("/api/links/inspect", {
      method: "POST",
      body: JSON.stringify({ mode: "token", token: "good-token" }),
    });
    assert.equal(inspect.status, 200, inspect.text);
    assert.equal((inspect.json as any).devices[0].shockers.length, 2);
    assert.equal(h.upstream.state.sharedDiscoveryRequests, 0);

    const payload = createPayload({ mode: "token", token: "good-token" });
    delete payload["shareUrl"];
    const link = await makeLink(payload);
    assert.match(link.slug, /^[0-9A-Za-z]{11}$/);
    const refreshed = await h.fetch(`/api/m/${link.manageToken}/refresh`, { method: "POST" });
    assert.equal(refreshed.status, 200, refreshed.text);
    assert.equal(h.upstream.state.sharedDiscoveryRequests, 0);
  });

  it("refuses a payload missing any setting", async () => {
    const payload = createPayload();
    delete (payload["settings"] as Record<string, unknown>)["ttlSeconds"];
    const res = await h.fetch("/api/links", { method: "POST", body: JSON.stringify(payload) });
    assert.equal(res.status, 400);
    assert.equal((res.json as { type: string }).type, "incomplete_settings");
  });

  it("refuses a payload that omits a discovered shocker", async () => {
    const payload = createPayload();
    const devices = (payload["settings"] as Record<string, unknown>)["devices"] as Record<string, unknown>[];
    (devices[0]!["shockers"] as unknown[]).pop();
    const res = await h.fetch("/api/links", { method: "POST", body: JSON.stringify(payload) });
    assert.equal(res.status, 400);
    assert.equal((res.json as { type: string }).type, "incomplete_settings");
  });

  it("refuses a ceiling above what upstream allows", async () => {
    const payload = createPayload();
    const devices = (payload["settings"] as Record<string, unknown>)["devices"] as Record<string, unknown>[];
    const shockers = devices[0]!["shockers"] as Record<string, unknown>[];
    shockers[0]!["maxIntensity"] = 90; // upstream allows 60
    const res = await h.fetch("/api/links", { method: "POST", body: JSON.stringify(payload) });
    assert.equal(res.status, 400);
    assert.equal((res.json as { type: string }).type, "limit_exceeds_upstream");
  });

  it("refuses a permission upstream does not grant", async () => {
    const payload = createPayload();
    const devices = (payload["settings"] as Record<string, unknown>)["devices"] as Record<string, unknown>[];
    const shockers = devices[0]!["shockers"] as Record<string, unknown>[];
    shockers[1]!["allowShock"] = true; // shocker B forbids shock upstream
    const res = await h.fetch("/api/links", { method: "POST", body: JSON.stringify(payload) });
    assert.equal(res.status, 400);
    assert.equal((res.json as { type: string }).type, "limit_exceeds_upstream");
  });

  it("refuses missing acknowledgements", async () => {
    const payload = createPayload({ acknowledgements: { limitsReviewed: true } });
    const res = await h.fetch("/api/links", { method: "POST", body: JSON.stringify(payload) });
    assert.equal(res.status, 400);
  });
});

describe("guest view", () => {
  it("serves aliases and effective limits", async () => {
    const { slug } = await makeLink();
    const res = await h.fetch(`/api/s/${slug}`);
    assert.equal(res.status, 200);
    const view = res.json as any;
    assert.equal(view.author, "Anonymous");
    assert.equal(view.devices.length, 1);
    assert.equal(view.devices[0].shockers.length, 2);
    assert.match(view.devices[0].alias, /^d_[0-9A-Za-z]{6}$/);
    assert.match(view.devices[0].shockers[0].alias, /^s_[0-9A-Za-z]{6}$/);
    assert.equal(view.devices[0].shockers[0].limits.maxIntensity, 30);
    assert.equal(view.devices[0].shockers[0].paused, false);
    assert.equal(view.ephemeral, true);
  });

  it("collapses the upstream pause bitfield to a boolean", async () => {
    const { slug } = await makeLink();
    h.upstream.state.paused = 4; // PublicShare
    await new Promise((r) => setTimeout(r, 5));
    const res = await h.fetch(`/api/s/${slug}`);
    const view = res.json as any;
    assert.equal(view.devices[0].shockers[0].paused, true);
    assert.equal(typeof view.devices[0].shockers[0].paused, "boolean");
    h.upstream.state.paused = 0;
  });

  it("gives unknown and dead slugs the same answer", async () => {
    const unknown = await h.fetch("/api/s/abcdefghijk");
    assert.equal(unknown.status, 404);
    assert.equal((unknown.json as { type: string }).type, "link_dead");
  });
});

describe("control", () => {
  it("requires a session", async () => {
    const { slug } = await makeLink();
    const view = (await h.fetch(`/api/s/${slug}`)).json as any;
    const alias = view.devices[0].shockers[0].alias;
    const res = await h.fetch(`/api/s/${slug}/control`, {
      method: "POST",
      body: JSON.stringify({ commands: [{ alias, type: "Vibrate", intensity: 10, duration: 500 }] }),
    });
    assert.equal(res.status, 401);
  });

  it("clamps down to the effective ceiling and reports it", async () => {
    const { slug } = await makeLink();
    const session = await startSession(slug);
    const view = (await h.fetch(`/api/s/${slug}`)).json as any;
    const alias = view.devices[0].shockers[0].alias;

    const res = await h.fetch(`/api/s/${slug}/control`, {
      method: "POST",
      cookies: [session.cookie],
      body: JSON.stringify({ commands: [{ alias, type: "Shock", intensity: 100, duration: 9000 }] }),
    });
    assert.equal(res.status, 200, res.text);
    const applied = (res.json as any).applied[0];
    assert.equal(applied.intensity, 30);
    assert.equal(applied.duration, 3000);
    assert.equal(applied.clamped, true);
  });

  it("refuses a control type the link forbids", async () => {
    const { slug } = await makeLink();
    const session = await startSession(slug);
    const view = (await h.fetch(`/api/s/${slug}`)).json as any;
    const aliasB = view.devices[0].shockers[1].alias;

    const res = await h.fetch(`/api/s/${slug}/control`, {
      method: "POST",
      cookies: [session.cookie],
      body: JSON.stringify({ commands: [{ alias: aliasB, type: "Shock", intensity: 5, duration: 500 }] }),
    });
    assert.equal(res.status, 403);
    assert.equal((res.json as { type: string }).type, "not_permitted");
  });

  it("gives unknown aliases the same answer as forbidden ones", async () => {
    const { slug } = await makeLink();
    const session = await startSession(slug);
    const res = await h.fetch(`/api/s/${slug}/control`, {
      method: "POST",
      cookies: [session.cookie],
      body: JSON.stringify({ commands: [{ alias: "s_ZZZZZZ", type: "Vibrate", intensity: 5, duration: 500 }] }),
    });
    assert.equal(res.status, 403);
    assert.equal((res.json as { type: string }).type, "not_permitted");
  });

  it("rejects out of range values before any upstream call", async () => {
    const { slug } = await makeLink();
    const session = await startSession(slug);
    const view = (await h.fetch(`/api/s/${slug}`)).json as any;
    const alias = view.devices[0].shockers[0].alias;

    for (const bad of [
      { intensity: -1, duration: 500 },
      { intensity: 101, duration: 500 },
      { intensity: 5, duration: 299 },
      { intensity: 5, duration: 70000 },
    ]) {
      const res = await h.fetch(`/api/s/${slug}/control`, {
        method: "POST",
        cookies: [session.cookie],
        body: JSON.stringify({ commands: [{ alias, type: "Vibrate", ...bad }] }),
      });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
  });

  it("refuses control on a killed link but still accepts Stop", async () => {
    const { slug, manageToken } = await makeLink();
    const session = await startSession(slug);
    const view = (await h.fetch(`/api/s/${slug}`)).json as any;
    const alias = view.devices[0].shockers[0].alias;

    await h.fetch(`/api/m/${manageToken}/kill`, { method: "POST" });

    const blocked = await h.fetch(`/api/s/${slug}/control`, {
      method: "POST",
      cookies: [session.cookie],
      body: JSON.stringify({ commands: [{ alias, type: "Vibrate", intensity: 5, duration: 500 }] }),
    });
    assert.equal(blocked.status, 410);

    const stop = await h.fetch(`/api/s/${slug}/control`, {
      method: "POST",
      cookies: [session.cookie],
      body: JSON.stringify({ commands: [{ alias, type: "Stop", intensity: 0, duration: 300 }] }),
    });
    assert.equal(stop.status, 200, stop.text);
  });

  it("rate limits a guest and never rate limits Stop", async () => {
    const payload = createPayload();
    (payload["settings"] as any).rateLimitPerMin = 1;
    const { slug } = await makeLink(payload);
    const session = await startSession(slug);
    const view = (await h.fetch(`/api/s/${slug}`)).json as any;
    const alias = view.devices[0].shockers[0].alias;

    const body = JSON.stringify({ commands: [{ alias, type: "Vibrate", intensity: 5, duration: 500 }] });
    let limited = false;
    for (let i = 0; i < 6; i++) {
      const res = await h.fetch(`/api/s/${slug}/control`, { method: "POST", cookies: [session.cookie], body });
      if (res.status === 429) {
        limited = true;
        assert.ok(res.headers.get("retry-after"));
        break;
      }
    }
    assert.ok(limited, "the guest bucket eventually refuses");

    const stop = await h.fetch(`/api/s/${slug}/control`, {
      method: "POST",
      cookies: [session.cookie],
      body: JSON.stringify({ commands: [{ alias, type: "Stop", intensity: 0, duration: 300 }] }),
    });
    assert.equal(stop.status, 200, "Stop is exempt");
  });

  it("treats a per-guest rate limit of zero as unlimited", async () => {
    const payload = createPayload();
    (payload["settings"] as any).rateLimitPerMin = 0;
    (payload["settings"] as any).linkRateLimitPerMin = 600;
    const { slug } = await makeLink(payload);
    const session = await startSession(slug);
    const view = (await h.fetch(`/api/s/${slug}`)).json as any;
    const alias = view.devices[0].shockers[0].alias;
    const body = JSON.stringify({ commands: [{ alias, type: "Vibrate", intensity: 5, duration: 500 }] });

    for (let i = 0; i < 8; i++) {
      const res = await h.fetch(`/api/s/${slug}/control`, { method: "POST", cookies: [session.cookie], body });
      assert.equal(res.status, 200, `command ${i + 1} should not hit a per-guest limit`);
    }
  });

  it("treats a whole-link rate limit of zero as unlimited", async () => {
    const payload = createPayload();
    (payload["settings"] as any).rateLimitPerMin = 120;
    (payload["settings"] as any).linkRateLimitPerMin = 0;
    const { slug } = await makeLink(payload);
    const view = (await h.fetch(`/api/s/${slug}`)).json as any;
    const alias = view.devices[0].shockers[0].alias;
    const body = JSON.stringify({ commands: [{ alias, type: "Vibrate", intensity: 5, duration: 500 }] });

    for (let i = 0; i < 6; i++) {
      const session = await startSession(slug);
      const res = await h.fetch(`/api/s/${slug}/control`, { method: "POST", cookies: [session.cookie], body });
      assert.equal(res.status, 200, `guest ${i + 1} should not hit a whole-link limit`);
    }
  });
});

describe("holder", () => {
  it("lists this browser's links and issues a manage url on demand", async () => {
    const link = await makeLink();
    const cookie = `__Host-as_holder=${link.holderCookie}`;

    const list = await h.fetch("/api/holder/links", { cookies: [cookie] });
    assert.equal(list.status, 200);
    const links = (list.json as any).links;
    assert.ok(links.some((l: any) => l.slug === link.slug));

    const id = links.find((l: any) => l.slug === link.slug).id;
    const issued = await h.fetch(`/api/holder/links/${id}/manage-url`, {
      method: "POST",
      cookies: [cookie],
    });
    assert.equal(issued.status, 200);
    assert.match((issued.json as any).manageUrl, /\/m\/[A-Za-z0-9_-]{40,}$/);
  });

  it("pauses and resumes a link directly from the holder menu", async () => {
    const link = await makeLink();
    const cookie = `__Host-as_holder=${link.holderCookie}`;
    const listed = await h.fetch("/api/holder/links", { cookies: [cookie] });
    const item = (listed.json as any).links.find((candidate: any) => candidate.slug === link.slug);

    const paused = await h.fetch(`/api/holder/links/${item.id}/pause`, {
      method: "POST",
      cookies: [cookie],
    });
    assert.equal(paused.status, 200, paused.text);
    assert.equal((paused.json as any).status, "killed");

    const afterPause = await h.fetch("/api/holder/links", { cookies: [cookie] });
    assert.equal((afterPause.json as any).links.find((candidate: any) => candidate.id === item.id).status, "killed");

    const resumed = await h.fetch(`/api/holder/links/${item.id}/resume`, {
      method: "POST",
      cookies: [cookie],
    });
    assert.equal(resumed.status, 200, resumed.text);
    assert.equal((resumed.json as any).status, "active");
  });

  it("says nothing without a holder cookie", async () => {
    const res = await h.fetch("/api/holder/links");
    assert.equal(res.status, 401);
    const pause = await h.fetch("/api/holder/links/not-owned/pause", { method: "POST" });
    assert.equal(pause.status, 401);
  });

  it("imports a recovery string into another browser", async () => {
    const link = await makeLink();
    const imported = await h.fetch("/api/holder/import", {
      method: "POST",
      body: JSON.stringify({ recovery: link.recovery }),
    });
    assert.equal(imported.status, 200);
    assert.ok(cookieValue(imported.cookies, "__Host-as_holder"));
  });

  it("rejects an unknown recovery string", async () => {
    const res = await h.fetch("/api/holder/import", {
      method: "POST",
      body: JSON.stringify({ recovery: "as1_" + "x".repeat(43) }),
    });
    assert.equal(res.status, 401);
  });
});

describe("manage", () => {
  it("can set both command rate limits to unlimited", async () => {
    const { manageToken } = await makeLink();
    const saved = await h.fetch(`/api/m/${manageToken}`, {
      method: "PATCH",
      body: JSON.stringify({ rateLimitPerMin: 0, linkRateLimitPerMin: 0 }),
    });
    assert.equal(saved.status, 200, saved.text);

    const settings = await h.fetch(`/api/m/${manageToken}`);
    assert.equal(settings.status, 200, settings.text);
    assert.equal((settings.json as any).rateLimitPerMin, 0);
    assert.equal((settings.json as any).linkRateLimitPerMin, 0);
  });

  it("lowers a ceiling but refuses to raise one", async () => {
    const { slug, manageToken } = await makeLink();
    const view = (await h.fetch(`/api/s/${slug}`)).json as any;
    const alias = view.devices[0].shockers[0].alias;

    const lower = await h.fetch(`/api/m/${manageToken}`, {
      method: "PATCH",
      body: JSON.stringify({ shockers: [{ alias, maxIntensity: 10 }] }),
    });
    assert.equal(lower.status, 200);
    const after = (await h.fetch(`/api/s/${slug}`)).json as any;
    assert.equal(after.devices[0].shockers[0].limits.maxIntensity, 10);

    const raise = await h.fetch(`/api/m/${manageToken}`, {
      method: "PATCH",
      body: JSON.stringify({ shockers: [{ alias, maxIntensity: 50 }] }),
    });
    assert.equal(raise.status, 400);
  });

  it("rotates the slug and kills the old one", async () => {
    const { slug, manageToken } = await makeLink();
    const rotated = await h.fetch(`/api/m/${manageToken}/rotate-slug`, { method: "POST" });
    assert.equal(rotated.status, 200);
    const newSlug = (rotated.json as any).slug;
    assert.notEqual(newSlug, slug);
    assert.equal((await h.fetch(`/api/s/${slug}`)).status, 404);
    assert.equal((await h.fetch(`/api/s/${newSlug}`)).status, 200);
  });

  it("deletes a link outright", async () => {
    const { slug, manageToken } = await makeLink();
    assert.equal((await h.fetch(`/api/m/${manageToken}`, { method: "DELETE" })).status, 200);
    assert.equal((await h.fetch(`/api/s/${slug}`)).status, 404);
    assert.equal((await h.fetch(`/api/m/${manageToken}`)).status, 404);
  });

  it("rejects an unknown manage token", async () => {
    const res = await h.fetch(`/api/m/${"z".repeat(43)}`);
    assert.equal(res.status, 404);
  });
});

describe("upstream failures", () => {
  it("marks a link dead when the share disappears", async () => {
    const { slug } = await makeLink();
    h.upstream.state.shareMissing = true;
    try {
      const view = (await h.fetch(`/api/s/${slug}`)).json as any;
      assert.equal(view.status, "dead");
    } finally {
      h.upstream.state.shareMissing = false;
    }
  });
});

describe("no upstream identifier reaches a guest", () => {
  it("keeps sentinels out of the view and the page", async () => {
    const { slug } = await makeLink();
    const view = await h.fetch(`/api/s/${slug}`);
    const page = await h.fetch(`/s/${slug}`);
    for (const probe of Object.values(SENTINEL)) {
      assert.ok(!view.text.includes(probe), `view leaked ${probe}`);
      assert.ok(!page.text.includes(probe), `page leaked ${probe}`);
    }
  });
});
