import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePngDimensions } from "./verification.ts";

function header(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("PNG verification", () => {
  it("reads dimensions from IHDR", () => {
    assert.deepEqual(parsePngDimensions(header(390, 844)), { width: 390, height: 844 });
  });

  it("rejects bad signatures and decompression-sized dimensions", () => {
    assert.throws(() => parsePngDimensions(new Uint8Array(24)), /not a PNG/);
    assert.throws(() => parsePngDimensions(header(10_000, 10_000)), /limits/);
  });
});

