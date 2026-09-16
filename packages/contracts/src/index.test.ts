import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSha256, normalizeScreenshotName } from "./index.ts";

describe("manifest contracts", () => {
  it("normalizes platform separators", () => {
    assert.equal(normalizeScreenshotName("Settings\\Dark.png"), "Settings/Dark.png");
  });

  it("rejects path traversal and absolute names", () => {
    assert.throws(() => normalizeScreenshotName("../secret.png"));
    assert.throws(() => normalizeScreenshotName("/absolute.png"));
  });

  it("accepts only lowercase SHA-256 hex", () => {
    assert.equal(isSha256("a".repeat(64)), true);
    assert.equal(isSha256("A".repeat(64)), false);
    assert.equal(isSha256("a".repeat(63)), false);
  });
});

