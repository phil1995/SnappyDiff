import { mountComments } from "./comments-panel.js";
import { commentLocation } from "./feedback.js";
import { buildScreenMatrix, parseScreenFilters, screenLabel, screenMatches, screenVariant, screenViewerSearch, screenViewerState } from "./screen-matrix.js";
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
  const [data, summary] = await Promise.all([
    loadScreens(projectId, run, { fresh: true }),
    api(`/api/v1/projects/${encodeURIComponent(projectId)}/comment-summary`),
  ]);
  if (routeGeneration !== state.routeGeneration) return;
  state.screens = data;
  const { project, source, matrix } = data;
  const openComments = new Map(summary.screenshots.map((item) => [item.screenshotName, item.open]));
  const filters = parseScreenFilters(location.search, matrix);
  const crumbs = `<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><a href="/projects/${encodeURIComponent(project.id)}" data-link>${escapeHtml(project.name)}</a><span>/</span><span>Screens</span></nav>`;
  const heading = `${crumbs}<span class="eyebrow">${escapeHtml(project.repositoryOwner)}/${escapeHtml(project.repositoryName)}</span><div class="title-row"><h1>${escapeHtml(project.name)}</h1></div>${projectTabs(project.id, "screens")}`;
  if (!source) {
    root.innerHTML = header(`${heading}<div class="empty">No completed run on <span class="sha">${escapeHtml(project.defaultBranch)}</span> yet. Screens appear here after the first default-branch upload.</div>`);
    return;
  }
  const empty = !matrix.localized.length && !matrix.other.length;
  root.innerHTML = header(`${heading}${sourceSummary(project.id, source, run)}${empty ? `<div class="empty">This run has no screenshots.</div>` : `<div id="screen-controls"></div><div id="screen-grid"></div><div id="screen-other"></div>`}`);
  if (empty) return;
  const platformOf = () => matrix.platforms.find((platform) => platform.key === filters.platform) ?? null;
  const render = () => {
    const controls = root.querySelector("#screen-controls");
    if (controls) controls.innerHTML = matrix.localized.length ? screenControls(matrix, filters, platformOf()) : "";
    renderGrid(project.id, matrix, filters, openComments);
    renderOther(project.id, matrix, filters, openComments);
  };
  render();
  const sync = () => history.replaceState({}, "", `${screensPath(project.id)}${screensSearch(filters, matrix, platformOf())}`);
  const controls = root.querySelector("#screen-controls");
  controls.addEventListener("input", (event) => {
    if (!event.target.matches("[data-screen-search]")) return;
    filters.query = event.target.value;
    sync();
    applySearch(filters.query);
  });
  controls.addEventListener("change", (event) => {
    if (!event.target.matches("[data-screen-device]")) return;
    filters.device = event.target.value;
    sync();
    render();
  });
  controls.addEventListener("click", (event) => {
    const platformButton = event.target.closest("[data-platform]");
    if (platformButton) {
      const platform = matrix.platforms.find((item) => item.key === platformButton.dataset.platform);
      if (!platform || platform.key === filters.platform) return;
      Object.assign(filters, { platform: platform.key, device: platform.devices[0] ?? null, locales: platform.locales });
      sync();
      render();
      return;
    }
    const chip = event.target.closest("[data-locale-chip]");
    if (!chip) return;
    const locale = chip.dataset.localeChip;
    const selected = new Set(filters.locales);
    if (selected.has(locale) && selected.size > 1) selected.delete(locale); else selected.add(locale);
    filters.locales = (platformOf()?.locales ?? matrix.locales).filter((value) => selected.has(value));
    sync();
    render();
  });
}

function screensSearch(filters, matrix, platform) {
  const parameters = new URLSearchParams();
  const devices = platform?.devices ?? matrix.devices;
  const locales = platform?.locales ?? matrix.locales;
  if (filters.run) parameters.set("run", filters.run);
  if (filters.query) parameters.set("q", filters.query);
  if (platform && platform.key !== matrix.platforms[0]?.key) parameters.set("platform", platform.key);
  if (filters.device && filters.device !== devices[0]) parameters.set("device", filters.device);
  if (filters.locales.length !== locales.length) parameters.set("locales", filters.locales.join(","));
  const search = parameters.toString();
  return search ? `?${search}` : "";
}

function screenControls(matrix, filters, platform) {
  const devices = platform?.devices ?? matrix.devices;
  const locales = platform?.locales ?? matrix.locales;
  const platforms = matrix.platforms.length > 1
    ? `<div class="screens-platforms"><span>Platform</span><div class="segmented" role="group" aria-label="Platform">${matrix.platforms.map((item) => `<button type="button" class="tool ${item.key === filters.platform ? "active" : ""}" data-platform="${escapeHtml(item.key)}" aria-pressed="${item.key === filters.platform}">${escapeHtml(item.label)} <span class="tool-count">${item.screens}</span></button>`).join("")}</div></div>`
    : "";
  const deviceSelect = devices.length > 1
    ? `<label class="screens-device">Device<select data-screen-device>${devices.map((device) => `<option value="${escapeHtml(device)}" ${device === filters.device ? "selected" : ""}>${escapeHtml(device)}</option>`).join("")}</select></label>`
    : "";
  const chips = locales.map((locale) => `<button type="button" class="chip" data-locale-chip="${escapeHtml(locale)}" aria-pressed="${filters.locales.includes(locale)}">${escapeHtml(locale)}</button>`).join("");
  return `<div class="screens-controls">${platforms}<label class="screens-search">Search<input type="search" data-screen-search placeholder="Filter screens…" value="${escapeHtml(filters.query)}"></label>${deviceSelect}<div class="screens-locales"><span>Languages</span><div class="chips" role="group" aria-label="Visible languages">${chips}</div></div></div>`;
}

function screenName(name) {
  const { title, context } = screenLabel(name);
  return `<span class="screen-name" title="${escapeHtml(name)}"><strong>${escapeHtml(title)}</strong>${context ? `<small>${escapeHtml(context)}</small>` : ""}</span>`;
}

function viewerLink(projectId, filters, group, locale, device) {
  return `${screensPath(projectId)}/view${screenViewerSearch({ run: filters.run, screen: group.key, locale, device })}`;
}

function thumbnail(variant, label, openComments) {
  const entry = variant.entry;
  const count = openComments?.get(entry.name) ?? 0;
  const badge = count ? `<span class="comment-badge" title="${count} open ${count === 1 ? "comment" : "comments"}">${count}</span>` : "";
  if (!entry.imageId) return `<span class="screen-missing">Expired</span>${badge}`;
  const size = entry.width && entry.height ? ` width="${entry.width}" height="${entry.height}"` : "";
  return `<img src="${imageUrl(entry.imageId)}" alt="${escapeHtml(label)}" loading="lazy" decoding="async"${size}>${badge}`;
}

function renderGrid(projectId, matrix, filters, openComments) {
  const container = root.querySelector("#screen-grid");
  if (!container) return;
  const groups = matrix.localized.filter((group) => !filters.platform || group.platform === filters.platform);
  if (!groups.length) { container.innerHTML = ""; return; }
  const head = filters.locales.map((locale) => `<th scope="col">${escapeHtml(locale)}</th>`).join("");
  const rows = groups.map((group) => {
    const cells = filters.locales.map((locale) => {
      const variant = screenVariant(group, locale, filters.device);
      if (!variant) return `<td><span class="screen-missing" title="No ${escapeHtml(locale)} screenshot for ${escapeHtml(filters.device ?? "this device")}">Missing</span></td>`;
      return `<td><a class="screen-cell" href="${viewerLink(projectId, filters, group, locale, filters.device)}" data-link aria-label="${escapeHtml(`${group.name} in ${locale}`)}">${thumbnail(variant, `${group.name} · ${locale}`, openComments)}</a></td>`;
    }).join("");
    return `<tr data-screen-name="${escapeHtml(group.name.toLowerCase())}" ${screenMatches(group, filters.query) ? "" : "hidden"}><th scope="row">${screenName(group.name)}</th>${cells}</tr>`;
  }).join("");
  container.innerHTML = `<div class="section-head"><h2>Localized screens</h2><span class="muted">${groups.length} screens · ${filters.locales.length} languages</span></div><div class="screen-matrix"><table><thead><tr><th scope="col">Screen</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderOther(projectId, matrix, filters, openComments) {
  const container = root.querySelector("#screen-other");
  if (!container) return;
  if (!matrix.other.length) { container.innerHTML = ""; return; }
  const cards = matrix.other.map((group) => {
    const variant = group.variants[0];
    return `<a class="screen-card" href="${viewerLink(projectId, filters, group, null, variant.device)}" data-link data-screen-name="${escapeHtml(group.name.toLowerCase())}" ${screenMatches(group, filters.query) ? "" : "hidden"}><span class="screen-card-image">${thumbnail(variant, group.name, openComments)}</span>${screenName(group.name)}</a>`;
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
  const crumbs = `<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><a href="/projects/${encodeURIComponent(project.id)}" data-link>${escapeHtml(project.name)}</a><span>/</span><a href="${gridLink}" data-link>Screens</a><span>/</span><span title="${escapeHtml(group?.name ?? "")}">${escapeHtml(group ? screenLabel(group.name).title : "Screen")}</span></nav>`;
  if (!group) {
    const original = viewer.comment ? await api(`/api/v1/comments/${encodeURIComponent(viewer.comment)}`).catch(() => null) : null;
    if (routeGeneration !== state.routeGeneration) return;
    const comment = original?.comment;
    const link = comment && comment.runId !== run
      ? `${screensPath(project.id)}/view${screenViewerSearch({ run: comment.runId, ...commentLocation(comment), comment: comment.id })}`
      : null;
    root.innerHTML = header(`${crumbs}<div class="empty">This screen is not part of the ${run ? "selected run" : "current screens"}.${link ? `<p><a class="button primary" href="${link}" data-link>Open the build this comment was written on</a></p>` : ""}</div>`);
    return;
  }
  const go = (changes) => {
    const next = { run, screen: group.key, locale: viewer.locale, device: viewer.device, compare: viewer.compare, comment: null, ...changes };
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
  const panels = [viewer.locale, viewer.compare].filter((locale, index) => index === 0 || locale).map((locale, index) => screenPanel(group, locale, viewer.device, index === 0)).join("");
  const primary = screenVariant(group, viewer.locale, viewer.device);
  const navigation = `<div class="entry-navigation"><button class="button" data-screen-prev ${viewer.index > 0 ? "" : "disabled"}>← Previous</button><span><b>${viewer.index + 1}</b> of <b>${viewer.groups.length}</b></span><button class="button" data-screen-next ${viewer.index < viewer.groups.length - 1 ? "" : "disabled"}>Next →</button></div>`;
  root.innerHTML = header(`${crumbs}<div class="screen-viewer-head"><div><span class="eyebrow">${escapeHtml(screenLabel(group.name).context || "Screen")}</span><h1 class="screen-title" title="${escapeHtml(group.name)}">${escapeHtml(screenLabel(group.name).title)}</h1></div>${navigation}</div>${controls}<div class="screen-workspace"><div class="screen-panels ${viewer.compare ? "compare" : ""} ${state.screenFit ? "fit" : "actual"}">${panels}</div><aside class="comments-panel" data-comments-panel aria-label="Feedback">${primary ? `<div class="spinner"></div>` : `<p class="muted">Pick a language and device with a screenshot to see feedback.</p>`}</aside></div><p class="muted keyboard-hint">Keyboard: <kbd>j</kbd>/<kbd>k</kbd> next or previous screen · <kbd>←</kbd>/<kbd>→</kbd> switch language · <kbd>c</kbd> add comment</p>`);
  document.title = `${screenLabel(group.name).title} · SnappyDiff`;
  root.querySelector("[data-viewer-locale]")?.addEventListener("change", (event) => go({ locale: event.target.value, compare: viewer.compare === event.target.value ? null : viewer.compare }));
  root.querySelector("[data-viewer-compare]")?.addEventListener("change", (event) => go({ compare: event.target.value || null }));
  root.querySelector("[data-viewer-device]")?.addEventListener("change", (event) => go({ device: event.target.value }));
  root.querySelectorAll("[data-viewer-fit]").forEach((button) => button.addEventListener("click", () => { state.screenFit = button.dataset.viewerFit === "fit"; go({}); }));
  root.querySelector("[data-screen-prev]")?.addEventListener("click", () => step(-1));
  root.querySelector("[data-screen-next]")?.addEventListener("click", () => step(1));
  const viewerGeneration = ++state.screenViewerGeneration;
  const comments = primary && data.source
    ? mountComments({
      projectId: project.id,
      panel: root.querySelector("[data-comments-panel]"),
      stage: primary.entry.imageId ? root.querySelector("[data-annotated]") : null,
      screenshotName: primary.entry.name,
      runId: data.source.id,
      currentImageId: primary.entry.imageId,
      highlightId: viewer.comment,
      isCurrent: () => viewerGeneration === state.screenViewerGeneration && routeGeneration === state.routeGeneration,
    }).catch((error) => {
      const panel = root.querySelector("[data-comments-panel]");
      if (panel && viewerGeneration === state.screenViewerGeneration) panel.innerHTML = `<div class="form-error">${escapeHtml(error.message)}</div>`;
      return null;
    })
    : Promise.resolve(null);
  state.keyHandler = (event) => {
    if (["c", "C"].includes(event.key)) { event.preventDefault(); comments.then((panel) => panel?.startDraft()); return; }
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

function screenPanel(group, locale, device, annotated = false) {
  const variant = screenVariant(group, locale, device);
  const label = [locale ?? "Default", device].filter(Boolean).join(" · ");
  const body = variant
    ? variant.entry.imageId
      ? annotatedImage(`<img src="${imageUrl(variant.entry.imageId)}" alt="${escapeHtml(`${group.name} · ${label}`)}"${variant.entry.width ? ` width="${variant.entry.width}" height="${variant.entry.height}"` : ""}>`, annotated)
      : `<div class="image-error">This screenshot has expired under the project retention policy.</div>`
    : `<div class="screen-missing large">No ${escapeHtml(locale ?? "")} screenshot for ${escapeHtml(device ?? "this device")}.</div>`;
  return `<figure class="screen-panel"><figcaption><span class="pill">${escapeHtml(label)}</span>${variant?.entry.width ? `<span class="muted">${variant.entry.width}×${variant.entry.height}</span>` : ""}</figcaption><div class="screen-panel-stage">${body}</div></figure>`;
}

function annotatedImage(image, annotated) {
  return annotated ? `<div class="annotated-image" data-annotated>${image}<div class="annotation-layer" data-annotation-layer></div></div>` : image;
}
