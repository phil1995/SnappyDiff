const REPOSITORY_PART = /^[A-Za-z0-9_.-]{1,100}$/;

export function parseGitHubRepository(value) {
  let candidate = String(value ?? "").trim().replace(/\/+$/, "");
  if (!candidate) throw new Error("Enter a GitHub repository as owner/repository.");

  if (candidate.startsWith("git@github.com:")) candidate = candidate.slice("git@github.com:".length);
  else if (/^https?:\/\//i.test(candidate)) {
    let url;
    try { url = new URL(candidate); }
    catch { throw new Error("Enter a valid GitHub repository URL."); }
    if (url.hostname.toLowerCase() !== "github.com") throw new Error("The repository must be hosted on github.com.");
    candidate = url.pathname.replace(/^\/+|\/+$/g, "");
  }

  candidate = candidate.replace(/\.git$/i, "");
  const parts = candidate.split("/");
  if (parts.length !== 2 || !parts.every((part) => REPOSITORY_PART.test(part))) {
    throw new Error("Use owner/repository, for example phil1995/SnappyDiff.");
  }
  return { repositoryOwner: parts[0], repositoryName: parts[1] };
}

export function projectSlug(value, fallback = "project") {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  if (slug) return slug;
  const fallbackSlug = String(fallback).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/g, "");
  return fallbackSlug || "project";
}

export function projectSetupPath(projectId, requestGeneration, currentGeneration) {
  if (requestGeneration !== currentGeneration) return null;
  return `/projects/${encodeURIComponent(projectId)}/setup`;
}

export function setProjectFormError(form, message = null) {
  const element = form?.querySelector?.("[data-project-error]");
  if (!element) return;
  element.hidden = message === null;
  if (message !== null) element.textContent = String(message);
}
