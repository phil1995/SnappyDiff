import assert from "node:assert/strict";
import test from "node:test";

import { comparisonNavigation } from "../src/comparison-navigation.js";

test("enables next when another comparison page is appended", () => {
  assert.equal(comparisonNavigation(99, 100).nextDisabled, true);
  assert.deepEqual(comparisonNavigation(99, 101), {
    selected: 99,
    position: 100,
    total: 101,
    previousDisabled: false,
    nextDisabled: false,
  });
});

test("clamps comparison navigation at both ends", () => {
  assert.equal(comparisonNavigation(-1, 3).selected, 0);
  assert.equal(comparisonNavigation(9, 3).selected, 2);
  assert.equal(comparisonNavigation(0, 0).position, 0);
});
