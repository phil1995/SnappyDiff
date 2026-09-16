import type { Session } from "./auth.ts";
import { requirePermission } from "./authorization.ts";
import { randomId } from "./crypto.ts";
import { HttpError, json, readJson, type RequestContext } from "./http.ts";
import type { Env } from "./platform.ts";

interface CreateProjectBody {
  name?: unknown;
  slug?: unknown;
  repositoryOwner?: unknown;
  repositoryName?: unknown;
  defaultBranch?: unknown;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]{1,100}$/;

export async function listProjects(env: Env, session: Session): Promise<Response> {
  requirePermission(session, "runs:view");
  const result = await env.DB.prepare(`
    SELECT id, name, slug, repository_owner AS repositoryOwner, repository_name AS repositoryName,
      default_branch AS defaultBranch, created_at AS createdAt
      FROM projects WHERE organization_id = ? AND deleted_at IS NULL ORDER BY name
  `).bind(session.organizationId).all();
  return json({ projects: result.results ?? [] });
}

export async function getProject(env: Env, session: Session, projectId: string): Promise<Response> {
  requirePermission(session, "runs:view");
  const project = await env.DB.prepare(`
    SELECT id, name, slug, repository_owner AS repositoryOwner, repository_name AS repositoryName,
      default_branch AS defaultBranch, retention_days AS retentionDays,
      promoted_retention_days AS promotedRetentionDays, created_at AS createdAt, updated_at AS updatedAt
      FROM projects WHERE organization_id = ? AND id = ? AND deleted_at IS NULL
  `).bind(session.organizationId, projectId).first();
  if (!project) throw new HttpError(404, "project_not_found", "Project was not found");
  return json({ project });
}

export async function createProject(
  request: Request,
  env: Env,
  session: Session,
  context: RequestContext,
): Promise<Response> {
  requirePermission(session, "projects:admin");
  const body = await readJson<CreateProjectBody>(request);
  const name = requiredString(body.name, "name", 100);
  const slug = requiredString(body.slug, "slug", 63).toLowerCase();
  const repositoryOwner = requiredString(body.repositoryOwner, "repositoryOwner", 100);
  const repositoryName = requiredString(body.repositoryName, "repositoryName", 100);
  const defaultBranch = requiredString(body.defaultBranch, "defaultBranch", 255);
  if (!SLUG.test(slug)) throw new HttpError(400, "invalid_slug", "Slug must contain lowercase letters, digits, and internal hyphens");
  if (!REPOSITORY_PART.test(repositoryOwner) || !REPOSITORY_PART.test(repositoryName)) {
    throw new HttpError(400, "invalid_repository", "Repository owner and name contain invalid characters");
  }
  const projectId = randomId("prj");
  const suiteId = randomId("ste");
  const auditId = randomId("aud");
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO projects
        (id, organization_id, name, slug, repository_owner, repository_name, default_branch)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(projectId, session.organizationId, name, slug, repositoryOwner, repositoryName, defaultBranch),
      env.DB.prepare("INSERT INTO suites (id, organization_id, project_id, name, is_system_default) VALUES (?, ?, ?, 'default', 1)")
        .bind(suiteId, session.organizationId, projectId),
      env.DB.prepare(`INSERT INTO audit_events
        (id, organization_id, actor_user_id, action, target_type, target_id, request_id, metadata_json)
        VALUES (?, ?, ?, 'project.created', 'project', ?, ?, ?)`)
        .bind(auditId, session.organizationId, session.userId, projectId, context.requestId, JSON.stringify({ slug, repository: `${repositoryOwner}/${repositoryName}` })),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "project_conflict", "A project with that slug or repository already exists");
    throw error;
  }
  return json({ project: { id: projectId, name, slug, repositoryOwner, repositoryName, defaultBranch } }, { status: 201 });
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new HttpError(400, "invalid_request", `${field} must be a non-empty string no longer than ${maxLength} characters`);
  }
  return value.trim();
}
