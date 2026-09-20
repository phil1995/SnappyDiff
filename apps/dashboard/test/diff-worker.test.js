import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/diff-worker.js", import.meta.url), "utf8");

function bitmap(width, height) {
  return { width, height, closed: false, close() { this.closed = true; } };
}

async function render(decode) {
  const messages = [];
  const self = { postMessage: (message) => messages.push(message) };
  runInNewContext(source, {
    self,
    fetch: async () => ({ ok: true, blob: async () => ({}) }),
    createImageBitmap: decode,
  });
  await self.onmessage({ data: { requestId: "test", baseline: "/before", current: "/after" } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].requestId, "test");
  assert.equal(typeof messages[0].error, "string");
}

test("releases both decoded images when dimensions do not match", async () => {
  const before = bitmap(1, 1);
  const after = bitmap(2, 2);
  const images = [before, after];
  await render(async () => images.shift());
  assert.equal(before.closed, true);
  assert.equal(after.closed, true);
});

test("releases the baseline when decoding the current image fails", async () => {
  const before = bitmap(1, 1);
  let decoded = false;
  await render(async () => {
    if (decoded) throw new Error("Invalid image");
    decoded = true;
    return before;
  });
  assert.equal(before.closed, true);
});
