import assert from "node:assert/strict";
import { test } from "node:test";
import { disposeViewer, selectEntry, selectNextEntry } from "../src/comparison-view.js";
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

test("next loads through variant-only pages until another snapshot is available", async (t) => {
  const entries = { innerHTML: "" };
  const total = { textContent: "" };
  const nextButton = { disabled: false };
  const loadMore = { dataset: { loadMore: "page-2" }, disabled: false, remove() { this.removed = true; } };
  const viewer = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
  const root = {
    querySelectorAll: () => [],
    querySelector(selector) {
      if (selector === "#entries") return entries;
      if (selector === ".change-total") return total;
      if (selector === "[data-entry-next]") return nextButton;
      if (selector === "[data-load-more]") return loadMore.removed ? null : loadMore;
      if (selector === "#viewer") return viewer;
      return null;
    },
  };
  const pages = [
    { entries: [{ name: "screen.de-phone.png", kind: "added" }], nextCursor: "page-3" },
    { entries: [{ name: "other.en-phone.png", kind: "added" }], nextCursor: null },
  ];
  globalThis.document = { querySelector: () => root };
  globalThis.fetch = async () => new Response(JSON.stringify(pages.shift()), { headers: { "content-type": "application/json" } });
  t.after(() => {
    delete globalThis.document;
    delete globalThis.fetch;
  });
  initializeUI();
  state.comparisonId = "comparison";
  state.comparisonNextCursor = "page-2";
  state.entries = [{ name: "screen.en-phone.png", kind: "added" }];

  await selectNextEntry();

  assert.equal(pages.length, 0);
  assert.equal(state.snapshotGroups.length, 2);
  assert.equal(state.selected, 1);
  assert.equal(state.snapshotGroups[state.selected].name, "other.png");
  assert.equal(state.comparisonNextCursor, null);
  assert.equal(loadMore.removed, true);
});
