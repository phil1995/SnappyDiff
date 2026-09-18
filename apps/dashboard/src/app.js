import { parseGitHubRepository, projectSetupPath, projectSlug } from "./project-form.js";

const root = document.querySelector("#app");
const state = { me: null, entries: [], selected: 0, mode: "overlay", zoom: 1, swipe: .5, blinkTimer: null, worker: null, viewerGeneration: 0, routeGeneration: 0, comparisonId: null };

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
  const routeGeneration = ++state.routeGeneration;
  state.viewerGeneration++;
  clearInterval(state.blinkTimer);
  state.blinkTimer = null;
  root.innerHTML = `<main class="center"><div class="spinner" aria-label="Loading"></div></main>`;
  try {
    if (!state.me) state.me = await api("/api/v1/me");
    if (routeGeneration !== state.routeGeneration) return;
    const path = location.pathname;
    if (path === "/github/callback") return await completeGitHubLink(routeGeneration);
    if (path === "/projects/new") return renderNewProject(routeGeneration);
    const project = path.match(/^\/projects\/([^/]+)$/);
    const projectSettings = path.match(/^\/projects\/([^/]+)\/settings$/);
    const run = path.match(/^\/runs\/([^/]+)$/);
    const comparison = path.match(/^\/comparisons\/([^/]+)$/);
    if (projectSettings) return await renderSettings(projectSettings[1], routeGeneration);
    if (project) return await renderProject(project[1], routeGeneration);
    if (run) return await renderRun(run[1], routeGeneration);
    if (comparison) return await renderComparison(comparison[1], routeGeneration);
    return await renderHome(routeGeneration);
  } catch (error) {
    if (routeGeneration !== state.routeGeneration) return;
    if (error.status === 401) return renderLogin();
    errorPage(error);
  }
}

async function completeGitHubLink(routeGeneration) {
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
  if (routeGeneration !== state.routeGeneration) return;
  navigate(`/projects/${encodeURIComponent(projectId)}`, true);
}

function renderLogin() {
  state.me = null;
  root.innerHTML = `<main class="center"><section class="hero"><span class="eyebrow">Visual review for CI</span><h1>See the change.<br>Ship with confidence.</h1><p>Private screenshot comparisons, precise baselines, and GitHub checks—without making product images public.</p><a class="button primary" href="/auth/login">Sign in with WorkOS</a></section></main>`;
}

async function renderHome(routeGeneration) {
  const { projects } = await api("/api/v1/projects");
  if (routeGeneration !== state.routeGeneration) return;
  const admin = state.me.user.role === "admin";
  const cards = projects.map((project) => `<a class="card" href="/projects/${encodeURIComponent(project.id)}" data-link><h2>${escapeHtml(project.name)}</h2><div class="repo">${escapeHtml(project.repositoryOwner)}/${escapeHtml(project.repositoryName)}</div><p class="muted">Default branch · ${escapeHtml(project.defaultBranch)}</p></a>`).join("");
  const empty = admin
    ? `<section class="empty onboarding-empty"><span class="eyebrow">First project</span><h2>Connect a GitHub repository</h2><p>Tell SnappyDiff where your snapshots live. You can connect the GitHub App and CI after the project is created.</p><a class="button primary" href="/projects/new" data-link>Create your first project</a></section>`
    : `<div class="empty">No projects are available yet. Ask a workspace administrator to create one.</div>`;
  root.innerHTML = header(`<section class="hero"><span class="eyebrow">Workspace</span><h1>Your visual changes,<br>in one sharp view.</h1><p>Open a project to inspect recent runs, compare pixels, and resolve snapshot changes.</p></section><div class="section-head"><h2>Projects</h2><div class="section-actions"><span class="muted">${projects.length} total</span>${admin && projects.length ? `<a class="button primary" href="/projects/new" data-link>New project</a>` : ""}</div></div>${cards ? `<div class="grid">${cards}</div>` : empty}`);
}

function renderNewProject(routeGeneration) {
  if (state.me.user.role !== "admin") throw new Error("Only workspace administrators can create projects.");
  root.innerHTML = header(`<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><span>New project</span></nav><section class="onboarding"><div class="onboarding-copy"><span class="eyebrow">New project</span><h1>Connect your snapshots.</h1><p>A project maps one GitHub repository to its snapshot history, baselines, and pull request checks.</p><ol class="setup-steps"><li><span>1</span><div><strong>Create the project</strong><small>Choose the repository and default branch.</small></div></li><li><span>2</span><div><strong>Connect GitHub</strong><small>Install the SnappyDiff App for this repository.</small></div></li><li><span>3</span><div><strong>Upload from CI</strong><small>Run your existing snapshot tests and upload their output.</small></div></li></ol></div><form class="project-form" data-project-create><h2>Project details</h2><label>Project name<input name="name" maxlength="100" required autofocus placeholder="My iOS App"><small>Shown to everyone in this workspace.</small></label><label>GitHub repository<input name="repository" required autocomplete="off" spellcheck="false" placeholder="owner/repository"><small>Paste owner/repository, a GitHub URL, or an SSH clone URL.</small></label><label>Default branch<input name="defaultBranch" maxlength="255" required value="main" spellcheck="false"><small>Usually main or master.</small></label><div class="form-error" data-project-error role="alert" hidden></div><div class="form-actions"><a class="button" href="/" data-link>Cancel</a><button class="button primary" type="submit">Create project</button></div></form></section>`);
  const form = root.querySelector("[data-project-create]");
  const nameInput = form.elements.name;
  const repositoryInput = form.elements.repository;
  repositoryInput.addEventListener("change", () => {
    if (nameInput.value.trim()) return;
    try { nameInput.value = parseGitHubRepository(repositoryInput.value).repositoryName; }
    catch { /* Submission shows the actionable validation message. */ }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    const error = form.querySelector("[data-project-error]");
    error.hidden = true;
    button.disabled = true;
    button.textContent = "Creating…";
    try {
      const values = new FormData(form);
      const name = String(values.get("name") ?? "").trim();
      const repository = parseGitHubRepository(values.get("repository"));
      const result = await api("/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
          slug: projectSlug(name, repository.repositoryName),
          ...repository,
          defaultBranch: String(values.get("defaultBranch") ?? "").trim(),
        }),
      });
      const destination = projectSetupPath(result.project.id, routeGeneration, state.routeGeneration);
      if (destination) navigate(destination, true);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      button.disabled = false;
      button.textContent = "Create project";
    }
  });
}

async function renderProject(projectId, routeGeneration) {
  const { project, runs, nextCursor } = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/run-history`);
  if (routeGeneration !== state.routeGeneration) return;
  const rows = runs.map(runRow).join("");
  const settings = state.me.user.role === "admin" ? `<a class="button" href="/projects/${encodeURIComponent(projectId)}/settings" data-link>Project settings</a>` : "";
  root.innerHTML = header(`<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><span>${escapeHtml(project.name)}</span></nav><span class="eyebrow">${escapeHtml(project.repositoryOwner)}/${escapeHtml(project.repositoryName)}</span><div class="title-row"><h1>${escapeHtml(project.name)}</h1>${settings}</div><div class="section-head"><h2>Recent runs</h2><span class="muted">Newest first</span></div>${rows ? `<div class="run-list" id="run-list">${rows}</div>${nextCursor ? `<button class="button" data-runs-more="${escapeHtml(nextCursor)}">Load older runs</button>` : ""}` : `<div class="empty">No screenshot runs have arrived for this project.</div>`}`);
  root.querySelector("[data-runs-more]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const page = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/run-history?before=${encodeURIComponent(button.dataset.runsMore)}`);
      if (routeGeneration !== state.routeGeneration) return;
      root.querySelector("#run-list").insertAdjacentHTML("beforeend", page.runs.map(runRow).join(""));
      if (page.nextCursor) { button.dataset.runsMore = page.nextCursor; button.disabled = false; } else button.remove();
    } catch (error) { button.textContent = error.message; }
  });
}

async function renderSettings(projectId, routeGeneration) {
  const admin = state.me.user.role === "admin";
  const [operations, tokenPayload, memberPayload] = await Promise.all([
    api(`/api/v1/projects/${encodeURIComponent(projectId)}/settings`),
    admin ? api(`/api/v1/projects/${encodeURIComponent(projectId)}/tokens`) : Promise.resolve({ tokens: [] }),
    admin ? api("/api/v1/members") : Promise.resolve({ members: [] }),
  ]);
  if (routeGeneration !== state.routeGeneration) return;
  const project = operations.project;
  const warningHtml = operations.retentionWarnings.map((warning) => `<div class="warning">PR #${warning.number} retention is preserved because GitHub state could not be reconciled. ${escapeHtml(warning.reconciliationError || "")}</div>`).join("");
  const history = operations.baselineHistory.map((item) => `<div class="history-row"><span class="pill">${escapeHtml(item.action)}</span><span class="sha">${escapeHtml(shortSha(item.commitSha))}</span><span>${escapeHtml(item.actorEmail || "automation")}</span><time>${formatDate(item.createdAt)}</time></div>`).join("");
  const tokens = tokenPayload.tokens.map((token) => `<div class="management-row"><div><strong>${escapeHtml(token.name)}</strong><small>${escapeHtml(token.tokenPrefix)}… · expires ${formatDate(token.expiresAt)}${token.revokedAt ? " · revoked" : ""}</small></div>${token.revokedAt ? "" : `<div><button class="button" data-rotate-token="${escapeHtml(token.id)}">Rotate</button> <button class="button danger" data-revoke-token="${escapeHtml(token.id)}">Revoke</button></div>`}</div>`).join("");
  const members = memberPayload.members.map((member) => `<div class="management-row"><div><strong>${escapeHtml(member.email)}</strong><small>${escapeHtml(member.displayName)}</small></div><div><select data-member-role="${escapeHtml(member.id)}"><option ${member.role === "viewer" ? "selected" : ""}>viewer</option><option ${member.role === "reviewer" ? "selected" : ""}>reviewer</option><option ${member.role === "admin" ? "selected" : ""}>admin</option></select> <select data-member-status="${escapeHtml(member.id)}"><option ${member.status === "active" ? "selected" : ""}>active</option><option ${member.status === "suspended" ? "selected" : ""}>suspended</option></select></div></div>`).join("");
  root.innerHTML = header(`<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><a href="/projects/${encodeURIComponent(projectId)}" data-link>${escapeHtml(project.name)}</a><span>/</span><span>Settings</span></nav><span class="eyebrow">Operations</span><h1>${escapeHtml(project.name)}</h1>${warningHtml}<div class="settings-grid"><section class="settings-card"><h2>Project</h2><form data-project-settings><label>Name<input name="name" value="${escapeHtml(project.name)}" required maxlength="100"></label><label>Default branch<input name="defaultBranch" value="${escapeHtml(project.defaultBranch)}" required maxlength="255"></label><div class="field-pair"><label>Artifact days<input name="retentionDays" type="number" min="1" max="3650" value="${project.retentionDays}"></label><label>Promoted days<input name="promotedRetentionDays" type="number" min="365" max="3650" value="${project.promotedRetentionDays}"></label></div><button class="button primary" ${admin ? "" : "disabled"}>Save settings</button></form></section><section class="settings-card"><h2>Baseline control</h2><p class="muted">Active <span class="sha">${escapeHtml(shortSha(project.activeBaselineSha) || "none")}</span> · mode ${escapeHtml(project.promotionMode)}${project.rollbackSha ? ` · rollback ${escapeHtml(shortSha(project.rollbackSha))}` : ""}</p><div class="decision"><button class="button" data-baseline-action="pause" ${admin ? "" : "disabled"}>Pause</button><button class="button primary" data-baseline-action="resume" ${admin ? "" : "disabled"}>Resume</button><button class="button" data-baseline-action="clear_rollback" ${admin ? "" : "disabled"}>Clear rollback</button></div><label>Run ID for rollback or history reset<input data-baseline-run placeholder="run_…" ${admin ? "" : "disabled"}></label><div class="decision"><button class="button" data-baseline-action="rollback" ${admin ? "" : "disabled"}>Rollback view</button><button class="button danger" data-baseline-action="history_reset" ${admin ? "" : "disabled"}>Confirm history reset</button></div></section><section class="settings-card wide"><h2>Baseline history</h2>${history || `<div class="empty">No baseline history yet.</div>`}</section>${admin ? `<section class="settings-card"><h2>Project tokens</h2><form data-token-create><label>Name<input name="name" required maxlength="100" placeholder="CI upload"></label><label>Expiry days<input name="expiresInDays" type="number" min="1" max="365" value="90"></label><button class="button primary">Create scoped token</button></form><div data-token-secret></div><div>${tokens || `<p class="muted">No tokens.</p>`}</div></section><section class="settings-card"><h2>GitHub installation</h2><form data-github-link><label>Installation ID<input name="installationId" type="number" min="1" required></label><button class="button">Authorize and link</button></form><p class="muted">GitHub authorization verifies that you administer this repository before linking.</p></section><section class="settings-card wide"><h2>Members</h2>${members}</section>` : ""}</div>`);
  bindSettings(projectId, routeGeneration);
}

function bindSettings(projectId, routeGeneration) {
  root.querySelector("[data-project-settings]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await settingsAction(event.submitter, () => api(`/api/v1/projects/${encodeURIComponent(projectId)}/settings`, { method: "PATCH", body: JSON.stringify({ name: form.get("name"), defaultBranch: form.get("defaultBranch"), retentionDays: Number(form.get("retentionDays")), promotedRetentionDays: Number(form.get("promotedRetentionDays")) }) }));
  });
  root.querySelectorAll("[data-baseline-action]").forEach((button) => button.onclick = async () => {
    await settingsAction(button, () => api(`/api/v1/projects/${encodeURIComponent(projectId)}/baseline-control`, { method: "POST", body: JSON.stringify({ action: button.dataset.baselineAction, runId: root.querySelector("[data-baseline-run]").value || undefined }) }));
    if (routeGeneration === state.routeGeneration) await renderSettings(projectId, routeGeneration);
  });
  root.querySelector("[data-token-create]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const result = await settingsAction(event.submitter, () => api(`/api/v1/projects/${encodeURIComponent(projectId)}/tokens`, { method: "POST", body: JSON.stringify({ name: form.get("name"), scopes: ["runs:create"], expiresInDays: Number(form.get("expiresInDays")) }) }));
    if (result && routeGeneration === state.routeGeneration) root.querySelector("[data-token-secret]").innerHTML = `<div class="secret"><strong>Copy now—shown once</strong><code>${escapeHtml(result.token)}</code></div>`;
  });
  root.querySelectorAll("[data-revoke-token]").forEach((button) => button.onclick = async () => { await settingsAction(button, () => api(`/api/v1/tokens/${encodeURIComponent(button.dataset.revokeToken)}`, { method: "DELETE" })); if (routeGeneration === state.routeGeneration) await renderSettings(projectId, routeGeneration); });
  root.querySelectorAll("[data-rotate-token]").forEach((button) => button.onclick = async () => { const result = await settingsAction(button, () => api(`/api/v1/tokens/${encodeURIComponent(button.dataset.rotateToken)}/rotate`, { method: "POST", body: "{}" })); if (result && routeGeneration === state.routeGeneration) { await renderSettings(projectId, routeGeneration); root.querySelector("[data-token-secret]").innerHTML = `<div class="secret"><strong>Replacement token—copy now</strong><code>${escapeHtml(result.token)}</code></div>`; } });
  root.querySelectorAll("[data-member-role], [data-member-status]").forEach((select) => select.onchange = async () => { const userId = select.dataset.memberRole || select.dataset.memberStatus; const role = root.querySelector(`[data-member-role="${CSS.escape(userId)}"]`).value; const status = root.querySelector(`[data-member-status="${CSS.escape(userId)}"]`).value; await settingsAction(select, () => api(`/api/v1/members/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify({ role, status }) })); });
  root.querySelector("[data-github-link]")?.addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const result = await settingsAction(event.submitter, () => api(`/api/v1/projects/${encodeURIComponent(projectId)}/github-installation/authorize`, { method: "POST", body: JSON.stringify({ installationId: Number(form.get("installationId")) }) })); if (result) location.assign(result.authorizationUrl); });
}

async function settingsAction(control, operation) {
  const canLabel = control?.tagName === "BUTTON";
  const original = canLabel ? control.textContent : null;
  if (control) control.disabled = true;
  try { return await operation(); }
  catch (error) { if (canLabel) control.textContent = error.message; else if (control) control.title = error.message; return null; }
  finally { if (control) { control.disabled = false; if (canLabel) setTimeout(() => { if (control.isConnected) control.textContent = original; }, 2500); } }
}

function runRow(run) {
  const target = run.comparisonId ? `/comparisons/${run.comparisonId}` : `/runs/${run.id}`;
  const status = run.comparisonStatus || run.state;
  return `<a class="run-row" href="${target}" data-link><div class="run-meta"><strong>${escapeHtml(run.branch)}</strong><small><span class="sha">${escapeHtml(shortSha(run.commitSha))}</span> · ${formatDate(run.createdAt)}</small></div><div>${run.pullRequestNumber ? `PR #${run.pullRequestNumber}` : "Branch run"}</div><span class="pill ${escapeHtml(status)}">${escapeHtml(String(status).replaceAll("_", " "))}</span><div class="counts"><span><b>${run.changedCount ?? 0}</b> changed</span><span><b>${run.addedCount ?? 0}</b> added</span><span><b>${run.removedCount ?? 0}</b> removed</span></div></a>`;
}

async function renderRun(runId, routeGeneration) {
  const { run, shards } = await api(`/api/v1/dashboard/runs/${encodeURIComponent(runId)}`);
  if (routeGeneration !== state.routeGeneration) return;
  if (run.comparisonId) return navigate(`/comparisons/${run.comparisonId}`, true);
  root.innerHTML = header(`<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><a href="/projects/${encodeURIComponent(run.projectId)}" data-link>${escapeHtml(run.projectName)}</a><span>/</span><span>${escapeHtml(shortSha(run.commitSha))}</span></nav><span class="pill ${escapeHtml(run.state)}">${escapeHtml(run.state)}</span><h1>Run ${escapeHtml(shortSha(run.commitSha))}</h1><p class="muted">${escapeHtml(run.branch)} · attempt ${run.attemptNumber} · ${formatDate(run.createdAt)}</p><div class="stats"><div class="stat"><b>${run.screenshotCount}</b><span>Screenshots</span></div><div class="stat"><b>${formatBytes(run.logicalBytes)}</b><span>Logical size</span></div><div class="stat"><b>${shards.length}</b><span>Shards</span></div><div class="stat"><b>${run.pullRequestNumber ? `#${run.pullRequestNumber}` : "—"}</b><span>Pull request</span></div></div><div class="empty">The comparison is still being prepared. This page will link to the visual report when processing completes.</div>`);
}

async function renderComparison(comparisonId, routeGeneration = state.routeGeneration) {
  const payload = await api(`/api/v1/comparisons/${encodeURIComponent(comparisonId)}`);
  if (routeGeneration !== state.routeGeneration) return;
  if (state.comparisonId !== comparisonId) state.selected = 0;
  state.comparisonId = comparisonId;
  state.entries = payload.entries;
  state.selected = Math.min(state.selected, Math.max(0, state.entries.length - 1));
  const comparison = payload.comparison;
  const sidebar = state.entries.map(entryButton).join("");
  const decision = comparison.status === "action_required" ? `<textarea class="note" maxlength="2000" placeholder="Optional review note" aria-label="Review note"></textarea><div class="decision"><button class="button primary" data-decision="accepted">Accept changes</button><button class="button danger" data-decision="rejected">Reject</button></div>` : `<span class="pill ${escapeHtml(comparison.status)}">${escapeHtml(comparison.status.replaceAll("_", " "))}</span>`;
  const content = `<div class="review-layout"><aside class="review-sidebar"><nav class="crumbs"><a href="/projects/${encodeURIComponent(comparison.projectId)}" data-link>${escapeHtml(comparison.projectName)}</a><span>/</span><span>${escapeHtml(shortSha(comparison.commitSha))}</span></nav><div id="entries">${sidebar || `<div class="empty">No screenshots</div>`}</div>${payload.nextCursor ? `<button class="button" data-load-more="${escapeHtml(payload.nextCursor)}">Load more</button>` : ""}</aside><section class="review-main"><div class="review-head"><div><span class="eyebrow">${escapeHtml(comparison.branch)}</span><h2>Visual comparison</h2><div class="counts"><span><b>${comparison.changedCount}</b> changed</span><span><b>${comparison.addedCount}</b> added</span><span><b>${comparison.removedCount}</b> removed</span></div></div><div>${decision}</div></div><div id="viewer"></div></section></div>`;
  root.innerHTML = header(content, true);
  bindComparison(comparisonId, comparison, routeGeneration);
  renderSelected();
}

function entryButton(entry, index) {
  return `<button class="entry ${index === state.selected ? "active" : ""}" data-entry="${index}" data-kind="${escapeHtml(entry.kind)}"><span class="entry-dot"></span><span class="entry-name">${escapeHtml(entry.name)}</span></button>`;
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
  const generation = ++state.viewerGeneration;
  clearInterval(state.blinkTimer);
  state.blinkTimer = null;
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
  const worker = state.worker ||= new Worker("/diff-worker.js", { type: "module" });
  const requestId = crypto.randomUUID();
  worker.onmessage = (event) => {
    if (event.data.requestId !== requestId || generation !== state.viewerGeneration) return;
    if (event.data.error) return showImageError(event.data.error, generation);
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
