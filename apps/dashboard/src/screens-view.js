import { buildScreenMatrix, parseScreenFilters, screenMatches, screenVariant, screenViewerSearch, screenViewerState } from "./screen-matrix.js";
import { api, escapeHtml, formatDate, header, projectTabs, root, shortSha, state } from "./ui.js";

const sourceLabels = {
  baseline: "Active baseline",
  rollback: "Rolled-back baseline",
  default_branch: "Latest default-branch run",
  run: "Selected run",
};

async function loadScreens(projectId, run, { fresh = false } = {}) {
  const cacheKey = `${projectId}:${run ?? ""}`;
  if (!fresh && state.screens?.cacheKey === cacheKey) return state.screens;
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/screens${run ? `?run=${encodeURIComponent(run)}` : ""}`;
  const first = await api(base);
  const screenshots = [...first.screenshots];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await api(`${base}${run ? "&" : "?"}after=${encodeURIComponent(cursor)}`);
    screenshots.push(...page.screenshots);
    cursor = page.nextCursor;
  }
  return { cacheKey, project: first.project, source: first.source, matrix: buildScreenMatrix(screenshots) };
}

const imageUrl = (id) => `/api/v1/images/${encodeURIComponent(id)}/content`;
const screensPath = (projectId) => `/projects/${encodeURIComponent(projectId)}/screens`;

function sourceSummary(projectId, source, run) {
  if (!source) return "";
  const pullRequest = source.pullRequestNumber ? ` · PR #${source.pullRequestNumber}` : "";
  const reset = run ? `<a class="button" href="${screensPath(projectId)}" data-link>Show current baseline</a>` : "";
  return `<div class="screens-source"><div><span class="eyebrow">${escapeHtml(sourceLabels[source.kind] ?? "Screens")}</span><p><strong>${escapeHtml(source.branch)}</strong>${escapeHtml(pullRequest)} · <span class="sha">${escapeHtml(shortSha(source.commitSha))}</span> · captured ${formatDate(source.completedAt ?? source.createdAt)}</p></div>${reset}</div>`;
}

export async function renderScreens(projectId, routeGeneration) {
  const run = new URLSearchParams(location.search).get("run");
  const data = await loadScreens(projectId, run, { fresh: true });
  if (routeGeneration !== state.routeGeneration) return;
  state.screens = data;
  const { project, source, matrix } = data;
  const filters = parseScreenFilters(location.search, matrix);
  const crumbs = `<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><a href="/projects/${encodeURIComponent(project.id)}" data-link>${escapeHtml(project.name)}</a><span>/</span><span>Screens</span></nav>`;
  const heading = `${crumbs}<span class="eyebrow">${escapeHtml(project.repositoryOwner)}/${escapeHtml(project.repositoryName)}</span><div class="title-row"><h1>${escapeHtml(project.name)}</h1></div>${projectTabs(project.id, "screens")}`;
  if (!source) {
    root.innerHTML = header(`${heading}<div class="empty">No completed run on <span class="sha">${escapeHtml(project.defaultBranch)}</span> yet. Screens appear here after the first default-branch upload.</div>`);
    return;
  }
  const empty = !matrix.localized.length && !matrix.other.length;
  const controls = matrix.localized.length ? screenControls(matrix, filters) : "";
  root.innerHTML = header(`${heading}${sourceSummary(project.id, source, run)}${empty ? `<div class="empty">This run has no screenshots.</div>` : `${controls}<div id="screen-grid"></div><div id="screen-other"></div>`}`);
  if (empty) return;
  const render = () => {
    renderGrid(project.id, matrix, filters);
    renderOther(project.id, matrix, filters);
  };
  render();
  const sync = () => history.replaceState({}, "", `${screensPath(project.id)}${screensSearch(filters, matrix)}`);
  root.querySelector("[data-screen-search]")?.addEventListener("input", (event) => {
    filters.query = event.target.value;
    sync();
    applySearch(filters.query);
  });
  root.querySelector("[data-screen-device]")?.addEventListener("change", (event) => {
    filters.device = event.target.value;
    sync();
    render();
  });
  root.querySelector("[data-locale-chips]")?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-locale-chip]");
    if (!chip) return;
    const locale = chip.dataset.localeChip;
    const selected = new Set(filters.locales);
    if (selected.has(locale) && selected.size > 1) selected.delete(locale); else selected.add(locale);
    filters.locales = matrix.locales.filter((value) => selected.has(value));
    root.querySelectorAll("[data-locale-chip]").forEach((button) => button.setAttribute("aria-pressed", String(selected.has(button.dataset.localeChip))));
    sync();
    render();
  });
}

function screensSearch(filters, matrix) {
  const parameters = new URLSearchParams();
  if (filters.run) parameters.set("run", filters.run);
  if (filters.query) parameters.set("q", filters.query);
  if (filters.device && filters.device !== matrix.devices[0]) parameters.set("device", filters.device);
  if (filters.locales.length !== matrix.locales.length) parameters.set("locales", filters.locales.join(","));
  const search = parameters.toString();
  return search ? `?${search}` : "";
}

function screenControls(matrix, filters) {
  const devices = matrix.devices.length > 1
    ? `<label class="screens-device">Device<select data-screen-device>${matrix.devices.map((device) => `<option value="${escapeHtml(device)}" ${device === filters.device ? "selected" : ""}>${escapeHtml(device)}</option>`).join("")}</select></label>`
    : "";
  const chips = matrix.locales.map((locale) => `<button type="button" class="chip" data-locale-chip="${escapeHtml(locale)}" aria-pressed="${filters.locales.includes(locale)}">${escapeHtml(locale)}</button>`).join("");
  return `<div class="screens-controls"><label class="screens-search">Search<input type="search" data-screen-search placeholder="Filter screens…" value="${escapeHtml(filters.query)}"></label>${devices}<div class="screens-locales"><span>Languages</span><div class="chips" data-locale-chips role="group" aria-label="Visible languages">${chips}</div></div></div>`;
}

function viewerLink(projectId, filters, group, locale, device) {
  return `${screensPath(projectId)}/view${screenViewerSearch({ run: filters.run, screen: group.key, locale, device })}`;
}

function thumbnail(variant, label) {
  const entry = variant.entry;
  if (!entry.imageId) return `<span class="screen-missing">Expired</span>`;
  const size = entry.width && entry.height ? ` width="${entry.width}" height="${entry.height}"` : "";
  return `<img src="${imageUrl(entry.imageId)}" alt="${escapeHtml(label)}" loading="lazy" decoding="async"${size}>`;
}

function renderGrid(projectId, matrix, filters) {
  const container = root.querySelector("#screen-grid");
  if (!container) return;
  if (!matrix.localized.length) { container.innerHTML = ""; return; }
  const head = filters.locales.map((locale) => `<th scope="col">${escapeHtml(locale)}</th>`).join("");
  const rows = matrix.localized.map((group) => {
    const cells = filters.locales.map((locale) => {
      const variant = screenVariant(group, locale, filters.device);
      if (!variant) return `<td><span class="screen-missing" title="No ${escapeHtml(locale)} screenshot for ${escapeHtml(filters.device ?? "this device")}">Missing</span></td>`;
      return `<td><a class="screen-cell" href="${viewerLink(projectId, filters, group, locale, filters.device)}" data-link aria-label="${escapeHtml(`${group.name} in ${locale}`)}">${thumbnail(variant, `${group.name} · ${locale}`)}</a></td>`;
    }).join("");
    return `<tr data-screen-name="${escapeHtml(group.name.toLowerCase())}" ${screenMatches(group, filters.query) ? "" : "hidden"}><th scope="row"><span class="screen-name">${escapeHtml(group.name)}</span></th>${cells}</tr>`;
  }).join("");
  container.innerHTML = `<div class="section-head"><h2>Localized screens</h2><span class="muted">${matrix.localized.length} screens · ${matrix.locales.length} languages</span></div><div class="screen-matrix"><table><thead><tr><th scope="col">Screen</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderOther(projectId, matrix, filters) {
  const container = root.querySelector("#screen-other");
  if (!container) return;
  if (!matrix.other.length) { container.innerHTML = ""; return; }
  const cards = matrix.other.map((group) => {
    const variant = group.variants[0];
    return `<a class="screen-card" href="${viewerLink(projectId, filters, group, null, variant.device)}" data-link data-screen-name="${escapeHtml(group.name.toLowerCase())}" ${screenMatches(group, filters.query) ? "" : "hidden"}><span class="screen-card-image">${thumbnail(variant, group.name)}</span><span class="screen-name">${escapeHtml(group.name)}</span></a>`;
  }).join("");
  const title = matrix.localized.length ? "Other screens" : "Screens";
  container.innerHTML = `<div class="section-head"><h2>${title}</h2><span class="muted">${matrix.other.length} without a language suffix</span></div><div class="screen-gallery">${cards}</div>`;
}

function applySearch(query) {
  const needle = query.trim().toLowerCase();
  root.querySelectorAll("[data-screen-name]").forEach((element) => { element.hidden = Boolean(needle) && !element.dataset.screenName.includes(needle); });
}

export async function renderScreenViewer(projectId, routeGeneration) {
  const run = new URLSearchParams(location.search).get("run");
  const data = await loadScreens(projectId, run);
  if (routeGeneration !== state.routeGeneration) return;
  state.screens = data;
  const { project, matrix } = data;
  const viewer = screenViewerState(location.search, matrix);
  const { group } = viewer;
  const gridLink = `${screensPath(project.id)}${run ? `?run=${encodeURIComponent(run)}` : ""}`;
  const crumbs = `<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><a href="/projects/${encodeURIComponent(project.id)}" data-link>${escapeHtml(project.name)}</a><span>/</span><a href="${gridLink}" data-link>Screens</a><span>/</span><span>${escapeHtml(group?.name ?? "Screen")}</span></nav>`;
  if (!group) {
    root.innerHTML = header(`${crumbs}<div class="empty">This screen is not part of the selected run.</div>`);
    return;
  }
  const go = (changes) => {
    const next = { run, screen: group.key, locale: viewer.locale, device: viewer.device, compare: viewer.compare, ...changes };
    history.replaceState({}, "", `${screensPath(project.id)}/view${screenViewerSearch(next)}`);
    renderScreenViewer(projectId, routeGeneration);
  };
  const step = (offset) => {
    const target = viewer.groups[viewer.index + offset];
    if (target) go({ screen: target.key });
  };
  const select = (label, attribute, values, selected, none) => values.length
    ? `<label>${label}<select ${attribute}>${none ? `<option value="">${none}</option>` : ""}${values.map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}</select></label>`
    : "";
  const compareOptions = viewer.locales.filter((locale) => locale !== viewer.locale);
  const controls = `<div class="screen-toolbar">${select("Language", "data-viewer-locale", viewer.locales, viewer.locale)}${select("Compare with", "data-viewer-compare", compareOptions, viewer.compare, "None")}${select("Device", "data-viewer-device", viewer.devices, viewer.device)}<span class="tool-spacer"></span><div class="segmented" role="group" aria-label="Image size"><button type="button" class="tool ${state.screenFit ? "active" : ""}" data-viewer-fit="fit">Fit</button><button type="button" class="tool ${state.screenFit ? "" : "active"}" data-viewer-fit="actual">100%</button></div></div>`;
  const panels = [viewer.locale, viewer.compare].filter((locale, index) => index === 0 || locale).map((locale) => screenPanel(group, locale, viewer.device)).join("");
  const navigation = `<div class="entry-navigation"><button class="button" data-screen-prev ${viewer.index > 0 ? "" : "disabled"}>← Previous</button><span><b>${viewer.index + 1}</b> of <b>${viewer.groups.length}</b></span><button class="button" data-screen-next ${viewer.index < viewer.groups.length - 1 ? "" : "disabled"}>Next →</button></div>`;
  root.innerHTML = header(`${crumbs}<div class="screen-viewer-head"><div><span class="eyebrow">Screen</span><h1 class="screen-title">${escapeHtml(group.name)}</h1></div>${navigation}</div>${controls}<div class="screen-panels ${viewer.compare ? "compare" : ""} ${state.screenFit ? "fit" : "actual"}">${panels}</div><p class="muted keyboard-hint">Keyboard: <kbd>j</kbd>/<kbd>k</kbd> next or previous screen · <kbd>←</kbd>/<kbd>→</kbd> switch language</p>`);
  document.title = `${group.name} · SnappyDiff`;
  root.querySelector("[data-viewer-locale]")?.addEventListener("change", (event) => go({ locale: event.target.value, compare: viewer.compare === event.target.value ? null : viewer.compare }));
  root.querySelector("[data-viewer-compare]")?.addEventListener("change", (event) => go({ compare: event.target.value || null }));
  root.querySelector("[data-viewer-device]")?.addEventListener("change", (event) => go({ device: event.target.value }));
  root.querySelectorAll("[data-viewer-fit]").forEach((button) => button.addEventListener("click", () => { state.screenFit = button.dataset.viewerFit === "fit"; go({}); }));
  root.querySelector("[data-screen-prev]")?.addEventListener("click", () => step(-1));
  root.querySelector("[data-screen-next]")?.addEventListener("click", () => step(1));
  state.keyHandler = (event) => {
    if (["ArrowDown", "j", "J"].includes(event.key)) { event.preventDefault(); step(1); }
    if (["ArrowUp", "k", "K"].includes(event.key)) { event.preventDefault(); step(-1); }
    if (["ArrowLeft", "ArrowRight"].includes(event.key) && viewer.locales.length > 1) {
      event.preventDefault();
      const current = viewer.locales.indexOf(viewer.locale);
      const locale = viewer.locales[(current + (event.key === "ArrowRight" ? 1 : -1) + viewer.locales.length) % viewer.locales.length];
      go({ locale, compare: viewer.compare === locale ? null : viewer.compare });
    }
  };
}

function screenPanel(group, locale, device) {
  const variant = screenVariant(group, locale, device);
  const label = [locale ?? "Default", device].filter(Boolean).join(" · ");
  const body = variant
    ? variant.entry.imageId
      ? `<img src="${imageUrl(variant.entry.imageId)}" alt="${escapeHtml(`${group.name} · ${label}`)}"${variant.entry.width ? ` width="${variant.entry.width}" height="${variant.entry.height}"` : ""}>`
      : `<div class="image-error">This screenshot has expired under the project retention policy.</div>`
    : `<div class="screen-missing large">No ${escapeHtml(locale ?? "")} screenshot for ${escapeHtml(device ?? "this device")}.</div>`;
  return `<figure class="screen-panel"><figcaption><span class="pill">${escapeHtml(label)}</span>${variant?.entry.width ? `<span class="muted">${variant.entry.width}×${variant.entry.height}</span>` : ""}</figcaption><div class="screen-panel-stage">${body}</div></figure>`;
}
