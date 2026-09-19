import type { Session } from "./auth.ts";
import { requirePermission } from "./authorization.ts";
import { HttpError, json } from "./http.ts";
import { localFixturePng } from "./local-fixtures.ts";
import type { Env } from "./platform.ts";

export async function listProjectRuns(env: Env, session: Session, projectId: string, before: string | null): Promise<Response> {
  requirePermission(session, "runs:view");
  const cursor = before?.match(/^(\d+):([A-Za-z0-9_]+)$/);
  if (before && !cursor) throw new HttpError(400, "invalid_cursor", "Run cursor is invalid");
  const beforeCreatedAt = cursor?.[1] ? Number(cursor[1]) : Number.MAX_SAFE_INTEGER;
  const beforeId = cursor?.[2] ?? "~";
  const project = await env.DB.prepare("SELECT id, name, repository_owner AS repositoryOwner, repository_name AS repositoryName FROM projects WHERE id = ? AND organization_id = ? AND deleted_at IS NULL")
    .bind(projectId, session.organizationId).first();
  if (!project) throw new HttpError(404, "project_not_found", "Project was not found");
  const result = await env.DB.prepare(`
    SELECT r.id, r.commit_sha AS commitSha, r.branch, r.provider, r.provider_run_id AS providerRunId,
      r.attempt_number AS attemptNumber, r.pull_request_number AS pullRequestNumber, r.state,
      r.screenshot_count AS screenshotCount, r.logical_bytes AS logicalBytes, r.created_at AS createdAt,
      r.completed_at AS completedAt, c.id AS comparisonId, c.status AS comparisonStatus,
      c.added_count AS addedCount, c.removed_count AS removedCount, c.changed_count AS changedCount
      FROM runs r LEFT JOIN comparisons c ON c.organization_id = r.organization_id AND c.current_run_id = r.id
     WHERE r.organization_id = ? AND r.project_id = ?
       AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?))
     ORDER BY r.created_at DESC, r.id DESC LIMIT 51
  `).bind(session.organizationId, projectId, beforeCreatedAt, beforeCreatedAt, beforeId).all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const page = rows.slice(0, 50);
  const last = page.at(-1);
  return json({ project, runs: page, nextCursor: rows.length > 50 && last ? `${last["createdAt"]}:${last["id"]}` : null });
}

export async function getDashboardRun(env: Env, session: Session, runId: string): Promise<Response> {
  requirePermission(session, "runs:view");
  const run = await env.DB.prepare(`
    SELECT r.id, r.project_id AS projectId, p.name AS projectName, r.commit_sha AS commitSha, r.branch,
      r.provider, r.provider_run_id AS providerRunId, r.attempt_number AS attemptNumber,
      r.pull_request_number AS pullRequestNumber, r.trust_class AS trustClass, r.state,
      r.screenshot_count AS screenshotCount, r.logical_bytes AS logicalBytes,
      r.created_at AS createdAt, r.completed_at AS completedAt,
      c.id AS comparisonId, c.status AS comparisonStatus, c.added_count AS addedCount,
      c.removed_count AS removedCount, c.changed_count AS changedCount, c.unchanged_count AS unchangedCount
      FROM runs r JOIN projects p ON p.id = r.project_id AND p.organization_id = r.organization_id
      LEFT JOIN comparisons c ON c.current_run_id = r.id AND c.organization_id = r.organization_id
     WHERE r.id = ? AND r.organization_id = ?
  `).bind(runId, session.organizationId).first();
  if (!run) throw new HttpError(404, "run_not_found", "Run was not found");
  const shards = await env.DB.prepare(`
    SELECT shard_key AS shardKey, state, received_pages AS receivedPages, expected_pages AS expectedPages,
      created_at AS createdAt, finalized_at AS finalizedAt
      FROM run_shards WHERE organization_id = ? AND run_id = ? ORDER BY shard_key
  `).bind(session.organizationId, runId).all();
  return json({ run, shards: shards.results ?? [] });
}

export async function getPrivateImage(env: Env, session: Session, imageId: string): Promise<Response> {
  requirePermission(session, "runs:view");
  const image = await env.DB.prepare(`
    SELECT i.r2_key AS storageKey, i.byte_size AS byteSize
      FROM images i WHERE i.id = ? AND i.organization_id = ? AND i.reference_state = 'active'
       AND EXISTS (SELECT 1 FROM screenshots s WHERE s.organization_id = i.organization_id AND s.image_id = i.id)
  `).bind(imageId, session.organizationId).first<{ storageKey: string; byteSize: number }>();
  if (!image) throw new HttpError(404, "image_not_found", "Image was not found");
  if (env.APP_ENV === "local") {
    const fixture = await localFixturePng(image.storageKey);
    if (fixture) return privatePng(fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength) as ArrayBuffer);
  }
  const object = await env.IMAGES.get(image.storageKey);
  if (!object || object.size !== image.byteSize) throw new HttpError(503, "image_unavailable", "Image storage is temporarily unavailable");
  return privatePng(object.body, object.size);
}

function privatePng(body: BodyInit, size?: number): Response {
  return new Response(body, {
    headers: {
      "content-type": "image/png",
      ...(size === undefined ? {} : { "content-length": String(size) }),
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}
