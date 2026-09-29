import { snapshotVariant } from "./snapshot-groups.js";

export const commentCategories = [
  ["translation", "Translation"],
  ["truncation", "Truncation"],
  ["layout", "Layout"],
  ["other", "Other"],
];
export const categoryLabels = Object.fromEntries(commentCategories);
export const statusLabels = { open: "Open", resolved: "Resolved", wont_fix: "Won’t fix" };

const MINIMUM_REGION_PIXELS = 6;

export function commentActions(user, comment) {
  const triage = user.role === "reviewer" || user.role === "admin";
  const author = comment.authorUserId === user.id;
  return {
    edit: author,
    remove: author || user.role === "admin",
    resolve: comment.status !== "resolved" && (triage || author),
    wontFix: comment.status !== "wont_fix" && triage,
    reopen: comment.status !== "open",
  };
}

export function normalizedRegion(start, end, bounds) {
  const clamp = (value, size) => Math.max(0, Math.min(size, value));
  const left = clamp(Math.min(start.x, end.x) - bounds.left, bounds.width);
  const right = clamp(Math.max(start.x, end.x) - bounds.left, bounds.width);
  const top = clamp(Math.min(start.y, end.y) - bounds.top, bounds.height);
  const bottom = clamp(Math.max(start.y, end.y) - bounds.top, bounds.height);
  if (right - left < MINIMUM_REGION_PIXELS || bottom - top < MINIMUM_REGION_PIXELS) return null;
  const round = (value) => Math.round(value * 1e4) / 1e4;
  return {
    x: round(left / bounds.width),
    y: round(top / bounds.height),
    width: round((right - left) / bounds.width),
    height: round((bottom - top) / bounds.height),
  };
}

export function orderComments(comments) {
  return [...comments].sort((left, right) => Number(left.status !== "open") - Number(right.status !== "open")
    || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export function isOutdated(comment, currentImageId) {
  return Boolean(currentImageId) && comment.imageId !== currentImageId;
}

export function commentLocation(comment) {
  const variant = snapshotVariant({ name: comment.screenshotName });
  return { screen: variant.key, locale: variant.locale, device: variant.device };
}

export function filterComments(comments, { locale, category, query }) {
  const needle = String(query ?? "").trim().toLowerCase();
  return comments.filter((comment) => {
    if (locale && commentLocation(comment).locale !== locale) return false;
    if (category && comment.category !== category) return false;
    return !needle || [comment.screenshotName, comment.body, comment.suggestedText, comment.authorName]
      .some((value) => String(value ?? "").toLowerCase().includes(needle));
  });
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function commentsCsv(comments, linkFor) {
  const header = ["Screen", "Language", "Device", "Category", "Status", "Comment", "Suggested text", "Author", "Created", "Replies", "Link"];
  const rows = comments.map((comment) => {
    const location = commentLocation(comment);
    return [location.screen, location.locale, location.device, categoryLabels[comment.category] ?? comment.category,
      statusLabels[comment.status] ?? comment.status, comment.body, comment.suggestedText, comment.authorName,
      new Date(comment.createdAt * 1000).toISOString(), comment.replyCount, linkFor(comment)];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
