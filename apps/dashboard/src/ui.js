export let root;

const initialState = () => ({
  me: null,
  entries: [],
  selected: 0,
  mode: "overlay",
  zoom: 1,
  swipe: .5,
  blinkTimer: null,
  worker: null,
  viewerGeneration: 0,
  routeGeneration: 0,
  comparisonId: null,
});

export const state = initialState();

export function initializeUI() {
  clearInterval(state.blinkTimer);
  state.worker?.terminate();
  root = document.querySelector("#app");
  Object.assign(state, initialState());
}

export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
export const shortSha = (value) => String(value ?? "").slice(0, 8);
export const formatDate = (seconds) => seconds ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(seconds * 1000) : "—";
export const formatBytes = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

export async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  if (response.status === 401) throw Object.assign(new Error("Authentication required"), { status: 401 });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body;
}

export function header(content, full = false) {
  const path = location.pathname;
  const projectsActive = path === "/" || path.startsWith("/projects");
  const keysActive = path === "/settings/tokens";
  const email = state.me?.user.email ?? "";
  const initial = email.slice(0, 1).toUpperCase() || "S";
  const keySettings = state.me?.user.role === "admin" ? `<a class="nav-item ${keysActive ? "active" : ""}" href="/settings/tokens" data-link><span class="nav-icon">${icon("key")}</span><span>Workspace keys</span></a>` : "";
  const mobileKeySettings = state.me?.user.role === "admin" ? `<a href="/settings/tokens" data-link>Keys</a>` : "";
  const account = state.me ? `<div class="sidebar-account"><span class="avatar">${escapeHtml(initial)}</span><span class="account-copy"><strong>${escapeHtml(email)}</strong><small>${escapeHtml(state.me.user.role)}</small></span><button data-logout aria-label="Sign out" title="Sign out">${icon("logout")}</button></div>` : "";
  return `<div class="shell"><aside class="app-sidebar"><a class="brand" href="/" data-link><span class="brand-mark">${icon("brand")}</span><span>SnappyDiff</span></a><nav class="primary-nav" aria-label="Main navigation"><a class="nav-item ${projectsActive ? "active" : ""}" href="/" data-link><span class="nav-icon">${icon("projects")}</span><span>Projects</span></a></nav><div class="sidebar-spacer"></div><nav class="secondary-nav" aria-label="Workspace navigation">${keySettings}</nav>${account}</aside><div class="app-frame"><header class="mobile-topbar"><a class="brand" href="/" data-link><span class="brand-mark">${icon("brand")}</span><span>SnappyDiff</span></a><nav class="mobile-nav" aria-label="Mobile navigation"><a href="/" data-link>Projects</a>${mobileKeySettings}<button data-logout>Sign out</button></nav></header><main class="page ${full ? "page-review" : ""}">${content}</main></div></div>`;
}

function icon(name) {
  const paths = {
    brand: `<rect x="3" y="3" width="11" height="11" rx="2"></rect><rect x="10" y="10" width="11" height="11" rx="2"></rect>`,
    projects: `<path d="M3 6.5h6l1.6 2H21v10.5H3z"></path><path d="M3 9h18"></path>`,
    key: `<circle cx="8.5" cy="10" r="4"></circle><path d="m11.5 12.5 7 7M16 17l2-2M13.5 14.5l2-2"></path>`,
    logout: `<path d="M10 4H5v16h5M14 8l4 4-4 4M8 12h10"></path>`,
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}

export async function settingsAction(control, operation) {
  const canLabel = control?.tagName === "BUTTON";
  const original = canLabel ? control.textContent : null;
  if (control) control.disabled = true;
  try { return await operation(); }
  catch (error) { if (canLabel) control.textContent = error.message; else if (control) control.title = error.message; return null; }
  finally { if (control) { control.disabled = false; if (canLabel) setTimeout(() => { if (control.isConnected) control.textContent = original; }, 2500); } }
}
