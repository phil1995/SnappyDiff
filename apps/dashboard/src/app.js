const root = document.querySelector("#app");
const state = { me: null, entries: [], selected: 0, mode: "overlay", zoom: 1, blinkTimer: null, worker: null };

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const shortSha = (value) => String(value ?? "").slice(0, 8);
const formatDate = (seconds) => seconds ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(seconds * 1000) : "—";
const formatBytes = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  if (response.status === 401) throw Object.assign(new Error("Authentication required"), { status: 401 });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body;
}

function header(content, full = false) {
  const account = state.me ? `<div class="account"><span>${escapeHtml(state.me.user.email)}</span><button data-logout>Sign out</button></div>` : "";
  return `<div class="shell"><header class="topbar"><a class="brand" href="/" data-link><span class="brand-mark">↗</span>SnappyDiff</a>${account}</header>${full ? content : `<main class="page">${content}</main>`}</div>`;
}

function errorPage(error) {
  root.innerHTML = header(`<div class="hero"><span class="eyebrow">Something went wrong</span><h1>Couldn’t load this view.</h1><p>${escapeHtml(error.message)}</p><a class="button" href="/" data-link>Back to projects</a></div>`);
}

async function route() {
  clearInterval(state.blinkTimer);
  state.blinkTimer = null;
  root.innerHTML = `<main class="center"><div class="spinner" aria-label="Loading"></div></main>`;
  try {
    if (!state.me) state.me = await api("/api/v1/me");
    const path = location.pathname;
    if (path === "/github/callback") return completeGitHubLink();
    const project = path.match(/^\/projects\/([^/]+)$/);
    const run = path.match(/^\/runs\/([^/]+)$/);
    const comparison = path.match(/^\/comparisons\/([^/]+)$/);
    if (project) return renderProject(project[1]);
    if (run) return renderRun(run[1]);
    if (comparison) return renderComparison(comparison[1]);
    return renderHome();
  } catch (error) {
    if (error.status === 401) return renderLogin();
    errorPage(error);
  }
}

async function completeGitHubLink() {
  const parameters = new URLSearchParams(location.search);
  const code = parameters.get("code");
  const signedState = parameters.get("state");
  if (!code || !signedState) throw new Error("GitHub returned an incomplete authorization callback.");
  let projectId;
  try {
    const encoded = signedState.split(".")[0].replaceAll("-", "+").replaceAll("_", "/");
    projectId = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="))).projectId;
  } catch { throw new Error("GitHub returned an invalid authorization state."); }
  if (typeof projectId !== "string") throw new Error("GitHub authorization did not identify a project.");
  await api(`/api/v1/projects/${encodeURIComponent(projectId)}/github-installation`, {
    method: "POST", body: JSON.stringify({ code, state: signedState }),
  });
  navigate(`/projects/${encodeURIComponent(projectId)}`, true);
}

function renderLogin() {
  state.me = null;
  root.innerHTML = `<main class="center"><section class="hero"><span class="eyebrow">Visual review for CI</span><h1>See the change.<br>Ship with confidence.</h1><p>Private screenshot comparisons, precise baselines, and GitHub checks—without making product images public.</p><a class="button primary" href="/auth/login">Sign in with WorkOS</a></section></main>`;
}

async function renderHome() {
  const { projects } = await api("/api/v1/projects");
  const cards = projects.map((project) => `<a class="card" href="/projects/${encodeURIComponent(project.id)}" data-link><h2>${escapeHtml(project.name)}</h2><div class="repo">${escapeHtml(project.repositoryOwner)}/${escapeHtml(project.repositoryName)}</div><p class="muted">Default branch · ${escapeHtml(project.defaultBranch)}</p></a>`).join("");
  root.innerHTML = header(`<section class="hero"><span class="eyebrow">Workspace</span><h1>Your visual changes,<br>in one sharp view.</h1><p>Open a project to inspect recent runs, compare pixels, and resolve snapshot changes.</p></section><div class="section-head"><h2>Projects</h2><span class="muted">${projects.length} total</span></div>${cards ? `<div class="grid">${cards}</div>` : `<div class="empty">No projects yet. Create one through the API to begin uploading snapshots.</div>`}`);
}

async function renderProject(projectId) {
  const { project, runs, nextCursor } = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/run-history`);
  const rows = runs.map(runRow).join("");
  root.innerHTML = header(`<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><span>${escapeHtml(project.name)}</span></nav><span class="eyebrow">${escapeHtml(project.repositoryOwner)}/${escapeHtml(project.repositoryName)}</span><h1>${escapeHtml(project.name)}</h1><div class="section-head"><h2>Recent runs</h2><span class="muted">Newest first</span></div>${rows ? `<div class="run-list" id="run-list">${rows}</div>${nextCursor ? `<button class="button" data-runs-more="${escapeHtml(nextCursor)}">Load older runs</button>` : ""}` : `<div class="empty">No screenshot runs have arrived for this project.</div>`}`);
  root.querySelector("[data-runs-more]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const page = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/run-history?before=${encodeURIComponent(button.dataset.runsMore)}`);
      root.querySelector("#run-list").insertAdjacentHTML("beforeend", page.runs.map(runRow).join(""));
      if (page.nextCursor) { button.dataset.runsMore = page.nextCursor; button.disabled = false; } else button.remove();
    } catch (error) { button.textContent = error.message; }
  });
}

function runRow(run) {
  const target = run.comparisonId ? `/comparisons/${run.comparisonId}` : `/runs/${run.id}`;
  const status = run.comparisonStatus || run.state;
  return `<a class="run-row" href="${target}" data-link><div class="run-meta"><strong>${escapeHtml(run.branch)}</strong><small><span class="sha">${escapeHtml(shortSha(run.commitSha))}</span> · ${formatDate(run.createdAt)}</small></div><div>${run.pullRequestNumber ? `PR #${run.pullRequestNumber}` : "Branch run"}</div><span class="pill ${escapeHtml(status)}">${escapeHtml(String(status).replaceAll("_", " "))}</span><div class="counts"><span><b>${run.changedCount ?? 0}</b> changed</span><span><b>${run.addedCount ?? 0}</b> added</span><span><b>${run.removedCount ?? 0}</b> removed</span></div></a>`;
}

async function renderRun(runId) {
  const { run, shards } = await api(`/api/v1/dashboard/runs/${encodeURIComponent(runId)}`);
  if (run.comparisonId) return navigate(`/comparisons/${run.comparisonId}`, true);
  root.innerHTML = header(`<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><a href="/projects/${encodeURIComponent(run.projectId)}" data-link>${escapeHtml(run.projectName)}</a><span>/</span><span>${escapeHtml(shortSha(run.commitSha))}</span></nav><span class="pill ${escapeHtml(run.state)}">${escapeHtml(run.state)}</span><h1>Run ${escapeHtml(shortSha(run.commitSha))}</h1><p class="muted">${escapeHtml(run.branch)} · attempt ${run.attemptNumber} · ${formatDate(run.createdAt)}</p><div class="stats"><div class="stat"><b>${run.screenshotCount}</b><span>Screenshots</span></div><div class="stat"><b>${formatBytes(run.logicalBytes)}</b><span>Logical size</span></div><div class="stat"><b>${shards.length}</b><span>Shards</span></div><div class="stat"><b>${run.pullRequestNumber ? `#${run.pullRequestNumber}` : "—"}</b><span>Pull request</span></div></div><div class="empty">The comparison is still being prepared. This page will link to the visual report when processing completes.</div>`);
}

async function renderComparison(comparisonId) {
  const payload = await api(`/api/v1/comparisons/${encodeURIComponent(comparisonId)}`);
  state.entries = payload.entries;
  state.selected = Math.min(state.selected, Math.max(0, state.entries.length - 1));
  const comparison = payload.comparison;
  const sidebar = state.entries.map(entryButton).join("");
  const decision = comparison.status === "action_required" ? `<textarea class="note" maxlength="2000" placeholder="Optional review note" aria-label="Review note"></textarea><div class="decision"><button class="button primary" data-decision="accepted">Accept changes</button><button class="button danger" data-decision="rejected">Reject</button></div>` : `<span class="pill ${escapeHtml(comparison.status)}">${escapeHtml(comparison.status.replaceAll("_", " "))}</span>`;
  const content = `<div class="review-layout"><aside class="review-sidebar"><nav class="crumbs"><a href="/projects/${encodeURIComponent(comparison.projectId)}" data-link>${escapeHtml(comparison.projectName)}</a><span>/</span><span>${escapeHtml(shortSha(comparison.commitSha))}</span></nav><div id="entries">${sidebar || `<div class="empty">No screenshots</div>`}</div>${payload.nextCursor ? `<button class="button" data-load-more="${escapeHtml(payload.nextCursor)}">Load more</button>` : ""}</aside><section class="review-main"><div class="review-head"><div><span class="eyebrow">${escapeHtml(comparison.branch)}</span><h2>Visual comparison</h2><div class="counts"><span><b>${comparison.changedCount}</b> changed</span><span><b>${comparison.addedCount}</b> added</span><span><b>${comparison.removedCount}</b> removed</span></div></div><div>${decision}</div></div><div id="viewer"></div></section></div>`;
  root.innerHTML = header(content, true);
  bindComparison(comparisonId, comparison);
  renderSelected();
}

function entryButton(entry, index) {
  return `<button class="entry ${index === state.selected ? "active" : ""}" data-entry="${index}" data-kind="${escapeHtml(entry.kind)}"><span class="entry-dot"></span><span class="entry-name">${escapeHtml(entry.name)}</span></button>`;
}

function bindComparison(comparisonId, comparison) {
  root.querySelectorAll("[data-entry]").forEach((button) => button.addEventListener("click", () => selectEntry(Number(button.dataset.entry))));
  root.querySelector("[data-load-more]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const next = await api(`/api/v1/comparisons/${encodeURIComponent(comparisonId)}?after=${encodeURIComponent(button.dataset.loadMore)}`);
      const offset = state.entries.length;
      state.entries.push(...next.entries);
      root.querySelector("#entries").insertAdjacentHTML("beforeend", next.entries.map((entry, index) => entryButton(entry, offset + index)).join(""));
      root.querySelectorAll("[data-entry]").forEach((entryButtonElement) => entryButtonElement.onclick = () => selectEntry(Number(entryButtonElement.dataset.entry)));
      if (next.nextCursor) { button.dataset.loadMore = next.nextCursor; button.disabled = false; } else button.remove();
    } catch (error) { button.textContent = error.message; }
  });
  root.querySelectorAll("[data-decision]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api(`/api/v1/comparisons/${encodeURIComponent(comparisonId)}/decision`, { method: "POST", body: JSON.stringify({ decision: button.dataset.decision, note: root.querySelector(".note")?.value || undefined }) });
      await renderComparison(comparisonId);
    } catch (error) { button.disabled = false; button.textContent = error.message; }
  }));
  document.title = `${shortSha(comparison.commitSha)} · SnappyDiff`;
}

function selectEntry(index) {
  state.selected = Math.max(0, Math.min(index, state.entries.length - 1));
  root.querySelectorAll("[data-entry]").forEach((button) => button.classList.toggle("active", Number(button.dataset.entry) === state.selected));
  root.querySelector(`[data-entry="${state.selected}"]`)?.scrollIntoView({ block: "nearest" });
  renderSelected();
}

function imageUrl(id) { return id ? `/api/v1/images/${encodeURIComponent(id)}/content` : null; }

function renderSelected() {
  clearInterval(state.blinkTimer);
  state.blinkTimer = null;
  const viewer = root.querySelector("#viewer");
  const entry = state.entries[state.selected];
  if (!viewer) return;
  if (!entry) { viewer.innerHTML = `<div class="empty">This comparison has no screenshot entries.</div>`; return; }
  const baseline = imageUrl(entry.baselineImageId);
  const current = imageUrl(entry.currentImageId);
  const modes = baseline && current ? ["overlay", "swipe", "blink", "highlight"] : ["image"];
  if (!modes.includes(state.mode)) state.mode = modes[0];
  viewer.innerHTML = `<div class="toolbar">${modes.map((mode) => `<button class="tool ${state.mode === mode ? "active" : ""}" data-mode="${mode}">${mode[0].toUpperCase()}${mode.slice(1)}</button>`).join("")}<span class="tool-spacer"></span><button class="tool" data-zoom="out">−</button><span class="tool">${Math.round(state.zoom * 100)}%</span><button class="tool" data-zoom="in">+</button></div><div class="viewport"><div class="image-stage"><div class="spinner"></div></div></div>`;
  viewer.querySelectorAll("[data-mode]").forEach((button) => button.onclick = () => { state.mode = button.dataset.mode; renderSelected(); });
  viewer.querySelectorAll("[data-zoom]").forEach((button) => button.onclick = () => { state.zoom = Math.max(.25, Math.min(4, state.zoom + (button.dataset.zoom === "in" ? .25 : -.25))); renderSelected(); });
  if (state.mode === "highlight") return renderHighlight(baseline, current);
  renderImages(baseline, current, entry);
}

function renderImages(baseline, current, entry) {
  const stage = root.querySelector(".image-stage");
  const primary = current || baseline;
  const image = new Image();
  image.src = primary;
  image.alt = entry.name;
  image.onload = async () => {
    const width = image.naturalWidth * state.zoom;
    const height = image.naturalHeight * state.zoom;
    const stack = document.createElement("div");
    stack.className = "image-stack";
    stack.style.width = `${width}px`; stack.style.height = `${height}px`;
    const primaryImage = image.cloneNode(); primaryImage.style.width = `${width}px`; primaryImage.style.height = `${height}px`;
    if (!baseline || !current || state.mode === "image") stack.append(primaryImage);
    else {
      const before = new Image(); before.src = baseline; before.alt = `Baseline: ${entry.name}`;
      await before.decode().catch(() => null);
      if (!before.naturalWidth) return showImageError("The baseline image could not be decoded.");
      if (before.naturalWidth !== image.naturalWidth || before.naturalHeight !== image.naturalHeight) return showImageError(`Dimension mismatch: baseline is ${before.naturalWidth}×${before.naturalHeight}, current is ${image.naturalWidth}×${image.naturalHeight}.`);
      before.style.width = `${width}px`; before.style.height = `${height}px`; stack.append(before);
      const layer = document.createElement("div"); layer.className = "image-layer"; layer.append(primaryImage); stack.append(layer);
      if (state.mode === "overlay") layer.style.opacity = ".5";
      if (state.mode === "swipe") {
        layer.style.clipPath = "inset(0 50% 0 0)";
        stack.onpointermove = (event) => { const rect = stack.getBoundingClientRect(); const position = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)); layer.style.clipPath = `inset(0 ${(1 - position) * 100}% 0 0)`; };
      }
      if (state.mode === "blink") state.blinkTimer = setInterval(() => { layer.style.visibility = layer.style.visibility === "hidden" ? "visible" : "hidden"; }, 650);
    }
    stage.replaceChildren(stack);
  };
  image.onerror = () => showImageError("The screenshot could not be loaded or decoded.");
}

function showImageError(message) {
  const stage = root.querySelector(".image-stage");
  if (stage) stage.innerHTML = `<div class="image-error">${escapeHtml(message)}</div>`;
}

function renderHighlight(baseline, current) {
  if (!baseline || !current) return showImageError("Highlighted diff requires both a baseline and current image.");
  const worker = state.worker ||= new Worker("/diff-worker.js", { type: "module" });
  const requestId = crypto.randomUUID();
  worker.onmessage = (event) => {
    if (event.data.requestId !== requestId) return;
    if (event.data.error) return showImageError(event.data.error);
    const canvas = document.createElement("canvas");
    canvas.width = event.data.bitmap.width; canvas.height = event.data.bitmap.height;
    canvas.style.width = `${canvas.width * state.zoom}px`; canvas.style.height = `${canvas.height * state.zoom}px`;
    const bitmapContext = canvas.getContext("bitmaprenderer");
    if (bitmapContext) bitmapContext.transferFromImageBitmap(event.data.bitmap);
    else { canvas.getContext("2d").drawImage(event.data.bitmap, 0, 0); event.data.bitmap.close(); }
    const stack = document.createElement("div"); stack.className = "image-stack"; stack.append(canvas);
    root.querySelector(".image-stage")?.replaceChildren(stack);
  };
  worker.postMessage({ requestId, baseline, current });
}

function navigate(path, replace = false) {
  history[replace ? "replaceState" : "pushState"]({}, "", path);
  route();
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-link]");
  if (link && link.origin === location.origin) { event.preventDefault(); navigate(link.pathname + link.search); }
  const logout = event.target.closest("[data-logout]");
  if (logout) api("/auth/logout", { method: "POST" }).finally(() => { state.me = null; location.assign("/"); });
});
document.addEventListener("keydown", (event) => {
  if (["INPUT", "TEXTAREA"].includes(event.target.tagName)) return;
  if (["ArrowDown", "j", "J"].includes(event.key)) { event.preventDefault(); selectEntry(state.selected + 1); }
  if (["ArrowUp", "k", "K"].includes(event.key)) { event.preventDefault(); selectEntry(state.selected - 1); }
});
addEventListener("popstate", route);
route();
