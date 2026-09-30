import { groupSnapshots } from "./snapshot-groups.js";

const platformPatterns = [
  ["Apple Watch", /watch|ultra/i],
  ["iPhone", /iphone/i],
  ["iPad", /ipad/i],
  ["Apple Vision Pro", /vision/i],
  ["Apple TV", /(^|[^a-z])tv([^a-z]|$)|appletv/i],
  ["Mac", /(^|[^a-z])mac/i],
];

export function buildScreenMatrix(screenshots) {
  const groups = groupSnapshots(screenshots);
  const localized = groups.filter((group) => group.variants.some((variant) => variant.locale));
  const other = groups.filter((group) => !group.variants.some((variant) => variant.locale));
  const locales = orderLocales(localized.flatMap((group) => group.variants.map((variant) => variant.locale)));
  const devices = orderDevices(localized.flatMap((group) => group.variants.map((variant) => variant.device)));
  return { localized, other, locales, devices, platforms: groupPlatforms(localized) };
}

// Devices that capture the same screens belong to one platform, e.g. an iPhone app's screens never
// appear on Apple Watch models. The label comes from device names, falling back to the test paths.
function groupPlatforms(localized) {
  const parent = new Map();
  const find = (device) => {
    while (parent.get(device) !== device) device = parent.get(device);
    return device;
  };
  for (const group of localized) {
    const devices = [...new Set(group.variants.map((variant) => variant.device ?? ""))];
    devices.forEach((device) => { if (!parent.has(device)) parent.set(device, device); });
    devices.slice(1).forEach((device) => parent.set(find(device), find(devices[0])));
  }
  const components = new Map();
  for (const group of localized) {
    const root = find(group.variants[0].device ?? "");
    const component = components.get(root) ?? { groups: [], variants: [] };
    component.groups.push(group);
    component.variants.push(...group.variants);
    components.set(root, component);
  }
  const used = new Map();
  const platforms = [...components.values()].sort((left, right) => right.groups.length - left.groups.length).map((component) => {
    const label = platformLabel(component);
    const count = (used.get(label) ?? 0) + 1;
    used.set(label, count);
    const name = count > 1 ? `${label} ${count}` : label;
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "devices";
    component.groups.forEach((group) => { group.platform = key; });
    return {
      key,
      label: name,
      screens: component.groups.length,
      devices: orderDevices(component.variants.map((variant) => variant.device)),
      locales: orderLocales(component.variants.map((variant) => variant.locale)),
    };
  });
  return platforms;
}

function platformLabel(component) {
  const vote = (texts) => {
    const scores = new Map();
    texts.forEach((text) => {
      const match = platformPatterns.find(([, pattern]) => pattern.test(text));
      if (match) scores.set(match[0], (scores.get(match[0]) ?? 0) + 1);
    });
    const rank = (label) => platformPatterns.findIndex(([name]) => name === label);
    return [...scores].sort((left, right) => right[1] - left[1] || rank(left[0]) - rank(right[0])).map(([label]) => label);
  };
  const labels = vote(component.variants.map((variant) => variant.device ?? ""));
  if (labels.length) return labels.slice(0, 2).join(" & ");
  return vote(component.groups.map((group) => group.name.split("/")[0]))[0] ?? "Devices";
}

export function screenLabel(name) {
  const parts = String(name ?? "").replace(/\.png$/i, "").split("/").filter((part) => part && part !== "__Snapshots__");
  return { title: parts.at(-1) ?? String(name ?? ""), context: parts.length > 1 ? parts.at(-2) : "" };
}

export function orderLocales(values) {
  const unique = [...new Set(values.filter(Boolean))];
  const source = (locale) => locale === "en" || locale.startsWith("en-") ? 0 : 1;
  return unique.sort((left, right) => source(left) - source(right) || left.localeCompare(right));
}

function orderDevices(values) {
  const counts = new Map();
  values.filter(Boolean).forEach((device) => counts.set(device, (counts.get(device) ?? 0) + 1));
  return [...counts.keys()].sort((left, right) => counts.get(right) - counts.get(left) || left.localeCompare(right));
}

export function screenVariant(group, locale, device) {
  return group?.variants.find((variant) => variant.locale === locale && (variant.device === device || !device)) ?? null;
}

export function screenMatches(group, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  return !needle || group.name.toLowerCase().includes(needle);
}

export function parseScreenFilters(search, matrix) {
  const parameters = new URLSearchParams(search);
  const platform = matrix.platforms.find((item) => item.key === parameters.get("platform")) ?? matrix.platforms[0] ?? null;
  const locales = platform?.locales ?? matrix.locales;
  const devices = platform?.devices ?? matrix.devices;
  const requested = (parameters.get("locales") ?? "").split(",").filter((locale) => locales.includes(locale));
  const device = parameters.get("device");
  return {
    run: parameters.get("run"),
    query: parameters.get("q") ?? "",
    platform: platform?.key ?? null,
    locales: requested.length ? requested : locales,
    device: devices.includes(device) ? device : devices[0] ?? null,
  };
}

export function screenViewerState(search, matrix) {
  const parameters = new URLSearchParams(search);
  const all = [...matrix.localized, ...matrix.other];
  const requested = parameters.get("screen");
  const selected = requested ? all.find((group) => group.key === requested) ?? null : all[0] ?? null;
  // Previous and next stay within the selected screen's platform, or within the unlocalized screens.
  const groups = selected?.platform ? matrix.localized.filter((group) => group.platform === selected.platform)
    : selected ? matrix.other : all;
  const index = selected ? groups.indexOf(selected) : -1;
  const group = selected;
  const locales = orderLocales(group?.variants.map((variant) => variant.locale) ?? []);
  const devices = orderDevices(group?.variants.map((variant) => variant.device) ?? []);
  const locale = locales.includes(parameters.get("locale")) ? parameters.get("locale") : locales[0] ?? null;
  const device = devices.includes(parameters.get("device")) ? parameters.get("device") : devices[0] ?? null;
  const compare = locales.includes(parameters.get("compare")) && parameters.get("compare") !== locale ? parameters.get("compare") : null;
  return { run: parameters.get("run"), comment: parameters.get("comment"), groups, index, group, locales, devices, locale, device, compare };
}

export function screenViewerSearch({ run, screen, locale, device, compare, comment }) {
  const parameters = new URLSearchParams();
  if (run) parameters.set("run", run);
  if (screen) parameters.set("screen", screen);
  if (locale) parameters.set("locale", locale);
  if (device) parameters.set("device", device);
  if (compare) parameters.set("compare", compare);
  if (comment) parameters.set("comment", comment);
  const search = parameters.toString();
  return search ? `?${search}` : "";
}
