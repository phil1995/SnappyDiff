import { configureUploadStep, createKeyStep, findNewProject, oidcUploadWorkflow, waitForUploadStep } from "./upload-setup.js";
import { disposeViewer, renderComparison, renderRun, selectEntry, selectNextEntry } from "./comparison-view.js";
import { renderScreens, renderScreenViewer } from "./screens-view.js";
import { renderSettings } from "./settings-view.js";
import { api, escapeHtml, formatDate, header, initializeUI, projectTabs, root, settingsAction, shortSha, state } from "./ui.js";

initializeUI();

function errorPage(error) {
  root.innerHTML = header(`<div class="hero"><span class="eyebrow">Something went wrong</span><h1>Couldn’t load this view.</h1><p>${escapeHtml(error.message)}</p><a class="button" href="/" data-link>Back to projects</a></div>`);
}

async function route() {
  const routeGeneration = ++state.routeGeneration;
  disposeViewer();
  state.keyHandler = null;
  root.innerHTML = `<main class="center"><div class="spinner" aria-label="Loading"></div></main>`;
  try {
    if (!state.me) state.me = await api("/api/v1/me");
    if (routeGeneration !== state.routeGeneration) return;
    const path = location.pathname;
    if (path === "/github/callback") return await completeGitHubCallback(routeGeneration);
    if (path === "/projects/new") return await renderNewProject(routeGeneration);
    if (path === "/settings/tokens") return await renderWorkspaceTokens(routeGeneration);
    const project = path.match(/^\/projects\/([^/]+)$/);
    const projectSetup = path.match(/^\/projects\/([^/]+)\/setup$/);
    const projectSettings = path.match(/^\/projects\/([^/]+)\/settings$/);
    const projectScreens = path.match(/^\/projects\/([^/]+)\/screens$/);
    const screenViewer = path.match(/^\/projects\/([^/]+)\/screens\/view$/);
    const run = path.match(/^\/runs\/([^/]+)$/);
    const comparison = path.match(/^\/comparisons\/([^/]+)$/);
    if (projectSetup) return await renderProjectSetup(projectSetup[1], routeGeneration);
    if (projectSettings) return await renderSettings(projectSettings[1], routeGeneration);
    if (projectScreens) return await renderScreens(projectScreens[1], routeGeneration);
    if (screenViewer) return await renderScreenViewer(screenViewer[1], routeGeneration);
    if (project) return await renderProject(project[1], routeGeneration);
    if (run) return await renderRun(run[1], routeGeneration, navigate);
    if (comparison) return await renderComparison(comparison[1], routeGeneration);
    return await renderHome(routeGeneration);
  } catch (error) {
    if (routeGeneration !== state.routeGeneration) return;
    if (error.status === 401) return renderLogin();
    errorPage(error);
  }
}

async function completeGitHubCallback(routeGeneration) {
  const parameters = new URLSearchParams(location.search);
  const code = parameters.get("code");
  const signedState = parameters.get("state");
  if (!signedState) throw new Error("GitHub returned an incomplete authorization callback.");
  let callbackState;
  try {
    const encoded = signedState.split(".")[0].replaceAll("-", "+").replaceAll("_", "/");
    callbackState = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
  } catch { throw new Error("GitHub returned an invalid authorization state."); }
  if (callbackState.purpose === "github_onboarding") {
    const result = await api("/api/v1/github/installations", {
      method: "POST",
      body: JSON.stringify({ code, state: signedState, installationId: Number(parameters.get("installation_id") || callbackState.installationId) }),
    });
    if (routeGeneration !== state.routeGeneration) return;
    if (result.authorizationUrl) return location.assign(result.authorizationUrl);
    return navigate("/projects/new?github=connected", true);
  }
  const projectId = callbackState.projectId;
  if (!code) throw new Error("GitHub authorization did not return a code.");
  if (typeof projectId !== "string") throw new Error("GitHub authorization did not identify a project.");
  await api(`/api/v1/projects/${encodeURIComponent(projectId)}/github-installation`, {
    method: "POST", body: JSON.stringify({ code, state: signedState }),
  });
  if (routeGeneration !== state.routeGeneration) return;
  navigate(`/projects/${encodeURIComponent(projectId)}`, true);
}

function renderLogin() {
  state.me = null;
  root.innerHTML = `<main class="center"><section class="hero"><span class="eyebrow">Visual review for CI</span><h1>See the change.<br>Ship with confidence.</h1><p>Private screenshot comparisons, precise baselines, and GitHub checks—without making product images public.</p><a class="button primary" href="/auth/login">Sign in</a></section></main>`;
}

async function renderHome(routeGeneration) {
  const { projects } = await api("/api/v1/projects");
  if (routeGeneration !== state.routeGeneration) return;
  const admin = state.me.user.role === "admin";
  const rows = projects.map((project) => `<a class="project-row" href="/projects/${encodeURIComponent(project.id)}" data-link><span class="project-identity"><span class="project-avatar">${escapeHtml(project.name.slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.repositoryOwner)}/${escapeHtml(project.repositoryName)}</small></span></span><span class="project-branch"><span class="mobile-label">Default branch</span>${escapeHtml(project.defaultBranch)}</span><span class="row-arrow" aria-hidden="true">→</span></a>`).join("");
  const empty = admin
    ? `<section class="empty onboarding-empty"><span class="eyebrow">Get started</span><h2>Upload your first snapshots</h2><p>Create one workspace key, add it to CI, and run the uploader. SnappyDiff detects the repository and creates its project automatically.</p><a class="button primary" href="/projects/new" data-link>Set up uploads</a></section>`
    : `<div class="empty">No projects are available yet. A project appears after its first snapshot upload.</div>`;
  root.innerHTML = header(`<div class="page-heading"><div><h1>Projects</h1><p>Manage visual snapshots and review recent runs.</p></div>${admin ? `<a class="button primary" href="/projects/new" data-link>Upload setup</a>` : ""}</div>${rows ? `<section class="project-table"><div class="project-table-head"><span>Project</span><span>Default branch</span><span></span></div>${rows}</section>` : empty}`);
}

async function renderNewProject(routeGeneration) {
  if (state.me.user.role !== "admin") throw new Error("Only workspace administrators can create projects.");
  const [{ tokens }, { projects }] = await Promise.all([api("/api/v1/workspace-tokens"), api("/api/v1/projects")]);
  if (routeGeneration !== state.routeGeneration) return;
  const activeTokens = tokens.filter((token) => !token.revokedAt);
  const initialProjectIds = new Set(projects.map((project) => project.id));
  const showStep = (content) => { root.innerHTML = header(`<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><span>Upload setup</span></nav>${content}`); };
  showStep(createKeyStep(activeTokens.length));
  root.querySelector("[data-workspace-token-create]").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await settingsAction(event.submitter, () => api("/api/v1/workspace-tokens", { method: "POST", body: JSON.stringify({ name: form.get("name"), expiresInDays: Number(form.get("expiresInDays")) }) }));
    if (!result || routeGeneration !== state.routeGeneration) return;
    showStep(configureUploadStep(result.token, state.me.configuration.appOrigin));
    root.querySelector("[data-copy-token]").addEventListener("click", copyWorkspaceToken);
    root.querySelector("[data-setup-done]").addEventListener("click", () => {
      showStep(waitForUploadStep());
      bindUploadRefresh(showStep, routeGeneration, initialProjectIds);
    });
  });
}

async function copyWorkspaceToken(event) {
  const button = event.currentTarget;
  const token = root.querySelector("[data-workspace-token]")?.textContent;
  if (!token) return;
  try {
    await navigator.clipboard.writeText(token);
    button.textContent = "Copied";
  } catch { button.textContent = "Copy failed"; }
}

function bindUploadRefresh(showStep, routeGeneration, initialProjectIds) {
  root.querySelector("[data-refresh-projects]")?.addEventListener("click", async (event) => {
    const result = await settingsAction(event.currentTarget, () => api("/api/v1/projects"));
    if (!result || routeGeneration !== state.routeGeneration) return;
    const project = findNewProject(result.projects, initialProjectIds);
    if (project) return navigate(`/projects/${encodeURIComponent(project.id)}`);
    showStep(waitForUploadStep("No upload received yet."));
    bindUploadRefresh(showStep, routeGeneration, initialProjectIds);
  });
}

async function renderWorkspaceTokens(routeGeneration) {
  if (state.me.user.role !== "admin") throw new Error("Only workspace administrators can manage upload keys.");
  const { tokens } = await api("/api/v1/workspace-tokens");
  if (routeGeneration !== state.routeGeneration) return;
  const rows = tokens.map((token) => `<div class="management-row"><div><strong>${escapeHtml(token.name)}</strong><small>${escapeHtml(token.tokenPrefix)}… · expires ${formatDate(token.expiresAt)}${token.revokedAt ? " · revoked" : ""}</small></div>${token.revokedAt ? "" : `<button class="button danger" data-revoke-workspace-token="${escapeHtml(token.id)}">Revoke</button>`}</div>`).join("");
  root.innerHTML = header(`<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><span>Workspace keys</span></nav><div class="title-row"><h1>Workspace keys</h1><a class="button primary" href="/projects/new" data-link>Create key</a></div><section class="settings-card token-management">${rows || `<div class="empty">No workspace keys have been created.</div>`}</section>`);
  root.querySelectorAll("[data-revoke-workspace-token]").forEach((button) => button.addEventListener("click", async () => {
    let revoked = false;
    await settingsAction(button, async () => {
      await api(`/api/v1/tokens/${encodeURIComponent(button.dataset.revokeWorkspaceToken)}`, { method: "DELETE" });
      revoked = true;
    });
    if (revoked && routeGeneration === state.routeGeneration) await renderWorkspaceTokens(routeGeneration);
  }));
}

async function renderProjectSetup(projectId, routeGeneration) {
  const { project } = await api(`/api/v1/projects/${encodeURIComponent(projectId)}`);
  if (routeGeneration !== state.routeGeneration) return;
  if (!project.githubConnected) {
    root.innerHTML = header(`<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><span>Setup</span></nav><section class="setup-complete"><span class="eyebrow">Workspace uploads</span><h1>This project is created automatically.</h1><p>Use a workspace upload key in CI. SnappyDiff detects this repository and routes uploads here without a project ID.</p><a class="button primary" href="/projects/new" data-link>Open upload setup</a></section>`);
    return;
  }
  const workflow = `permissions:\n  contents: read\n  id-token: write\n  checks: read\n\nsteps:\n  - uses: actions/checkout@v4\n    with:\n      fetch-depth: 0\n  # Add this after your existing snapshot test step.\n${oidcUploadWorkflow(state.me.configuration.appOrigin, state.me.configuration.oidcAudience).split("\n").map((line) => `  ${line}`).join("\n")}`;
  root.innerHTML = header(`<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><span>Setup</span></nav><section class="setup-wizard setup-wizard-wide"><span class="step-label">GitHub Actions</span><h1>${escapeHtml(project.repositoryOwner)}/${escapeHtml(project.repositoryName)}</h1><pre><code>${escapeHtml(workflow)}</code></pre><div class="form-actions"><a class="button" href="/" data-link>All projects</a><a class="button primary" href="/projects/${encodeURIComponent(project.id)}" data-link>Open project</a></div></section>`);
}

async function renderProject(projectId, routeGeneration) {
  const { project, runs, nextCursor } = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/run-history`);
  if (routeGeneration !== state.routeGeneration) return;
  const rows = runs.map(runRow).join("");
  const settings = state.me.user.role === "admin" ? `<a class="button" href="/projects/${encodeURIComponent(projectId)}/settings" data-link>Project settings</a>` : "";
  root.innerHTML = header(`<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><span>${escapeHtml(project.name)}</span></nav><span class="eyebrow">${escapeHtml(project.repositoryOwner)}/${escapeHtml(project.repositoryName)}</span><div class="title-row"><h1>${escapeHtml(project.name)}</h1>${settings}</div>${projectTabs(projectId, "runs")}<div class="section-head"><h2>Recent runs</h2><span class="muted">Newest first</span></div>${rows ? `<div class="run-list" id="run-list">${rows}</div>${nextCursor ? `<button class="button" data-runs-more="${escapeHtml(nextCursor)}">Load older runs</button>` : ""}` : `<div class="empty">No screenshot runs have arrived for this project.</div>`}`);
  if (!rows && state.me.user.role === "admin") {
    root.querySelector(".empty")?.insertAdjacentHTML("beforeend", `<p><a class="button primary" href="/projects/${encodeURIComponent(projectId)}/setup" data-link>Configure CI upload</a></p>`);
  }
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

function runRow(run) {
  const target = run.comparisonId ? `/comparisons/${run.comparisonId}` : `/runs/${run.id}`;
  const status = run.comparisonStatus || run.state;
  return `<a class="run-row" href="${target}" data-link><div class="run-meta"><strong>${escapeHtml(run.branch)}</strong><small><span class="sha">${escapeHtml(shortSha(run.commitSha))}</span> · ${formatDate(run.createdAt)}</small></div><div class="run-source">${run.pullRequestNumber ? `PR #${run.pullRequestNumber}` : "Branch run"}</div><span class="pill ${escapeHtml(status)}">${escapeHtml(String(status).replaceAll("_", " "))}</span><div class="counts"><span><b>${run.changedCount ?? 0}</b> changed</span><span><b>${run.addedCount ?? 0}</b> added</span><span><b>${run.removedCount ?? 0}</b> removed</span></div><span class="row-arrow" aria-hidden="true">→</span></a>`;
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
  if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) || event.metaKey || event.ctrlKey || event.altKey) return;
  if (state.keyHandler) return state.keyHandler(event);
  if (["ArrowDown", "j", "J"].includes(event.key)) { event.preventDefault(); selectNextEntry(); }
  if (["ArrowUp", "k", "K"].includes(event.key)) { event.preventDefault(); selectEntry(state.selected - 1); }
});
addEventListener("popstate", route);
route();
