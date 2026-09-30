import { categoryLabels, commentCategories, commentLocation, commentsCsv, filterComments, statusLabels } from "./feedback.js";
import { orderLocales, screenLabel, screenViewerSearch } from "./screen-matrix.js";
import { api, escapeHtml, formatDate, header, projectTabs, root, state } from "./ui.js";

const statusFilters = [["open", "Open"], ["resolved", "Resolved"], ["wont_fix", "Won’t fix"], ["all", "All"]];

async function loadComments(projectId, status) {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/comments${status === "all" ? "" : `?status=${status}`}`;
  const comments = [];
  let cursor = null;
  do {
    const page = await api(cursor ? `${base}${base.includes("?") ? "&" : "?"}before=${encodeURIComponent(cursor)}` : base);
    comments.push(...page.comments);
    cursor = page.nextCursor;
  } while (cursor);
  return comments;
}

function viewerPath(projectId, comment) {
  return `/projects/${encodeURIComponent(projectId)}/screens/view${screenViewerSearch({ ...commentLocation(comment), comment: comment.id })}`;
}

export async function renderFeedback(projectId, routeGeneration) {
  const parameters = new URLSearchParams(location.search);
  const status = statusFilters.some(([value]) => value === parameters.get("status")) ? parameters.get("status") : "open";
  const [{ project }, comments] = await Promise.all([
    api(`/api/v1/projects/${encodeURIComponent(projectId)}`),
    loadComments(projectId, status),
  ]);
  if (routeGeneration !== state.routeGeneration) return;
  const filters = { locale: parameters.get("locale") ?? "", category: parameters.get("category") ?? "", query: parameters.get("q") ?? "" };
  const locales = orderLocales(comments.map((comment) => commentLocation(comment).locale));
  const option = (value, label, selected) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
  const statusTabs = statusFilters.map(([value, label]) => `<button type="button" class="tool ${value === status ? "active" : ""}" data-feedback-status="${value}">${label}</button>`).join("");
  const controls = `<div class="screens-controls feedback-controls"><div class="segmented" role="group" aria-label="Status">${statusTabs}</div><label>Language<select data-feedback-locale>${option("", "All languages", filters.locale)}${locales.map((locale) => option(locale, locale, filters.locale)).join("")}</select></label><label>Category<select data-feedback-category>${option("", "All categories", filters.category)}${commentCategories.map(([value, label]) => option(value, label, filters.category)).join("")}</select></label><label class="screens-search">Search<input type="search" data-feedback-search placeholder="Screen, text, author…" value="${escapeHtml(filters.query)}"></label><span class="tool-spacer"></span><button type="button" class="button" data-feedback-export>Export CSV</button></div>`;
  root.innerHTML = header(`<nav class="crumbs"><a href="/" data-link>Projects</a><span>/</span><a href="/projects/${encodeURIComponent(project.id)}" data-link>${escapeHtml(project.name)}</a><span>/</span><span>Feedback</span></nav><span class="eyebrow">${escapeHtml(project.repositoryOwner)}/${escapeHtml(project.repositoryName)}</span><div class="title-row"><h1>${escapeHtml(project.name)}</h1></div>${projectTabs(project.id, "feedback")}${comments.length ? controls : ""}<div id="feedback-list"></div>`);
  const sync = () => {
    const next = new URLSearchParams();
    if (status !== "open") next.set("status", status);
    if (filters.locale) next.set("locale", filters.locale);
    if (filters.category) next.set("category", filters.category);
    if (filters.query) next.set("q", filters.query);
    const search = next.toString();
    history.replaceState({}, "", `${location.pathname}${search ? `?${search}` : ""}`);
  };
  const render = () => {
    const list = root.querySelector("#feedback-list");
    if (!list) return;
    const filtered = filterComments(comments, filters);
    if (!comments.length) {
      list.innerHTML = `<div class="empty">${status === "open" ? "No open feedback. Add comments from any screen in the Screens tab." : `No ${escapeHtml(statusLabels[status]?.toLowerCase() ?? "")} feedback.`}</div>`;
      return;
    }
    const rows = filtered.map((comment) => {
      const location = commentLocation(comment);
      const variant = [location.locale, location.device].filter(Boolean).join(" · ");
      return `<a class="feedback-row" href="${viewerPath(project.id, comment)}" data-link><div class="feedback-screen"><span class="screen-name" title="${escapeHtml(location.screen)}"><strong>${escapeHtml(screenLabel(location.screen).title)}</strong>${screenLabel(location.screen).context ? `<small>${escapeHtml(screenLabel(location.screen).context)}</small>` : ""}</span>${variant ? `<span class="pill mono">${escapeHtml(variant)}</span>` : ""}</div><div class="feedback-copy"><p>${escapeHtml(comment.body)}</p>${comment.suggestedText ? `<p class="feedback-suggestion">→ ${escapeHtml(comment.suggestedText)}</p>` : ""}</div><div class="feedback-meta"><span class="pill">${escapeHtml(categoryLabels[comment.category] ?? comment.category)}</span>${status === "all" || comment.status !== status ? `<span class="pill ${comment.status === "resolved" ? "accepted" : ""}">${escapeHtml(statusLabels[comment.status])}</span>` : ""}<small>${escapeHtml(comment.authorName || "Unknown")} · ${formatDate(comment.createdAt)}${comment.replyCount ? ` · ${comment.replyCount} ${comment.replyCount === 1 ? "reply" : "replies"}` : ""}</small></div></a>`;
    }).join("");
    list.innerHTML = `<div class="section-head"><h2>${filtered.length} ${filtered.length === 1 ? "comment" : "comments"}</h2>${filtered.length !== comments.length ? `<span class="muted">of ${comments.length}</span>` : ""}</div>${rows ? `<div class="feedback-list">${rows}</div>` : `<div class="empty">No feedback matches these filters.</div>`}`;
  };
  render();
  root.querySelectorAll("[data-feedback-status]").forEach((button) => button.addEventListener("click", () => {
    const next = new URLSearchParams(location.search);
    if (button.dataset.feedbackStatus === "open") next.delete("status"); else next.set("status", button.dataset.feedbackStatus);
    const search = next.toString();
    history.replaceState({}, "", `${location.pathname}${search ? `?${search}` : ""}`);
    renderFeedback(projectId, routeGeneration);
  }));
  root.querySelector("[data-feedback-locale]")?.addEventListener("change", (event) => { filters.locale = event.target.value; sync(); render(); });
  root.querySelector("[data-feedback-category]")?.addEventListener("change", (event) => { filters.category = event.target.value; sync(); render(); });
  root.querySelector("[data-feedback-search]")?.addEventListener("input", (event) => { filters.query = event.target.value; sync(); render(); });
  root.querySelector("[data-feedback-export]")?.addEventListener("click", () => {
    const csv = commentsCsv(filterComments(comments, filters), (comment) => new URL(viewerPath(project.id, comment), location.origin).href);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
    link.download = `${project.name.replace(/[^\w.-]+/g, "-")}-feedback-${status}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
}
