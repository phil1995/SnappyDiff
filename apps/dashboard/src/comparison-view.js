import { comparisonNavigation } from "./comparison-navigation.js";
import { api, escapeHtml, formatBytes, formatDate, header, root, shortSha, state } from "./ui.js";

export async function renderRun(runId, routeGeneration, navigate) {
  const { run, shards } = await api(`/api/v1/dashboard/runs/${encodeURIComponent(runId)}`);
  if (routeGeneration !== state.routeGeneration) return;
  if (run.comparisonId) return navigate(`/comparisons/${run.comparisonId}`, true);
  root.innerHTML = header(`<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><a href="/projects/${encodeURIComponent(run.projectId)}" data-link>${escapeHtml(run.projectName)}</a><span>/</span><span>${escapeHtml(shortSha(run.commitSha))}</span></nav><span class="pill ${escapeHtml(run.state)}">${escapeHtml(run.state)}</span><h1>Run ${escapeHtml(shortSha(run.commitSha))}</h1><p class="muted">${escapeHtml(run.branch)} · attempt ${run.attemptNumber} · ${formatDate(run.createdAt)}</p><div class="stats"><div class="stat"><b>${run.screenshotCount}</b><span>Screenshots</span></div><div class="stat"><b>${formatBytes(run.logicalBytes)}</b><span>Logical size</span></div><div class="stat"><b>${shards.length}</b><span>Shards</span></div><div class="stat"><b>${run.pullRequestNumber ? `#${run.pullRequestNumber}` : "—"}</b><span>Pull request</span></div></div><div class="empty">The comparison is still being prepared. This page will link to the visual report when processing completes.</div>`);
}

export async function renderComparison(comparisonId, routeGeneration = state.routeGeneration) {
  const payload = await api(`/api/v1/comparisons/${encodeURIComponent(comparisonId)}`);
  if (routeGeneration !== state.routeGeneration) return;
  if (state.comparisonId !== comparisonId) state.selected = 0;
  state.comparisonId = comparisonId;
  state.entries = payload.entries;
  state.selected = Math.min(state.selected, Math.max(0, state.entries.length - 1));
  const comparison = payload.comparison;
  const sidebar = state.entries.map(entryButton).join("");
  const status = `<span class="pill ${escapeHtml(comparison.status)}">${escapeHtml(comparison.status.replaceAll("_", " "))}</span>`;
  const navigation = `<div class="entry-navigation"><button class="button" data-entry-prev aria-label="Previous screenshot">← Previous</button><span><b data-entry-position>${state.entries.length ? state.selected + 1 : 0}</b> of <b data-entry-total>${state.entries.length}</b></span><button class="button" data-entry-next aria-label="Next screenshot">Next →</button></div>`;
  const decision = comparison.status === "action_required" ? `<div class="review-note"><label for="review-note">Notes <span>Optional</span></label><textarea id="review-note" class="note" maxlength="2000" placeholder="Add context for this review…"></textarea></div><div class="review-footer">${navigation}<div class="decision"><button class="button danger" data-decision="rejected">Reject</button><button class="button primary" data-decision="accepted">Accept changes</button></div></div>` : `<div class="review-footer">${navigation}</div>`;
  const reviewActions = `<section class="review-actions">${decision}</section>`;
  const content = `<div class="review-layout"><section class="review-main"><nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><a href="/projects/${encodeURIComponent(comparison.projectId)}" data-link>${escapeHtml(comparison.projectName)}</a><span>/</span><span>${escapeHtml(shortSha(comparison.commitSha))}</span></nav><div class="review-head"><div><span class="eyebrow">${escapeHtml(comparison.branch)}</span><div class="review-title"><h1>Visual comparison</h1>${status}</div><div class="comparison-meta"><span class="sha">${escapeHtml(shortSha(comparison.commitSha))}</span><div class="counts"><span><b>${comparison.changedCount}</b> changed</span><span><b>${comparison.addedCount}</b> added</span><span><b>${comparison.removedCount}</b> removed</span></div></div></div></div><div id="viewer"></div>${reviewActions}</section><aside class="review-sidebar"><div class="changes-head"><div><span class="eyebrow">Review queue</span><h2>Changes</h2></div><span class="change-total">${state.entries.length}</span></div><div id="entries">${sidebar || `<div class="empty">No screenshots</div>`}</div>${payload.nextCursor ? `<button class="button load-more" data-load-more="${escapeHtml(payload.nextCursor)}">Load more</button>` : ""}</aside></div>`;
  root.innerHTML = header(content, true);
  bindComparison(comparisonId, comparison, routeGeneration);
  selectEntry(state.selected);
}

function entryButton(entry, index) {
  return `<button class="entry ${index === state.selected ? "active" : ""}" data-entry="${index}" data-kind="${escapeHtml(entry.kind)}"><span class="entry-dot"></span><span class="entry-copy"><span class="entry-name">${escapeHtml(entry.name)}</span><span class="entry-kind">${escapeHtml(entry.kind)}</span></span></button>`;
}

function bindComparison(comparisonId, comparison, routeGeneration) {
  root.querySelector("#entries")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-entry]");
    if (button) selectEntry(Number(button.dataset.entry));
  });
  root.querySelector("[data-load-more]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const next = await api(`/api/v1/comparisons/${encodeURIComponent(comparisonId)}?after=${encodeURIComponent(button.dataset.loadMore)}`);
      if (routeGeneration !== state.routeGeneration || state.comparisonId !== comparisonId) return;
      const offset = state.entries.length;
      state.entries.push(...next.entries);
      root.querySelector("#entries").insertAdjacentHTML("beforeend", next.entries.map((entry, index) => entryButton(entry, offset + index)).join(""));
      root.querySelector(".change-total").textContent = String(state.entries.length);
      syncEntryNavigation();
      if (next.nextCursor) { button.dataset.loadMore = next.nextCursor; button.disabled = false; } else button.remove();
    } catch (error) { button.textContent = error.message; }
  });
  root.querySelectorAll("[data-decision]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api(`/api/v1/comparisons/${encodeURIComponent(comparisonId)}/decision`, { method: "POST", body: JSON.stringify({ decision: button.dataset.decision, note: root.querySelector(".note")?.value || undefined }) });
      if (routeGeneration !== state.routeGeneration || state.comparisonId !== comparisonId) return;
      await renderComparison(comparisonId, routeGeneration);
    } catch (error) { button.disabled = false; button.textContent = error.message; }
  }));
  root.querySelector("[data-entry-prev]")?.addEventListener("click", () => selectEntry(state.selected - 1));
  root.querySelector("[data-entry-next]")?.addEventListener("click", () => selectEntry(state.selected + 1));
  document.title = `${shortSha(comparison.commitSha)} · SnappyDiff`;
}

export function selectEntry(index) {
  state.selected = index;
  syncEntryNavigation();
  root.querySelectorAll("[data-entry]").forEach((button) => button.classList.toggle("active", Number(button.dataset.entry) === state.selected));
  root.querySelector(`[data-entry="${state.selected}"]`)?.scrollIntoView({ block: "nearest" });
  renderSelected();
}

function syncEntryNavigation() {
  const navigation = comparisonNavigation(state.selected, state.entries.length);
  state.selected = navigation.selected;
  const position = root.querySelector("[data-entry-position]");
  const total = root.querySelector("[data-entry-total]");
  if (position) position.textContent = String(navigation.position);
  if (total) total.textContent = String(navigation.total);
  const previous = root.querySelector("[data-entry-prev]");
  const next = root.querySelector("[data-entry-next]");
  if (previous) previous.disabled = navigation.previousDisabled;
  if (next) next.disabled = navigation.nextDisabled;
}

function imageUrl(id) { return id ? `/api/v1/images/${encodeURIComponent(id)}/content` : null; }

export function disposeViewer() {
  state.viewerGeneration++;
  clearInterval(state.blinkTimer);
  state.blinkTimer = null;
  state.worker?.terminate();
  state.worker = null;
}

function renderSelected() {
  disposeViewer();
  const generation = state.viewerGeneration;
  const viewer = root.querySelector("#viewer");
  const entry = state.entries[state.selected];
  if (!viewer) return;
  if (!entry) { viewer.innerHTML = `<div class="empty">This comparison has no screenshot entries.</div>`; return; }
  const baseline = imageUrl(entry.baselineImageId);
  const current = imageUrl(entry.currentImageId);
  if (!baseline && !current) { viewer.innerHTML = `<div class="empty">Image artifacts for this historical comparison have expired under the project retention policy.</div>`; return; }
  const modes = baseline && current ? ["overlay", "swipe", "blink", "highlight"] : ["image"];
  if (!modes.includes(state.mode)) state.mode = modes[0];
  const swipeControl = state.mode === "swipe" ? `<label class="swipe-control">Split <input type="range" min="0" max="100" value="${Math.round(state.swipe * 100)}" data-swipe aria-label="Swipe split position"><output>${Math.round(state.swipe * 100)}%</output></label>` : "";
  viewer.innerHTML = `<div class="toolbar">${modes.map((mode) => `<button class="tool ${state.mode === mode ? "active" : ""}" data-mode="${mode}">${mode[0].toUpperCase()}${mode.slice(1)}</button>`).join("")}${swipeControl}<span class="tool-spacer"></span><button class="tool" data-zoom="out" aria-label="Zoom out">−</button><span class="tool">${Math.round(state.zoom * 100)}%</span><button class="tool" data-zoom="in" aria-label="Zoom in">+</button></div><div class="viewport"><div class="image-stage"><div class="spinner"></div></div></div>`;
  viewer.querySelectorAll("[data-mode]").forEach((button) => button.onclick = () => { state.mode = button.dataset.mode; renderSelected(); });
  viewer.querySelectorAll("[data-zoom]").forEach((button) => button.onclick = () => { state.zoom = Math.max(.25, Math.min(4, state.zoom + (button.dataset.zoom === "in" ? .25 : -.25))); renderSelected(); });
  viewer.querySelector("[data-swipe]")?.addEventListener("input", (event) => {
    state.swipe = Number(event.target.value) / 100;
    event.target.nextElementSibling.value = `${event.target.value}%`;
    const layer = root.querySelector(".image-layer");
    if (layer) layer.style.clipPath = `inset(0 ${(1 - state.swipe) * 100}% 0 0)`;
  });
  if (state.mode === "highlight") return renderHighlight(baseline, current, generation);
  renderImages(baseline, current, entry, generation);
}

function renderImages(baseline, current, entry, generation) {
  const stage = root.querySelector(".image-stage");
  const primary = current || baseline;
  const image = new Image();
  image.src = primary;
  image.alt = entry.name;
  image.onload = async () => {
    if (generation !== state.viewerGeneration || !stage.isConnected) return;
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
      if (generation !== state.viewerGeneration || !stage.isConnected) return;
      if (!before.naturalWidth) return showImageError("The baseline image could not be decoded.", generation);
      if (before.naturalWidth !== image.naturalWidth || before.naturalHeight !== image.naturalHeight) return showImageError(`Dimension mismatch: baseline is ${before.naturalWidth}×${before.naturalHeight}, current is ${image.naturalWidth}×${image.naturalHeight}.`, generation);
      before.style.width = `${width}px`; before.style.height = `${height}px`; stack.append(before);
      const layer = document.createElement("div"); layer.className = "image-layer"; layer.append(primaryImage); stack.append(layer);
      if (state.mode === "overlay") layer.style.opacity = ".5";
      if (state.mode === "swipe") {
        layer.style.clipPath = `inset(0 ${(1 - state.swipe) * 100}% 0 0)`;
        stack.onpointermove = (event) => { const rect = stack.getBoundingClientRect(); state.swipe = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)); layer.style.clipPath = `inset(0 ${(1 - state.swipe) * 100}% 0 0)`; const input = root.querySelector("[data-swipe]"); if (input) { input.value = String(Math.round(state.swipe * 100)); input.nextElementSibling.value = `${input.value}%`; } };
      }
      if (state.mode === "blink" && generation === state.viewerGeneration) state.blinkTimer = setInterval(() => { if (generation !== state.viewerGeneration) return clearInterval(state.blinkTimer); layer.style.visibility = layer.style.visibility === "hidden" ? "visible" : "hidden"; }, 650);
    }
    stage.replaceChildren(stack);
  };
  image.onerror = () => showImageError("The screenshot could not be loaded or decoded.", generation);
}

function showImageError(message, generation = state.viewerGeneration) {
  if (generation !== state.viewerGeneration) return;
  const stage = root.querySelector(".image-stage");
  if (stage) stage.innerHTML = `<div class="image-error">${escapeHtml(message)}</div>`;
}

function renderHighlight(baseline, current, generation) {
  if (!baseline || !current) return showImageError("Highlighted diff requires both a baseline and current image.", generation);
  const worker = state.worker = new Worker("/diff-worker.js", { type: "module" });
  const requestId = crypto.randomUUID();
  worker.onmessage = (event) => {
    if (event.data.requestId !== requestId || generation !== state.viewerGeneration) {
      event.data.bitmap?.close();
      return;
    }
    if (event.data.error) return showImageError(event.data.error, generation);
    const stage = root.querySelector(".image-stage");
    if (!stage) { event.data.bitmap.close(); return; }
    const bitmap = event.data.bitmap;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.style.width = `${canvas.width * state.zoom}px`; canvas.style.height = `${canvas.height * state.zoom}px`;
      const bitmapContext = canvas.getContext("bitmaprenderer");
      if (bitmapContext) bitmapContext.transferFromImageBitmap(bitmap);
      else canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const stack = document.createElement("div"); stack.className = "image-stack"; stack.append(canvas);
      stage.replaceChildren(stack);
    } finally {
      bitmap.close();
    }
  };
  worker.postMessage({ requestId, baseline, current });
}

