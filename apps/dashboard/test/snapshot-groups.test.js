import assert from "node:assert/strict";
import test from "node:test";

import { groupKind, groupSnapshots, selectSnapshotVariant, snapshotVariant } from "../src/snapshot-groups.js";

test("extracts locale and device variants from snapshot names", () => {
  assert.deepEqual(snapshotVariant({ name: "Tests/__Snapshots__/Flow/screen.en-iPhone-17-Pro.png" }), {
    key: "Tests/__Snapshots__/Flow/screen.png",
    name: "Tests/__Snapshots__/Flow/screen.png",
    locale: "en",
    device: "iPhone-17-Pro",
  });
  assert.deepEqual(snapshotVariant({ name: "plain.png" }), {
    key: "plain.png", name: "plain.png", locale: null, device: null,
  });
});

test("groups localized device variants without changing their source entries", () => {
  const entries = [
    { name: "screen.en-small-iPhone.png", kind: "added" },
    { name: "screen.de-small-iPhone.png", kind: "added" },
    { name: "other.en-small-iPhone.png", kind: "changed" },
  ];
  const groups = groupSnapshots(entries);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].name, "screen.png");
  assert.deepEqual(groups[0].variants.map(({ locale, device, entryIndex }) => ({ locale, device, entryIndex })), [
    { locale: "en", device: "small-iPhone", entryIndex: 0 },
    { locale: "de", device: "small-iPhone", entryIndex: 1 },
  ]);
  assert.equal(groupKind(groups[0]), "added");
});

test("keeps the preferred locale and device when selecting the next group", () => {
  const [group] = groupSnapshots([
    { name: "screen.de-small-iPhone.png" },
    { name: "screen.en-small-iPhone.png" },
    { name: "screen.de-iPhone-17-Pro.png" },
    { name: "screen.en-iPhone-17-Pro.png" },
  ]);
  assert.equal(selectSnapshotVariant(group, "en", "iPhone-17-Pro").entry.name, "screen.en-iPhone-17-Pro.png");
  assert.equal(selectSnapshotVariant(group, "fr", "iPhone-17-Pro").entry.name, "screen.de-iPhone-17-Pro.png");
});
