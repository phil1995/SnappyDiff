import type { Session } from "./auth.ts";
import { requirePermission } from "./authorization.ts";
import { HttpError, json } from "./http.ts";
import type { Env } from "./platform.ts";

const PAGE_SIZE = 500;
const availableRun = "r.state = 'complete' AND r.artifacts_expired_at IS NULL AND r.artifact_expiry_owner IS NULL AND r.metadata_deletion_owner IS NULL";

type ScreenSourceKind = "run" | "rollback" | "baseline" | "default_branch";

interface ScreenSourceRun {
  id: string;
  commitSha: string;
  branch: string;
  pullRequestNumber: number | null;
  createdAt: number;
  completedAt: number | null;
}

export async function listProjectScreens(env: Env, session: Session, projectId: string, runId: string | null, after: string | null): Promise<Response> {
  requirePermission(session, "runs:view");
  const project = await env.DB.prepare(`
    SELECT p.id, p.name, p.repository_owner AS repositoryOwner, p.repository_name AS repositoryName,
      p.default_branch AS defaultBranch, s.active_baseline_run_id AS activeBaselineRunId, s.rollback_run_id AS rollbackRunId
      FROM projects p LEFT JOIN suites s ON s.project_id = p.id AND s.organization_id = p.organization_id AND s.name = 'default'
     WHERE p.id = ? AND p.organization_id = ? AND p.deleted_at IS NULL
  `).bind(projectId, session.organizationId).first<{
    id: string; name: string; repositoryOwner: string; repositoryName: string; defaultBranch: string;
    activeBaselineRunId: string | null; rollbackRunId: string | null;
  }>();
  if (!project) throw new HttpError(404, "project_not_found", "Project was not found");
  const { activeBaselineRunId, rollbackRunId, ...projectFields } = project;
  const source = await resolveSource(env, session.organizationId, project, runId);
  if (!source) return json({ project: projectFields, source: null, screenshots: [], nextCursor: null });
  const result = await env.DB.prepare(`
    SELECT s.name, CASE WHEN i.reference_state = 'active' THEN i.id END AS imageId, i.width, i.height
      FROM screenshots s JOIN images i ON i.id = s.image_id AND i.organization_id = s.organization_id
     WHERE s.organization_id = ? AND s.run_id = ? AND s.name > ?
     ORDER BY s.name LIMIT ?
  `).bind(session.organizationId, source.run.id, after ?? "", PAGE_SIZE + 1).all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const screenshots = rows.slice(0, PAGE_SIZE);
  return json({
    project: projectFields,
    source: { kind: source.kind, ...source.run },
    screenshots,
    nextCursor: rows.length > PAGE_SIZE ? screenshots.at(-1)?.["name"] ?? null : null,
  });
}

async function resolveSource(
  env: Env,
  organizationId: string,
  project: { id: string; defaultBranch: string; activeBaselineRunId: string | null; rollbackRunId: string | null },
  runId: string | null,
): Promise<{ kind: ScreenSourceKind; run: ScreenSourceRun } | null> {
  const select = `SELECT r.id, r.commit_sha AS commitSha, r.branch, r.pull_request_number AS pullRequestNumber,
    r.created_at AS createdAt, r.completed_at AS completedAt FROM runs r`;
  const byId = (id: string) => env.DB.prepare(`${select} WHERE r.id = ? AND r.organization_id = ? AND r.project_id = ? AND ${availableRun}`)
    .bind(id, organizationId, project.id).first<ScreenSourceRun>();
  if (runId) {
    const run = await byId(runId);
    if (!run) throw new HttpError(404, "run_not_found", "Run was not found or its screenshots have expired");
    return { kind: "run", run };
  }
  for (const [kind, id] of [["rollback", project.rollbackRunId], ["baseline", project.activeBaselineRunId]] as const) {
    if (!id) continue;
    const run = await byId(id);
    if (run) return { kind, run };
  }
  const latest = await env.DB.prepare(`
    ${select} WHERE r.organization_id = ? AND r.project_id = ? AND r.branch = ? AND r.pull_request_number IS NULL
       AND r.trust_class = 'first_party' AND ${availableRun}
     ORDER BY r.created_at DESC, r.id DESC LIMIT 1
  `).bind(organizationId, project.id, project.defaultBranch).first<ScreenSourceRun>();
  return latest ? { kind: "default_branch", run: latest } : null;
}
