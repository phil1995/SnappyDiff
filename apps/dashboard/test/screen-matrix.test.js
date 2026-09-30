import assert from "node:assert/strict";
import { test } from "node:test";
import { buildScreenMatrix, orderLocales, parseScreenFilters, screenLabel, screenVariant, screenViewerSearch, screenViewerState } from "../src/screen-matrix.js";

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
    run: "run_1", query: "welcome", platform: "iphone-ipad", locales: ["de"], device: "iPadPro11",
  });
  assert.deepEqual(parseScreenFilters("?locales=xx&device=Watch", matrix), {
    run: null, query: "", platform: "iphone-ipad", locales: ["en", "de", "fr"], device: "iPhone15",
  });
});

test("resolves viewer state and drops a comparison with the same locale", () => {
  const matrix = buildScreenMatrix(screenshots);
  const viewer = screenViewerState("?screen=Onboarding%2FWelcome.png&locale=de&compare=de&device=iPhone15", matrix);
  assert.equal(viewer.index, 0);
  assert.equal(viewer.locale, "de");
  assert.equal(viewer.compare, null);
  assert.deepEqual(viewer.locales, ["en", "de"]);
  assert.equal(viewer.groups.length, 2);
  assert.equal(screenViewerState("?screen=Unknown.png", matrix).group, null);
  const fallback = screenViewerState("", matrix);
  assert.equal(fallback.group.key, "Onboarding/Welcome.png");
  assert.equal(fallback.locale, "en");
});

test("builds shareable viewer links", () => {
  assert.equal(screenViewerSearch({ run: null, screen: "Onboarding/Welcome.png", locale: "de", device: "iPhone15", compare: "en" }),
    "?screen=Onboarding%2FWelcome.png&locale=de&device=iPhone15&compare=en");
  assert.equal(screenViewerSearch({}), "");
});

const watchApp = [
  "App Tests/__Snapshots__/Localization/home.en-iPhone-17-Pro.png",
  "App Tests/__Snapshots__/Localization/home.de-small-iPhone.png",
  "App Tests/__Snapshots__/Localization/settings.en-small-iPhone.png",
  "Watch AppTests/__Snapshots__/Watch/scoreboard.en-Ultra-3.png",
  "Watch AppTests/__Snapshots__/Watch/scoreboard.de-small-Watch.png",
].map((name) => ({ name }));

test("groups devices that share screens into platforms", () => {
  const matrix = buildScreenMatrix(watchApp);
  assert.deepEqual(matrix.platforms.map(({ key, label, screens, devices, locales }) => ({ key, label, screens, devices, locales })), [
    { key: "iphone", label: "iPhone", screens: 2, devices: ["small-iPhone", "iPhone-17-Pro"], locales: ["en", "de"] },
    { key: "apple-watch", label: "Apple Watch", screens: 1, devices: ["small-Watch", "Ultra-3"], locales: ["en", "de"] },
  ]);
  assert.deepEqual(Object.fromEntries(matrix.localized.map((group) => [group.key.split("/").at(-1), group.platform])),
    { "home.png": "iphone", "settings.png": "iphone", "scoreboard.png": "apple-watch" });
  const watch = parseScreenFilters("?platform=apple-watch&device=iPhone-17-Pro", matrix);
  assert.equal(watch.platform, "apple-watch");
  assert.equal(watch.device, "small-Watch");
});

test("orders mixed platform labels consistently when devices tie", () => {
  const matrix = buildScreenMatrix([{ name: "A.en-iPadPro11.png" }, { name: "A.en-iPhone15.png" }]);
  assert.equal(matrix.platforms[0].label, "iPhone & iPad");
});

test("falls back to test paths when device names carry no platform", () => {
  const matrix = buildScreenMatrix([{ name: "Watch AppTests/__Snapshots__/A/one.en-large.png" }, { name: "Watch AppTests/__Snapshots__/A/one.de-small.png" }]);
  assert.equal(matrix.platforms[0].label, "Apple Watch");
});

test("keeps viewer navigation within the screen's platform", () => {
  const matrix = buildScreenMatrix(watchApp);
  const viewer = screenViewerState("?screen=Watch%20AppTests%2F__Snapshots__%2FWatch%2Fscoreboard.png", matrix);
  assert.deepEqual(viewer.groups.map((group) => group.key), ["Watch AppTests/__Snapshots__/Watch/scoreboard.png"]);
  assert.equal(viewer.index, 0);
});

test("shortens snapshot paths to the test name and its suite", () => {
  assert.deepEqual(screenLabel("PadelTick Watch AppTests/__Snapshots__/AdditionalWatchLocalizationSnapshotTests/enterSharingCode.png"),
    { title: "enterSharingCode", context: "AdditionalWatchLocalizationSnapshotTests" });
  assert.deepEqual(screenLabel("Welcome.png"), { title: "Welcome", context: "" });
});
