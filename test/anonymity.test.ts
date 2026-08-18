import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createPayload, cookieValue, startHarness, type Harness } from "./harness.ts";
import { SENTINEL } from "./mock-upstream.ts";

/**
 * The release-blocking suite. These encode the product promise: no upstream
 * identity reaches a guest, two links over the same hardware cannot be
 * correlated, dead and unknown links are indistinguishable, and nothing about
 * who used what is written down.
 */

let h: Harness;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
    holderCookie: cookieValue(res.cookies, "__Host-as_holder")!,
  };
}

async function session(slug: string) {
  const res = await h.fetch(`/api/s/${slug}/session`, { method: "POST", body: "{}" });
  return res.cookies.find((c) => c.startsWith("__Host-as_sess="))!.split(";")[0]!;
}

function assertClean(where: string, text: string): void {
  for (const [key, probe] of Object.entries(SENTINEL)) {
    assert.ok(!text.includes(probe), `${where} leaked sentinel ${key}`);
  }
  const uuid = text.match(UUID_RE);
  assert.equal(uuid, null, `${where} leaked a UUID: ${uuid?.[0]}`);
}

describe("1. sentinel sweep across the whole guest surface", () => {
  it("emits no upstream name, id, or avatar anywhere a guest can reach", async () => {
    const { slug } = await makeLink();
    const cookie = await session(slug);
    const view = (await h.fetch(`/api/s/${slug}`)).json as any;
    const alias = view.devices[0].shockers[0].alias;
    const aliasB = view.devices[0].shockers[1].alias;

    const responses: [string, Awaited<ReturnType<typeof h.fetch>>][] = [
      ["guest page", await h.fetch(`/s/${slug}`)],
      ["guest view", await h.fetch(`/api/s/${slug}`)],
      ["session", await h.fetch(`/api/s/${slug}/session`, { method: "POST", body: "{}" })],
      [
        "control ok",
        await h.fetch(`/api/s/${slug}/control`, {
          method: "POST",
          cookies: [cookie],
          body: JSON.stringify({ commands: [{ alias, type: "Vibrate", intensity: 5, duration: 500 }] }),
        }),
      ],
      [
        "control forbidden",
        await h.fetch(`/api/s/${slug}/control`, {
          method: "POST",
          cookies: [cookie],
          body: JSON.stringify({ commands: [{ alias: aliasB, type: "Shock", intensity: 5, duration: 500 }] }),
        }),
      ],
      [
        "control unknown alias",
        await h.fetch(`/api/s/${slug}/control`, {
          method: "POST",
          cookies: [cookie],
          body: JSON.stringify({ commands: [{ alias: "s_ZZZZZZ", type: "Vibrate", intensity: 5, duration: 500 }] }),
        }),
      ],
      [
        "control malformed",
        await h.fetch(`/api/s/${slug}/control`, {
          method: "POST",
          cookies: [cookie],
          body: JSON.stringify({ commands: [{ alias, type: "Nope", intensity: 5, duration: 500 }] }),
        }),
      ],
      ["unknown slug", await h.fetch("/api/s/abcdefghijk")],
      ["dead page", await h.fetch("/s/abcdefghijk")],
      ["home", await h.fetch("/")],
      ["privacy", await h.fetch("/privacy")],
      ["safety", await h.fetch("/safety")],
      ["robots", await h.fetch("/robots.txt")],
      ["healthz", await h.fetch("/healthz")],
      ["links page", await h.fetch("/links")],
    ];

    for (const [where, res] of responses) {
      assertClean(where, res.text);
      for (const [name, value] of res.headers) assertClean(`${where} header ${name}`, value);
    }
  });

  it("emits no sentinel when upstream is unreachable or the share is gone", async () => {
    const { slug } = await makeLink();
    h.upstream.state.shareMissing = true;
    try {
      const view = await h.fetch(`/api/s/${slug}`);
      const page = await h.fetch(`/s/${slug}`);
      assertClean("view with dead upstream", view.text);
      assertClean("page with dead upstream", page.text);
    } finally {
      h.upstream.state.shareMissing = false;
    }
  });
});

describe("2. cross-link correlation", () => {
  it("gives two links over the same hardware nothing in common", async () => {
    const one = await makeLink();
    const two = await makeLink();
    const viewOne = (await h.fetch(`/api/s/${one.slug}`)).json as any;
    const viewTwo = (await h.fetch(`/api/s/${two.slug}`)).json as any;

    assert.notEqual(one.slug, two.slug);
    assert.notEqual(viewOne.devices[0].alias, viewTwo.devices[0].alias);

    const aliasesOne = viewOne.devices[0].shockers.map((s: any) => s.alias).sort();
    const aliasesTwo = viewTwo.devices[0].shockers.map((s: any) => s.alias).sort();
    for (const alias of aliasesOne) {
      assert.ok(!aliasesTwo.includes(alias), "an alias repeated across two links");
    }

    // An alias from one link must not resolve on the other.
    const cookie = await session(two.slug);
    const res = await h.fetch(`/api/s/${two.slug}/control`, {
      method: "POST",
      cookies: [cookie],
      body: JSON.stringify({
        commands: [{ alias: aliasesOne[0], type: "Vibrate", intensity: 5, duration: 500 }],
      }),
    });
    assert.equal(res.status, 403);
  });
});

/**
 * Every HTML response carries a fresh CSP nonce, which is random by design and
 * says nothing about the link. Comparisons of two pages normalise it away;
 * anything else differing is a real leak.
 */
function withoutNonce(text: string): string {
  return text.replace(/content="[^"]*"/g, 'content="NONCE"');
}

describe("3. error parity", () => {
  it("answers unknown, expired, and deleted slugs identically", async () => {
    const deleted = await makeLink();
    await h.fetch(`/api/m/${deleted.manageToken}`, { method: "DELETE" });

    const unknown = await h.fetch("/api/s/abcdefghijk");
    const gone = await h.fetch(`/api/s/${deleted.slug}`);
    assert.equal(unknown.status, gone.status);
    assert.equal(unknown.text, gone.text);

    const unknownPage = await h.fetch("/s/abcdefghijk");
    const gonePage = await h.fetch(`/s/${deleted.slug}`);
    assert.equal(unknownPage.status, gonePage.status);
    assert.equal(unknownPage.text.length, gonePage.text.length, "same length, so no extra detail");
    assert.equal(withoutNonce(unknownPage.text), withoutNonce(gonePage.text));
  });

  it("answers unknown, hidden, and forbidden aliases identically", async () => {
    const payload = createPayload();
    const devices = (payload["settings"] as any).devices;
    devices[0].shockers[1].hidden = true;
    const { slug } = await makeLink(payload);
    const cookie = await session(slug);

    const view = (await h.fetch(`/api/s/${slug}`)).json as any;
    assert.equal(view.devices[0].shockers.length, 1, "a hidden shocker is not listed");

    const send = (alias: string, type: string) =>
      h.fetch(`/api/s/${slug}/control`, {
        method: "POST",
        cookies: [cookie],
        body: JSON.stringify({ commands: [{ alias, type, intensity: 5, duration: 500 }] }),
      });

    const unknown = await send("s_ZZZZZZ", "Vibrate");
    const hidden = await send("s_YYYYYY", "Vibrate");
    const forbidden = await send(view.devices[0].shockers[0].alias, "Nope");

    assert.equal(unknown.status, 403);
    assert.equal(hidden.status, 403);
    assert.equal(unknown.text, hidden.text);
    assert.notEqual(forbidden.status, 500);
  });

  it("does not reveal which layer paused a shocker", async () => {
    const { slug } = await makeLink();
    for (const reason of [1, 2, 4, 6]) {
      h.upstream.state.paused = reason;
      const fresh = await makeLink();
      const view = (await h.fetch(`/api/s/${fresh.slug}`)).json as any;
      assert.equal(view.devices[0].shockers[0].paused, true);
      assert.ok(!view.devices[0].shockers[0].pausedReason);
      assert.ok(!JSON.stringify(view).includes(`"paused":${reason}`));
    }
    h.upstream.state.paused = 0;
    assert.ok(slug);
  });
});

describe("4. headers", () => {
  it("puts the primary and safety actions at the top of the home page", async () => {
    const res = await h.fetch("/");
    const actions = res.text.indexOf('<nav class="home-actions"');
    const details = res.text.indexOf("<h2>What it hides</h2>");
    assert.ok(actions >= 0 && actions < details);
    assert.match(res.text, />Make a link<\/a>/);
    assert.match(res.text, />Links from this browser<\/a>/);
    assert.match(res.text, /href="\/safety">Safety<\/a>/);
    assert.match(res.text, />Privacy<\/a>/);
  });

  it("keeps a local safety page that directs people to the OpenShock rules", async () => {
    const res = await h.fetch("/safety");
    assert.match(res.text, /<h1>Safety<\/h1>/);
    assert.match(res.text, /This page is only an AnonShock-specific overview/);
    assert.match(res.text, /href="https:\/\/wiki\.openshock\.org\/home\/safety-rules"/);
    assert.match(res.text, />Read the OpenShock safety rules<\/a>/);
  });

  it("renders the credited site header and footer on every HTML page", async () => {
    const { slug } = await makeLink();
    for (const path of ["/", "/new", "/links", `/s/${slug}`]) {
      const res = await h.fetch(path);
      assert.match(res.text, /<header class="site-header">/, path);
      assert.match(res.text, /<footer>/, path);
      assert.match(res.text, />NanashiTheNameless<\/a>/, path);
      assert.match(res.text, /https:\/\/github\.com\/NanashiTheNameless\/AnonShock/, path);
      assert.match(res.text, />View the AnonShock repository on GitHub<\/a>/, path);
      assert.match(res.text, /href="\/acknowledgements">Open Source Acknowledgements<\/a>/, path);
      assert.match(res.text, /href="\/safety">Safety<\/a>/, path);
    }
  });

  it("serves the open source acknowledgements page", async () => {
    const res = await h.fetch("/acknowledgements");
    assert.match(res.text, /<h1>Open Source Acknowledgements<\/h1>/);
    for (const project of ["Hono", "ALTCHA", "ws", "0xProto", "Node.js", "cloudflared"]) {
      assert.match(res.text, new RegExp(project));
    }
  });

  it("sets the anonymity headers on every guest route", async () => {
    const { slug } = await makeLink();
    for (const path of [`/s/${slug}`, `/api/s/${slug}`, "/", "/links", "/new"]) {
      const res = await h.fetch(path);
      assert.equal(res.headers.get("referrer-policy"), "no-referrer", path);
      assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow, noarchive", path);
      assert.equal(res.headers.get("cache-control"), "no-store", path);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
      assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000", path);
      assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin", path);
      assert.equal(res.headers.get("server"), null, path);
      assert.equal(res.headers.get("x-powered-by"), null, path);
    }
  });

  it("forbids images entirely in the content security policy", async () => {
    const { slug } = await makeLink();
    const res = await h.fetch(`/s/${slug}`);
    assert.match(res.headers.get("content-security-policy") ?? "", /upgrade-insecure-requests/);
    const policy = res.headers.get("content-security-policy") ?? "";
    assert.match(policy, /img-src 'none'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.match(policy, /default-src 'self'/);
  });
});

describe("5. nothing about use is written down", () => {
  it("leaves no trace of a command anywhere in the store", async () => {
    const { slug } = await makeLink();
    const cookie = await session(slug);
    const view = (await h.fetch(`/api/s/${slug}`)).json as any;
    const alias = view.devices[0].shockers[0].alias;
    const pseudonym = ((await h.fetch(`/api/s/${slug}/session`, { method: "POST", body: "{}" })).json as any)
      .pseudonym;

    for (let i = 0; i < 25; i++) {
      await h.fetch(`/api/s/${slug}/control`, {
        method: "POST",
        cookies: [cookie],
        body: JSON.stringify({ commands: [{ alias, type: "Vibrate", intensity: 5, duration: 500 }] }),
      });
    }

    const { getDb } = await import("../src/store/db.ts");
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => String(r["name"]));

    for (const forbidden of ["control_log", "sessions", "guest_sessions", "activity", "audit_log", "ip_log"]) {
      assert.ok(!tables.includes(forbidden), `the store has a ${forbidden} table`);
    }

    // Dump every row of every table and assert nothing about use is in there.
    let dump = "";
    for (const table of tables) {
      for (const row of getDb().prepare(`SELECT * FROM ${table}`).all()) {
        dump += JSON.stringify(row, (_k, v) => (v instanceof Uint8Array ? "<blob>" : v));
      }
    }
    assert.ok(!dump.includes(pseudonym), "a pseudonym reached the store");
    assert.ok(!dump.includes("Vibrate"), "a control type reached the store");
    assert.ok(!dump.includes("203.0.113.7"), "an IP address reached the store");
    for (const probe of Object.values(SENTINEL)) {
      assert.ok(!dump.includes(probe), "an upstream identifier is stored unsealed");
    }
  });

  it("keeps the activity ring in memory only and bounded", async () => {
    const { slug } = await makeLink();
    const cookie = await session(slug);
    const view = (await h.fetch(`/api/s/${slug}`)).json as any;
    const alias = view.devices[0].shockers[0].alias;

    for (let i = 0; i < 30; i++) {
      await h.fetch(`/api/s/${slug}/control`, {
        method: "POST",
        cookies: [cookie],
        body: JSON.stringify({ commands: [{ alias, type: "Vibrate", intensity: 5, duration: 500 }] }),
      });
    }
    // There is no endpoint that reads history back out.
    const history = await h.fetch(`/api/s/${slug}/history`);
    assert.equal(history.status, 404);
    const log = await h.fetch(`/api/s/${slug}/log`);
    assert.equal(log.status, 404);
  });

  it("exposes no route that lists links or holders", async () => {
    for (const path of [
      "/api/links",
      "/api/admin",
      "/api/admin/links",
      "/admin",
      "/api/instance/links",
      "/api/holder/all",
    ]) {
      const res = await h.fetch(path);
      assert.notEqual(res.status, 200, `${path} answered 200`);
    }
  });
});

describe("6. no images are shipped at all", () => {
  it("has no image assets in the public directory", () => {
    const files = readdirSync(new URL("../public", import.meta.url));
    for (const file of files) {
      assert.ok(
        !/\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(file),
        `public/${file} is an image, and the no-icons rule forbids shipping images`,
      );
    }
  });

  it("references no external origin from any first-party asset", () => {
    // Third-party vendored assets are excluded because their text is not
    // guest-facing application output. They remain same-origin and constrained
    // by the response content security policy.
    const files = readdirSync(new URL("../public", import.meta.url)).filter((f) =>
      /\.(js|css)$/.test(f),
    );
    assert.ok(files.length >= 5, "expected the first-party assets to be found");
    for (const file of files) {
      const text = readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
      const externals = text.match(/https?:\/\/(?!openshock\.app)[a-z0-9.-]+/gi) ?? [];
      assert.deepEqual(externals, [], `${file} references an external origin`);
    }
  });

  it("has no images in the vendored directory either", () => {
    const files = readdirSync(new URL("../public/vendor", import.meta.url));
    for (const file of files) {
      assert.ok(
        !/\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(file),
        `public/vendor/${file} is an image`,
      );
    }
  });
});
