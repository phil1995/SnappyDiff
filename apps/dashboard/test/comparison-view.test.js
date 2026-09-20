import assert from "node:assert/strict";
import { test } from "node:test";
import { disposeViewer, selectEntry } from "../src/comparison-view.js";
import { initializeUI, state } from "../src/ui.js";

test("switching screenshots stops obsolete diff work and releases stale results", (t) => {
  const workers = [];
  const viewer = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
  const root = { querySelectorAll: () => [], querySelector: (selector) => selector === "#viewer" ? viewer : null };
  globalThis.document = { querySelector: () => root };
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage(message) { this.request = message; }
    terminate() { this.terminated = true; }
  };
  t.after(() => {
    disposeViewer();
    delete globalThis.document;
    delete globalThis.Worker;
  });
  initializeUI();
  state.mode = "highlight";
  state.entries = [
    { name: "first.png", baselineImageId: "before1", currentImageId: "after1" },
    { name: "second.png", baselineImageId: "before2", currentImageId: "after2" },
  ];

  selectEntry(0);
  selectEntry(1);
  assert.equal(workers.length, 2);
  assert.equal(workers[0].terminated, true);
  assert.notEqual(workers[1].terminated, true);

  let closed = false;
  workers[0].onmessage({ data: {
    requestId: workers[0].request.requestId,
    bitmap: { close() { closed = true; } },
  } });
  assert.equal(closed, true);

  disposeViewer();
  assert.equal(workers[1].terminated, true);
  assert.equal(state.worker, null);
});
