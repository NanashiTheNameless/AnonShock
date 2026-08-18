import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env["NODE_ENV"] = "test";

const { parseShareId, CreateError } = await import("../src/core/links.ts");

const ID = "019d3c28-6262-724c-8bbe-d5e9e5f1191e";

/**
 * Share input is pasted by hand, so every shape OpenShock puts in front of a
 * user has to resolve to the same id: the short link, the long share URL, and
 * the bare id on its own.
 */
describe("share input", () => {
  it("accepts a short share link", () => {
    assert.equal(parseShareId(`https://openshock.app/s/${ID}`), ID);
  });

  it("accepts a full public share URL", () => {
    assert.equal(parseShareId(`https://openshock.app/shares/public/${ID}`), ID);
  });

  it("accepts a bare share id", () => {
    assert.equal(parseShareId(ID), ID);
  });

  it("normalises case and surrounding whitespace", () => {
    assert.equal(parseShareId(`  ${ID.toUpperCase()}  `), ID);
  });

  it("rejects input with no share id", () => {
    for (const bad of ["", "https://openshock.app/s/", "not-a-share"]) {
      assert.throws(() => parseShareId(bad), (err: unknown) => {
        assert.ok(err instanceof CreateError);
        assert.equal(err.type, "invalid_share");
        return true;
      });
    }
  });
});
