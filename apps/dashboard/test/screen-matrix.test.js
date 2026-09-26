import assert from "node:assert/strict";
import { test } from "node:test";
import { buildScreenMatrix, orderLocales, parseScreenFilters, screenVariant, screenViewerSearch, screenViewerState } from "../src/screen-matrix.js";

const screenshots = [
  { name: "Examples/HomeScreen.png", imageId: "img_home" },
  { name: "Onboarding/Welcome.de-iPhone15.png", imageId: "img_de_phone" },
  { name: "Onboarding/Welcome.en-iPhone15.png", imageId: "img_en_phone" },
  { name: "Onboarding/Welcome.en-iPadPro11.png", imageId: "img_en_pad" },
  { name: "Settings/Account.fr-iPhone15.png", imageId: "img_fr_phone" },
];

test("separates localized screens from unlocalized ones", () => {
  const matrix = buildScreenMatrix(screenshots);
  assert.deepEqual(matrix.localized.map((group) => group.key), ["Onboarding/Welcome.png", "Settings/Account.png"]);
  assert.deepEqual(matrix.other.map((group) => group.key), ["Examples/HomeScreen.png"]);
  assert.deepEqual(matrix.locales, ["en", "de", "fr"]);
  assert.deepEqual(matrix.devices, ["iPhone15", "iPadPro11"]);
});

test("orders the English source locales first", () => {
  assert.deepEqual(orderLocales(["ja", "de", null, "en-GB", "en", "de"]), ["en", "en-GB", "de", "ja"]);
});

test("finds the variant for a locale and device without falling back to another language", () => {
  const [welcome, account] = buildScreenMatrix(screenshots).localized;
  assert.equal(screenVariant(welcome, "en", "iPadPro11")?.entry.imageId, "img_en_pad");
  assert.equal(screenVariant(welcome, "de", "iPadPro11"), null);
  assert.equal(screenVariant(account, "en", "iPhone15"), null);
});

test("reads grid filters from the URL and ignores unknown values", () => {
  const matrix = buildScreenMatrix(screenshots);
  assert.deepEqual(parseScreenFilters("?locales=de,xx&device=iPadPro11&q=welcome&run=run_1", matrix), {
    run: "run_1", query: "welcome", locales: ["de"], device: "iPadPro11",
  });
  assert.deepEqual(parseScreenFilters("?locales=xx&device=Watch", matrix), {
    run: null, query: "", locales: ["en", "de", "fr"], device: "iPhone15",
  });
});

test("resolves viewer state and drops a comparison with the same locale", () => {
  const matrix = buildScreenMatrix(screenshots);
  const viewer = screenViewerState("?screen=Onboarding%2FWelcome.png&locale=de&compare=de&device=iPhone15", matrix);
  assert.equal(viewer.index, 0);
  assert.equal(viewer.locale, "de");
  assert.equal(viewer.compare, null);
  assert.deepEqual(viewer.locales, ["en", "de"]);
  assert.equal(viewer.groups.length, 3);
  const fallback = screenViewerState("?screen=Unknown.png", matrix);
  assert.equal(fallback.group.key, "Onboarding/Welcome.png");
  assert.equal(fallback.locale, "en");
});

test("builds shareable viewer links", () => {
  assert.equal(screenViewerSearch({ run: null, screen: "Onboarding/Welcome.png", locale: "de", device: "iPhone15", compare: "en" }),
    "?screen=Onboarding%2FWelcome.png&locale=de&device=iPhone15&compare=en");
  assert.equal(screenViewerSearch({}), "");
});
