import { categoryLabels, commentActions, commentCategories, isOutdated, normalizedRegion, orderComments, statusLabels } from "./feedback.js";
import { api, escapeHtml, formatDate, state } from "./ui.js";

const imageUrl = (id) => `/api/v1/images/${encodeURIComponent(id)}/content`;

export async function mountComments({ projectId, panel, stage, screenshotName, runId, currentImageId, highlightId, isCurrent }) {
  const local = {
    comments: [],
    drafting: false,
    draftRegion: null,
    editingId: null,
    expanded: new Set(highlightId ? [highlightId] : []),
    showClosed: false,
    selectedId: highlightId ?? null,
    originalId: null,
    error: "",
  };
  const image = stage?.querySelector("img");
  const layer = stage?.querySelector("[data-annotation-layer]");

  const showError = (message) => {
    local.error = message;
    const element = panel.querySelector("[data-comment-error]");
    if (element) { element.textContent = message; element.hidden = !message; }
  };
  const request = async (operation) => {
    showError("");
    try { return await operation(); } catch (error) { showError(error.message); return null; }
  };
  const replace = (comment) => { local.comments = local.comments.map((item) => item.id === comment.id ? { ...item, ...comment } : item); };
  const visible = () => orderComments(local.comments).filter((comment) => local.showClosed || comment.status === "open" || comment.id === local.selectedId);

  const payload = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/comments?screenshot=${encodeURIComponent(screenshotName)}`);
  if (isCurrent && !isCurrent()) return;
  local.comments = payload.comments;
  if (highlightId) {
    const detail = await api(`/api/v1/comments/${encodeURIComponent(highlightId)}`).catch(() => null);
    if (isCurrent && !isCurrent()) return;
    if (detail?.comment.screenshotName === screenshotName) replace(detail.comment);
  }

  function render() {
    renderList();
    renderPins();
    if (image && currentImageId) {
      const original = local.comments.find((comment) => comment.id === local.originalId);
      const source = imageUrl(original?.imageId ?? currentImageId);
      if (image.getAttribute("src") !== source) image.setAttribute("src", source);
    }
  }

  function renderPins() {
    if (!layer) return;
    layer.classList.toggle("drafting", local.drafting);
    const pins = visible().map((comment, index) => ({ comment, number: index + 1 })).filter(({ comment }) => comment.region)
      .map(({ comment, number }) => {
        const { x, y, width, height } = comment.region;
        const classes = ["annotation", comment.status, comment.id === local.selectedId ? "selected" : "", isOutdated(comment, currentImageId) && comment.id !== local.originalId ? "outdated" : ""].join(" ");
        return `<button type="button" class="${classes}" data-pin="${escapeHtml(comment.id)}" data-region="${[x, y, width, height].join(",")}" aria-label="Comment ${number}"><span>${number}</span></button>`;
      }).join("");
    const draft = local.drafting && local.draftRegion
      ? `<div class="annotation draft" data-region="${[local.draftRegion.x, local.draftRegion.y, local.draftRegion.width, local.draftRegion.height].join(",")}"></div>`
      : "";
    layer.innerHTML = pins + draft;
    // The dashboard CSP forbids inline style attributes, so regions are positioned through the CSSOM.
    layer.querySelectorAll("[data-region]").forEach((element) => {
      const [x, y, width, height] = element.dataset.region.split(",").map(Number);
      Object.assign(element.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` });
    });
  }

  function categorySelect(selected) {
    return `<select name="category">${commentCategories.map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("")}</select>`;
  }

  function draftHint() {
    if (!layer) return "This comment applies to the whole screen.";
    return local.draftRegion ? `Area marked. <button type="button" class="link-button" data-clear-region>Use whole screen</button>`
      : "Drag on the screenshot to mark an area, or leave it to comment on the whole screen.";
  }

  function updateDraftHint() {
    const hint = panel.querySelector("[data-draft-hint]");
    if (hint) hint.innerHTML = draftHint();
  }

  function draftForm() {
    return `<form class="comment-form" data-comment-form><p class="comment-hint" data-draft-hint>${draftHint()}</p><label>Category${categorySelect("translation")}</label><label>Comment<textarea name="body" required maxlength="4000" rows="3" placeholder="What should change?"></textarea></label><label>Suggested text <span class="optional">Optional</span><input name="suggestedText" maxlength="2000" placeholder="Proposed wording"></label><div class="form-actions compact"><button type="button" class="button" data-cancel-draft>Cancel</button><button class="button primary">Add comment</button></div></form>`;
  }

  function commentItem(comment, number) {
    const actions = commentActions(state.me.user, comment);
    const outdated = isOutdated(comment, currentImageId);
    const editing = local.editingId === comment.id;
    const expanded = local.expanded.has(comment.id);
    const statusButtons = [
      actions.resolve ? `<button type="button" class="link-button" data-status="resolved">Resolve</button>` : "",
      actions.wontFix ? `<button type="button" class="link-button" data-status="wont_fix">Won’t fix</button>` : "",
      actions.reopen ? `<button type="button" class="link-button" data-status="open">Reopen</button>` : "",
      actions.edit && !editing ? `<button type="button" class="link-button" data-edit>Edit</button>` : "",
      actions.remove ? `<button type="button" class="link-button danger" data-delete>Delete</button>` : "",
    ].join("");
    const content = editing
      ? `<form class="comment-form" data-edit-form><label>Category${categorySelect(comment.category)}</label><label>Comment<textarea name="body" required maxlength="4000" rows="3">${escapeHtml(comment.body)}</textarea></label><label>Suggested text <span class="optional">Optional</span><input name="suggestedText" maxlength="2000" value="${escapeHtml(comment.suggestedText ?? "")}"></label><div class="form-actions compact"><button type="button" class="button" data-cancel-edit>Cancel</button><button class="button primary">Save</button></div></form>`
      : `<p class="comment-body">${escapeHtml(comment.body)}</p>${comment.suggestedText ? `<div class="suggestion"><span>Suggested text</span><p>${escapeHtml(comment.suggestedText)}</p></div>` : ""}`;
    const outdatedNote = outdated
      ? `<div class="outdated-note">Written on an earlier build. <button type="button" class="link-button" data-show-original>${local.originalId === comment.id ? "Show current" : "Show original"}</button></div>`
      : "";
    const statusNote = comment.status !== "open" && comment.statusChangedByName ? `<span class="muted">${escapeHtml(statusLabels[comment.status])} by ${escapeHtml(comment.statusChangedByName)}</span>` : "";
    const replies = expanded ? replyThread(comment) : "";
    const replyToggle = `<button type="button" class="link-button" data-toggle-replies>${expanded ? "Hide replies" : comment.replyCount ? `${comment.replyCount} ${comment.replyCount === 1 ? "reply" : "replies"}` : "Reply"}</button>`;
    return `<article class="comment ${escapeHtml(comment.status)} ${comment.id === local.selectedId ? "selected" : ""}" data-comment-id="${escapeHtml(comment.id)}"><header><span class="comment-number">${comment.region ? number : "•"}</span><span class="pill">${escapeHtml(categoryLabels[comment.category] ?? comment.category)}</span>${comment.status === "open" ? "" : `<span class="pill ${comment.status === "resolved" ? "accepted" : ""}">${escapeHtml(statusLabels[comment.status])}</span>`}<span class="comment-meta">${escapeHtml(comment.authorName || "Unknown")} · ${formatDate(comment.createdAt)}</span></header>${outdatedNote}${content}<footer>${replyToggle}${statusButtons}${statusNote}</footer>${replies}</article>`;
  }

  function replyThread(comment) {
    const replies = (comment.replies ?? []).map((reply) => {
      const removable = reply.authorUserId === state.me.user.id || state.me.user.role === "admin";
      return `<li><div class="comment-meta">${escapeHtml(reply.authorName || "Unknown")} · ${formatDate(reply.createdAt)}${removable ? ` <button type="button" class="link-button danger" data-delete-reply="${escapeHtml(reply.id)}">Delete</button>` : ""}</div><p class="comment-body">${escapeHtml(reply.body)}</p></li>`;
    }).join("");
    const loading = comment.replies ? "" : `<li class="muted">Loading replies…</li>`;
    return `<div class="replies"><ul>${replies}${loading}</ul><form class="reply-form" data-reply-form><textarea name="body" required maxlength="4000" rows="2" placeholder="Write a reply…"></textarea><button class="button">Reply</button></form></div>`;
  }

  function renderList() {
    const list = visible();
    const closed = local.comments.filter((comment) => comment.status !== "open").length;
    const open = local.comments.length - closed;
    const items = list.map((comment, index) => commentItem(comment, index + 1)).join("");
    const empty = local.comments.length ? (list.length ? "" : `<p class="muted comment-empty">No open comments.</p>`)
      : `<p class="muted comment-empty">No feedback yet. Add the first comment for this screen.</p>`;
    panel.innerHTML = `<div class="comments-head"><div><span class="eyebrow">Feedback</span><h2>${open} open</h2></div>${local.drafting ? "" : `<button type="button" class="button primary" data-comment-add>Add comment</button>`}</div><div class="form-error" role="alert" data-comment-error ${local.error ? "" : "hidden"}>${escapeHtml(local.error)}</div>${local.drafting ? draftForm() : ""}<div class="comment-list">${items}${empty}</div>${closed ? `<button type="button" class="link-button closed-toggle" data-toggle-closed>${local.showClosed ? "Hide" : "Show"} ${closed} resolved</button>` : ""}`;
  }

  async function loadReplies(commentId) {
    const detail = await request(() => api(`/api/v1/comments/${encodeURIComponent(commentId)}`));
    if (detail) { replace(detail.comment); render(); }
  }

  function startDraft() {
    local.drafting = true;
    local.draftRegion = null;
    render();
    panel.querySelector("textarea")?.focus();
  }

  panel.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    const item = target.closest("[data-comment-id]");
    const commentId = item?.dataset.commentId;
    if (target.matches("[data-comment-add]")) return startDraft();
    if (target.matches("[data-cancel-draft]")) { local.drafting = false; local.draftRegion = null; return render(); }
    if (target.matches("[data-clear-region]")) { local.draftRegion = null; renderPins(); return updateDraftHint(); }
    if (target.matches("[data-toggle-closed]")) { local.showClosed = !local.showClosed; return render(); }
    if (!commentId) return;
    local.selectedId = commentId;
    if (target.matches("[data-edit]")) { local.editingId = commentId; return render(); }
    if (target.matches("[data-cancel-edit]")) { local.editingId = null; return render(); }
    if (target.matches("[data-show-original]")) { local.originalId = local.originalId === commentId ? null : commentId; return render(); }
    if (target.matches("[data-toggle-replies]")) {
      if (local.expanded.has(commentId)) local.expanded.delete(commentId); else local.expanded.add(commentId);
      render();
      if (local.expanded.has(commentId) && !local.comments.find((comment) => comment.id === commentId)?.replies) await loadReplies(commentId);
      return;
    }
    if (target.dataset.status) {
      target.disabled = true;
      const result = await request(() => api(`/api/v1/comments/${encodeURIComponent(commentId)}`, { method: "PATCH", body: JSON.stringify({ status: target.dataset.status }) }));
      if (result) { replace(result.comment); render(); }
      return;
    }
    if (target.matches("[data-delete]")) {
      if (!confirm("Delete this comment and its replies?")) return;
      const result = await request(() => api(`/api/v1/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" }).then(() => true));
      if (result) { local.comments = local.comments.filter((comment) => comment.id !== commentId); render(); }
      return;
    }
    if (target.dataset.deleteReply) {
      if (!confirm("Delete this reply?")) return;
      const result = await request(() => api(`/api/v1/comment-replies/${encodeURIComponent(target.dataset.deleteReply)}`, { method: "DELETE" }));
      if (result) { replace(result.comment); render(); }
    }
  });

  panel.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const submit = form.querySelector("button:not([type=button])");
    if (submit) submit.disabled = true;
    if (form.matches("[data-comment-form]")) {
      const result = await request(() => api(`/api/v1/projects/${encodeURIComponent(projectId)}/comments`, {
        method: "POST",
        body: JSON.stringify({ screenshotName, runId, region: local.draftRegion ?? undefined, category: data.get("category"), body: data.get("body"), suggestedText: data.get("suggestedText") || undefined }),
      }));
      if (result) {
        local.comments.push(result.comment);
        local.drafting = false;
        local.draftRegion = null;
        local.selectedId = result.comment.id;
        render();
      } else if (submit) submit.disabled = false;
      return;
    }
    const commentId = form.closest("[data-comment-id]")?.dataset.commentId;
    if (!commentId) return;
    if (form.matches("[data-edit-form]")) {
      const result = await request(() => api(`/api/v1/comments/${encodeURIComponent(commentId)}`, {
        method: "PATCH",
        body: JSON.stringify({ category: data.get("category"), body: data.get("body"), suggestedText: data.get("suggestedText") || null }),
      }));
      if (result) { local.editingId = null; replace(result.comment); render(); } else if (submit) submit.disabled = false;
      return;
    }
    if (form.matches("[data-reply-form]")) {
      const result = await request(() => api(`/api/v1/comments/${encodeURIComponent(commentId)}/replies`, { method: "POST", body: JSON.stringify({ body: data.get("body") }) }));
      if (result) { replace(result.comment); render(); } else if (submit) submit.disabled = false;
    }
  });

  panel.addEventListener("mouseover", (event) => {
    const commentId = event.target.closest("[data-comment-id]")?.dataset.commentId ?? null;
    layer?.querySelectorAll("[data-pin]").forEach((pin) => pin.classList.toggle("hovered", pin.dataset.pin === commentId));
  });

  layer?.addEventListener("click", (event) => {
    const pin = event.target.closest("[data-pin]");
    if (!pin || local.drafting) return;
    local.selectedId = pin.dataset.pin;
    render();
    panel.querySelector(`[data-comment-id="${CSS.escape(pin.dataset.pin)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  layer?.addEventListener("pointerdown", (event) => {
    if (!local.drafting || event.button !== 0) return;
    event.preventDefault();
    const bounds = layer.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    try { layer.setPointerCapture(event.pointerId); } catch { /* The pointer may already be released. */ }
    const move = (moveEvent) => {
      local.draftRegion = normalizedRegion(start, { x: moveEvent.clientX, y: moveEvent.clientY }, bounds);
      renderPins();
    };
    const end = (endEvent) => {
      move(endEvent);
      layer.removeEventListener("pointermove", move);
      layer.removeEventListener("pointerup", end);
      layer.removeEventListener("pointercancel", end);
      updateDraftHint();
      panel.querySelector("[data-comment-form] textarea")?.focus();
    };
    layer.addEventListener("pointermove", move);
    layer.addEventListener("pointerup", end);
    layer.addEventListener("pointercancel", end);
  });

  render();
  if (highlightId) panel.querySelector(`[data-comment-id="${CSS.escape(highlightId)}"]`)?.scrollIntoView({ block: "nearest" });
  return { startDraft };
}
