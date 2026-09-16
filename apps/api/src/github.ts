import { randomId, timingSafeEqual } from "./crypto.ts";
import { requirePermission } from "./authorization.ts";
import type { Session } from "./auth.ts";
import { HttpError, json, readBytes, readJson, type RequestContext } from "./http.ts";
import type { PendingJob } from "./jobs.ts";
import type { Env } from "./platform.ts";

const encoder = new TextEncoder();

interface GitHubCheckContext {
  id: string;
  organization_id: string;
  project_id: string;
  run_id: string;
  installation_id: string;
  github_check_id: number | null;
  desired_version: number;
  delivered_version: number;
  scope_key: string;
  owner_run_id: string;
  repository_owner: string;
  repository_name: string;
  commit_sha: string;
  status: string | null;
  added_count: number | null;
  removed_count: number | null;
  changed_count: number | null;
  baseline_warning: string | null;
  comparison_id: string | null;
}

export async function ensureInProgressGitHubCheck(
  env: Env,
  organizationId: string,
  projectId: string,
  runId: string,
  pullRequestNumber: number,
  attemptNumber: number,
): Promise<void> {
  const installation = await env.DB.prepare(`
    SELECT i.installation_id FROM projects p JOIN github_installations i
      ON i.organization_id = p.organization_id AND i.repository_owner = p.repository_owner
      AND i.repository_name = p.repository_name AND i.suspended_at IS NULL
     WHERE p.id = ? AND p.organization_id = ? LIMIT 1
  `).bind(projectId, organizationId).first<{ installation_id: number }>();
  if (!installation) return;
  const scopeKey = `pr:${pullRequestNumber}`;
  const proposedCheckId = randomId("ghc");
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO github_check_owners (organization_id, project_id, scope_key, run_id, attempt_number)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (organization_id, project_id, scope_key) DO UPDATE SET
        run_id = excluded.run_id, attempt_number = excluded.attempt_number, updated_at = unixepoch()
      WHERE excluded.attempt_number >= github_check_owners.attempt_number
    `).bind(organizationId, projectId, scopeKey, runId, attemptNumber),
    env.DB.prepare(`
      INSERT INTO github_checks (id, organization_id, project_id, run_id, installation_id, scope_key)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM github_check_owners WHERE organization_id = ? AND project_id = ?
          AND scope_key = ? AND run_id = ?
      ) ON CONFLICT (organization_id, run_id) DO NOTHING
    `).bind(proposedCheckId, organizationId, projectId, runId, String(installation.installation_id), scopeKey,
      organizationId, projectId, scopeKey, runId),
  ]);
  const check = await env.DB.prepare(`
    SELECT gc.id, gc.desired_version FROM github_checks gc JOIN github_check_owners o
      ON o.organization_id = gc.organization_id AND o.project_id = gc.project_id AND o.scope_key = gc.scope_key
     WHERE gc.organization_id = ? AND gc.run_id = ? AND o.run_id = gc.run_id
  `).bind(organizationId, runId).first<{ id: string; desired_version: number }>();
  if (!check) return;
  await env.DB.prepare(`
    INSERT INTO jobs (id, organization_id, kind, deduplication_key, payload_json)
    VALUES (?, ?, 'deliver_github_check', ?, ?) ON CONFLICT (organization_id, deduplication_key) DO NOTHING
  `).bind(randomId("job"), organizationId, `github:${check.id}:${check.desired_version}`,
    JSON.stringify({ checkId: check.id })).run();
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function appJwt(env: Env): Promise<string> {
  if (!env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_APP_ID === "0") throw new HttpError(503, "github_not_configured", "GitHub App is not configured");
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })));
  const keyBytes = Uint8Array.from(atob(env.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n").replace(/-----[^-]+-----|\s/g, "")), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", keyBytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function githubRequest<T>(env: Env, path: string, init: RequestInit = {}, installationId?: number): Promise<T> {
  let bearer = await appJwt(env);
  if (installationId !== undefined) {
    const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: githubHeaders(bearer),
    });
    if (!response.ok) throw new Error(`GitHub installation token request failed: ${response.status}`);
    bearer = ((await response.json()) as { token: string }).token;
  }
  const response = await fetch(`https://api.github.com${path}`, { ...init, headers: { ...githubHeaders(bearer), ...(init.headers as Record<string, string> | undefined) } });
  if (!response.ok) throw new Error(`GitHub API request failed: ${response.status}`);
  return response.status === 204 ? (undefined as T) : (await response.json()) as T;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "SnappyDiff",
    "x-github-api-version": "2022-11-28",
  };
}

export async function classifyPullRequestFork(
  env: Env,
  installationId: number,
  owner: string,
  repository: string,
  pullRequestNumber: number,
): Promise<boolean> {
  const pull = await githubRequest<{ head: { repo: { full_name: string } | null }; base: { repo: { full_name: string } } }>(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${pullRequestNumber}`,
    {},
    installationId,
  );
  if (!pull.head.repo) return true;
  return pull.head.repo.full_name.toLowerCase() !== pull.base.repo.full_name.toLowerCase();
}

export async function deliverGitHubCheckJob(env: Env, job: PendingJob): Promise<void> {
  const { checkId } = JSON.parse(job.payload_json) as { checkId: string };
  const check = await env.DB.prepare(`
    SELECT gc.id, gc.organization_id, gc.project_id, gc.run_id, gc.installation_id, gc.github_check_id,
      gc.desired_version, gc.delivered_version, gc.scope_key, o.run_id AS owner_run_id,
      p.repository_owner, p.repository_name, r.commit_sha,
      c.id AS comparison_id, c.status, c.added_count, c.removed_count, c.changed_count, c.baseline_warning
      FROM github_checks gc JOIN github_check_owners o
        ON o.organization_id = gc.organization_id AND o.project_id = gc.project_id AND o.scope_key = gc.scope_key
      JOIN projects p ON p.id = gc.project_id AND p.organization_id = gc.organization_id
      JOIN runs r ON r.id = gc.run_id AND r.organization_id = gc.organization_id
      LEFT JOIN comparisons c ON c.current_run_id = gc.run_id AND c.organization_id = gc.organization_id
     WHERE gc.id = ? AND gc.organization_id = ?
  `).bind(checkId, job.organization_id).first<GitHubCheckContext>();
  if (!check || check.owner_run_id !== check.run_id || check.delivered_version >= check.desired_version) return;
  const installationId = Number(check.installation_id);
  let remoteId = check.github_check_id;
  if (!remoteId) {
    const existing = await githubRequest<{ check_runs: Array<{ id: number; external_id?: string }> }>(env,
      `/repos/${encodeURIComponent(check.repository_owner)}/${encodeURIComponent(check.repository_name)}/commits/${check.commit_sha}/check-runs?check_name=SnappyDiff&filter=all`, {}, installationId);
    remoteId = existing.check_runs.find((item) => item.external_id === check.id)?.id ?? null;
  }
  const inProgress = check.comparison_id === null;
  const summary = inProgress ? "Screenshots are uploading and the comparison is pending."
    : `${check.changed_count ?? 0} changed · ${check.added_count ?? 0} added · ${check.removed_count ?? 0} removed`;
  const conclusion = check.status === "passed" || check.status === "accepted" ? "success"
    : check.status === "rejected" ? "failure" : check.status === "error" ? "neutral" : "action_required";
  const payload: Record<string, unknown> = {
    name: "SnappyDiff",
    head_sha: check.commit_sha,
    status: inProgress ? "in_progress" : "completed",
    external_id: check.id,
    details_url: inProgress ? `${env.APP_ORIGIN}/runs/${check.run_id}` : `${env.APP_ORIGIN}/comparisons/${check.comparison_id}`,
    output: {
      title: inProgress ? "Snapshot comparison in progress"
        : check.status === "action_required" ? "Snapshot changes detected" : "Snapshot comparison complete",
      summary: inProgress ? summary
        : `${summary}${check.baseline_warning ? `\n\n${check.baseline_warning}` : ""}\n\n[View visual report](${env.APP_ORIGIN}/comparisons/${check.comparison_id})`,
    },
  };
  if (!inProgress) payload["conclusion"] = conclusion;
  if (remoteId) {
    await githubRequest(env, `/repos/${encodeURIComponent(check.repository_owner)}/${encodeURIComponent(check.repository_name)}/check-runs/${remoteId}`,
      { method: "PATCH", body: JSON.stringify(payload) }, installationId);
  } else {
    const created = await githubRequest<{ id: number }>(env,
      `/repos/${encodeURIComponent(check.repository_owner)}/${encodeURIComponent(check.repository_name)}/check-runs`,
      { method: "POST", body: JSON.stringify(payload) }, installationId);
    remoteId = created.id;
  }
  await env.DB.prepare(`
    UPDATE github_checks SET github_check_id = ?, delivered_version = desired_version, state = 'delivered',
      last_error = NULL, updated_at = unixepoch() WHERE id = ? AND organization_id = ? AND desired_version = ?
  `).bind(remoteId, check.id, check.organization_id, check.desired_version).run();
}

export async function refreshGitHubStateJob(env: Env, job: PendingJob): Promise<void> {
  const { projectId } = JSON.parse(job.payload_json) as { projectId: string };
  const project = await env.DB.prepare(`
    SELECT p.id, p.organization_id, p.repository_owner, p.repository_name, p.default_branch, s.id AS suite_id,
      i.installation_id FROM projects p JOIN suites s ON s.project_id = p.id AND s.organization_id = p.organization_id
      JOIN github_installations i ON i.organization_id = p.organization_id
        AND i.repository_owner = p.repository_owner AND i.repository_name = p.repository_name AND i.suspended_at IS NULL
     WHERE p.id = ? AND p.organization_id = ?
  `).bind(projectId, job.organization_id).first<{
    id: string; organization_id: string; repository_owner: string; repository_name: string;
    default_branch: string; suite_id: string; installation_id: number;
  }>();
  if (!project) return;
  const branch = await githubRequest<{ commit: { sha: string } }>(env,
    `/repos/${encodeURIComponent(project.repository_owner)}/${encodeURIComponent(project.repository_name)}/branches/${encodeURIComponent(project.default_branch)}`,
    {}, project.installation_id);
  await env.DB.prepare("UPDATE suites SET known_default_head_sha = ?, updated_at = unixepoch() WHERE id = ? AND organization_id = ?")
    .bind(branch.commit.sha, project.suite_id, project.organization_id).run();
}

export async function verifyGitHubWebhook(body: Uint8Array<ArrayBuffer>, signature: string, secret: string): Promise<void> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  const expected = `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (!timingSafeEqual(expected, signature)) throw new HttpError(401, "invalid_webhook_signature", "GitHub webhook signature is invalid");
}

export async function handleGitHubWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) throw new HttpError(503, "webhook_not_configured", "GitHub webhook handling is not configured");
  const body = await readBytes(request, 2 * 1024 * 1024);
  await verifyGitHubWebhook(body, request.headers.get("x-hub-signature-256") ?? "", env.GITHUB_WEBHOOK_SECRET);
  const delivery = request.headers.get("x-github-delivery");
  const eventName = request.headers.get("x-github-event");
  if (!delivery || !eventName) throw new HttpError(400, "invalid_webhook", "GitHub webhook headers are incomplete");
  const inserted = await env.DB.prepare("INSERT INTO github_webhook_deliveries (delivery_id, event_name) VALUES (?, ?) ON CONFLICT DO NOTHING")
    .bind(delivery, eventName).run();
  if (Number(inserted.meta?.["changes"] ?? 0) !== 1) {
    const prior = await env.DB.prepare("SELECT processed_at FROM github_webhook_deliveries WHERE delivery_id = ?")
      .bind(delivery).first<{ processed_at: number | null }>();
    if (prior?.processed_at) return json({ received: true, repeated: true });
  }
  let payload: Record<string, any>;
  try { payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, any>; }
  catch { throw new HttpError(400, "invalid_json", "GitHub webhook body must be valid JSON"); }
  if (eventName === "installation" && payload["installation"]?.id) {
    const suspended = ["suspend", "deleted"].includes(String(payload["action"]));
    await env.DB.prepare("UPDATE github_installations SET suspended_at = ?, updated_at = unixepoch() WHERE installation_id = ?")
      .bind(suspended ? Math.floor(Date.now() / 1000) : null, Number(payload["installation"].id)).run();
  }
  if (eventName === "pull_request" && payload["repository"] && payload["pull_request"]) {
    const installationId = Number(payload["installation"]?.id ?? 0);
    const mappings = await env.DB.prepare(`
      SELECT organization_id FROM github_installations WHERE installation_id = ?
       AND repository_owner = ? AND repository_name = ?
    `).bind(installationId, String(payload["repository"].owner?.login), String(payload["repository"].name)).all<{ organization_id: string }>();
    for (const mapping of mappings.results ?? []) {
      const project = await env.DB.prepare("SELECT id FROM projects WHERE organization_id = ? AND repository_owner = ? AND repository_name = ?")
        .bind(mapping.organization_id, String(payload["repository"].owner?.login), String(payload["repository"].name)).first<{ id: string }>();
      if (!project) continue;
      const state = payload["pull_request"].state === "open" ? "open" : "closed";
      await env.DB.prepare(`
        INSERT INTO pull_requests (organization_id, project_id, number, state, head_sha, base_sha, installation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (organization_id, project_id, number) DO UPDATE SET
          state = excluded.state, head_sha = excluded.head_sha, base_sha = excluded.base_sha,
          installation_id = excluded.installation_id, updated_at = unixepoch()
      `).bind(mapping.organization_id, project.id, Number(payload["number"]), state,
        String(payload["pull_request"].head?.sha ?? ""), String(payload["pull_request"].base?.sha ?? ""), installationId).run();
      if (state === "closed") {
        await env.DB.prepare("UPDATE retention_pins SET released_at = unixepoch() WHERE organization_id = ? AND owner_type = 'open_pull_request' AND owner_id = ? AND released_at IS NULL")
          .bind(mapping.organization_id, `pr:${Number(payload["number"])}`).run();
      }
    }
  }
  if (eventName === "installation_repositories" && payload["installation"]?.id) {
    for (const repository of payload["repositories_removed"] ?? []) {
      await env.DB.prepare(`
        UPDATE github_installations SET suspended_at = unixepoch(), updated_at = unixepoch()
         WHERE installation_id = ? AND repository_owner = ? AND repository_name = ?
      `).bind(Number(payload["installation"].id), String(repository.owner?.login), String(repository.name)).run();
    }
  }
  if (eventName === "push" && payload["repository"]) {
    const installationId = Number(payload["installation"]?.id ?? 0);
    const mappings = await env.DB.prepare(`
      SELECT i.organization_id, p.id AS project_id FROM github_installations i JOIN projects p
        ON p.organization_id = i.organization_id AND p.repository_owner = i.repository_owner AND p.repository_name = i.repository_name
       WHERE i.installation_id = ? AND i.repository_owner = ? AND i.repository_name = ? AND i.suspended_at IS NULL
    `).bind(installationId, String(payload["repository"].owner?.login), String(payload["repository"].name))
      .all<{ organization_id: string; project_id: string }>();
    for (const mapping of mappings.results ?? []) {
      await env.DB.prepare(`
        INSERT INTO jobs (id, organization_id, kind, deduplication_key, payload_json)
        VALUES (?, ?, 'refresh_github_state', ?, ?) ON CONFLICT (organization_id, deduplication_key) DO NOTHING
      `).bind(randomId("job"), mapping.organization_id, `github-refresh:${mapping.project_id}:${delivery}`, JSON.stringify({ projectId: mapping.project_id })).run();
    }
  }
  await env.DB.prepare("UPDATE github_webhook_deliveries SET processed_at = unixepoch() WHERE delivery_id = ?").bind(delivery).run();
  return json({ received: true });
}

export async function linkGitHubInstallation(
  request: Request,
  env: Env,
  session: Session,
  projectId: string,
  context: RequestContext,
): Promise<Response> {
  requirePermission(session, "projects:admin");
  const body = await readJson<{ installationId?: unknown }>(request);
  if (!Number.isSafeInteger(body.installationId) || Number(body.installationId) <= 0) throw new HttpError(400, "invalid_installation", "installationId must be a positive integer");
  const project = await env.DB.prepare("SELECT repository_owner, repository_name FROM projects WHERE id = ? AND organization_id = ? AND deleted_at IS NULL")
    .bind(projectId, session.organizationId).first<{ repository_owner: string; repository_name: string }>();
  if (!project) throw new HttpError(404, "project_not_found", "Project was not found");
  const installationId = Number(body.installationId);
  const repositories = await githubRequest<{ repositories: Array<{ name: string; owner: { login: string } }> }>(env, "/installation/repositories?per_page=100", {}, installationId);
  if (!repositories.repositories.some((repo) => repo.name === project.repository_name && repo.owner.login.toLowerCase() === project.repository_owner.toLowerCase())) {
    throw new HttpError(403, "repository_not_installed", "GitHub App installation does not include this repository");
  }
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO github_installations (id, organization_id, installation_id, account_login, repository_owner, repository_name)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (organization_id, installation_id, repository_owner, repository_name)
      DO UPDATE SET suspended_at = NULL, updated_at = unixepoch()
    `).bind(randomId("ghi"), session.organizationId, installationId, project.repository_owner, project.repository_owner, project.repository_name),
    env.DB.prepare(`
      INSERT INTO audit_events (id, organization_id, actor_user_id, action, target_type, target_id, request_id, metadata_json)
      VALUES (?, ?, ?, 'github.installation_linked', 'project', ?, ?, ?)
    `).bind(randomId("aud"), session.organizationId, session.userId, projectId, context.requestId, JSON.stringify({ installationId })),
  ]);
  return json({ linked: true });
}
