import { groupSnapshots } from "./snapshot-groups.js";

export function buildScreenMatrix(screenshots) {
  const groups = groupSnapshots(screenshots);
  const localized = groups.filter((group) => group.variants.some((variant) => variant.locale));
  const other = groups.filter((group) => !group.variants.some((variant) => variant.locale));
  const locales = orderLocales(localized.flatMap((group) => group.variants.map((variant) => variant.locale)));
  const devices = orderDevices(localized.flatMap((group) => group.variants.map((variant) => variant.device)));
  return { localized, other, locales, devices };
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
  const requested = (parameters.get("locales") ?? "").split(",").filter((locale) => matrix.locales.includes(locale));
  const device = parameters.get("device");
  return {
    run: parameters.get("run"),
    query: parameters.get("q") ?? "",
    locales: requested.length ? requested : matrix.locales,
    device: matrix.devices.includes(device) ? device : matrix.devices[0] ?? null,
  };
}

export function screenViewerState(search, matrix) {
  const parameters = new URLSearchParams(search);
  const groups = [...matrix.localized, ...matrix.other];
  const index = Math.max(0, groups.findIndex((group) => group.key === parameters.get("screen")));
  const group = groups[index] ?? null;
  const locales = orderLocales(group?.variants.map((variant) => variant.locale) ?? []);
  const devices = orderDevices(group?.variants.map((variant) => variant.device) ?? []);
  const locale = locales.includes(parameters.get("locale")) ? parameters.get("locale") : locales[0] ?? null;
  const device = devices.includes(parameters.get("device")) ? parameters.get("device") : devices[0] ?? null;
  const compare = locales.includes(parameters.get("compare")) && parameters.get("compare") !== locale ? parameters.get("compare") : null;
  return { run: parameters.get("run"), groups, index, group, locales, devices, locale, device, compare };
}

export function screenViewerSearch({ run, screen, locale, device, compare }) {
  const parameters = new URLSearchParams();
  if (run) parameters.set("run", run);
  if (screen) parameters.set("screen", screen);
  if (locale) parameters.set("locale", locale);
  if (device) parameters.set("device", device);
  if (compare) parameters.set("compare", compare);
  const search = parameters.toString();
  return search ? `?${search}` : "";
}
