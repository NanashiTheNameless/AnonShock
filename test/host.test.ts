import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPayload, startHarness, type Harness } from "./harness.ts";

/**
 * Host control is three blunt, global, CLI-only powers. These tests cover the
 * behavior those commands drive, and the absence of any HTTP route for them.
 */

let h: Harness;

before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

async function makeLink() {
  const res = await h.fetch("/api/links", { method: "POST", body: JSON.stringify(createPayload()) });
  assert.equal(res.status, 201, res.text);
  const body = res.json as Record<string, string>;
  return { slug: body["slug"]!, manageToken: body["manageUrl"]!.split("/m/")[1]! };
}

async function session(slug: string) {
  const res = await h.fetch(`/api/s/${slug}/session`, { method: "POST", body: "{}" });
  return res.cookies.find((c) => c.startsWith("__Host-as_sess="))!.split(";")[0]!;
}

describe("instance pause", () => {
  it("blocks control and creation but still delivers Stop", async () => {
    const { slug } = await makeLink();
    const cookie = await session(slug);
    const view = (await h.fetch(`/api/s/${slug}`)).json as any;
    const alias = view.devices[0].shockers[0].alias;

    const { setPaused } = await import("../src/store/db.ts");
    setPaused(true);
    try {
      const blocked = await h.fetch(`/api/s/${slug}/control`, {
        method: "POST",
        cookies: [cookie],
        body: JSON.stringify({ commands: [{ alias, type: "Vibrate", intensity: 5, duration: 500 }] }),
      });
      assert.equal(blocked.status, 503);
      assert.equal((blocked.json as { type: string }).type, "instance_paused");

      const stop = await h.fetch(`/api/s/${slug}/control`, {
        method: "POST",
        cookies: [cookie],
        body: JSON.stringify({ commands: [{ alias, type: "Stop", intensity: 0, duration: 300 }] }),
      });
      assert.equal(stop.status, 200, "a pause must never strand a wearer");

      const created = await h.fetch("/api/links", {
        method: "POST",
        body: JSON.stringify(createPayload()),
      });
      assert.equal(created.status, 503);

      const ready = await h.fetch("/readyz");
      assert.equal(ready.status, 503);
    } finally {
      setPaused(false);
    }
  });

  it("refuses to start a new guest session while paused", async () => {
    const { slug } = await makeLink();
    const { setPaused } = await import("../src/store/db.ts");
    setPaused(true);
    try {
      const res = await h.fetch(`/api/s/${slug}/session`, { method: "POST", body: "{}" });
      assert.equal(res.status, 503);
      assert.equal((res.json as { type: string }).type, "instance_paused");
      // Reading the page is still allowed, so a guest sees the state.
      assert.equal((await h.fetch(`/api/s/${slug}`)).status, 200);
    } finally {
      setPaused(false);
    }
  });

  it("survives a reload of the store", async () => {
    const { setPaused, isPaused } = await import("../src/store/db.ts");
    setPaused(true);
    assert.equal(isPaused(), true);
    setPaused(false);
    assert.equal(isPaused(), false);
  });
});

describe("purge", () => {
  it("deletes every link and holder", async () => {
    const one = await makeLink();
    const two = await makeLink();

    const { deleteAllLinks, countLinks } = await import("../src/store/queries.ts");
    const { disposeAllRooms } = await import("../src/core/rooms.ts");
    assert.ok(countLinks() >= 2);
    disposeAllRooms();
    const deleted = deleteAllLinks();
    assert.ok(deleted >= 2);
    assert.equal(countLinks(), 0);

    assert.equal((await h.fetch(`/api/s/${one.slug}`)).status, 404);
    assert.equal((await h.fetch(`/api/s/${two.slug}`)).status, 404);
    assert.equal((await h.fetch(`/api/m/${one.manageToken}`)).status, 404);
    assert.equal((await h.fetch("/api/holder/links")).status, 401);
  });
});

describe("expiry", () => {
  it("hard deletes an expired link rather than tombstoning it", async () => {
    const { slug } = await makeLink();
    const { getDb } = await import("../src/store/db.ts");
    getDb().prepare("UPDATE links SET expires_at = ? WHERE slug = ?").run(Date.now() - 1000, slug);

    const { sweep } = await import("../src/core/rooms.ts");
    sweep();

    const row = getDb().prepare("SELECT 1 FROM links WHERE slug = ?").get(slug);
    assert.equal(row, undefined, "the row is gone, not marked expired");
    assert.equal((await h.fetch(`/api/s/${slug}`)).status, 404);
  });
});

describe("resume", () => {
  it("resumes a killed link but not one upstream has taken away", async () => {
    const { slug, manageToken } = await makeLink();

    assert.equal((await h.fetch(`/api/m/${manageToken}/kill`, { method: "POST" })).status, 200);
    assert.equal((await h.fetch(`/api/m/${manageToken}/resume`, { method: "POST" })).status, 200);

    // Mark the link dead the way a vanished upstream share would.
    const { getDb } = await import("../src/store/db.ts");
    getDb().prepare("UPDATE links SET status = 'dead_upstream' WHERE slug = ?").run(slug);
    const { existingRoom } = await import("../src/core/rooms.ts");
    const { getLinkBySlug } = await import("../src/store/queries.ts");
    existingRoom(getLinkBySlug(slug)!.id)?.reload(getLinkBySlug(slug)!);

    const refused = await h.fetch(`/api/m/${manageToken}/resume`, { method: "POST" });
    assert.equal(refused.status, 409, "a dead link must not be resumed into life");
    assert.equal((refused.json as { type: string }).type, "not_resumable");
  });
});
