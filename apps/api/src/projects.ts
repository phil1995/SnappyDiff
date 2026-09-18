import type { Session } from "./auth.ts";
import { requirePermission } from "./authorization.ts";
import { randomId } from "./crypto.ts";
import { HttpError, json } from "./http.ts";
import type { Env } from "./platform.ts";

const REPOSITORY_PART = /^[A-Za-z0-9_.-]{1,100}$/;

export interface RepositoryProjectInput {
  repositoryOwner: string;
  repositoryName: string;
  defaultBranch?: string;
  githubRepositoryId?: number;
}

export interface RepositoryProject {
  id: string;
  organizationId: string;
  repositoryOwner: string;
  repositoryName: string;
  created: boolean;
}

export async function resolveOrCreateRepositoryProject(
  env: Env,
  organizationId: string,
  input: RepositoryProjectInput,
): Promise<RepositoryProject> {
  if (!REPOSITORY_PART.test(input.repositoryOwner) || !REPOSITORY_PART.test(input.repositoryName)
    || (input.defaultBranch !== undefined && (!input.defaultBranch || input.defaultBranch.length > 255))
    || (input.githubRepositoryId !== undefined && (!Number.isSafeInteger(input.githubRepositoryId) || input.githubRepositoryId <= 0))) {
    throw new HttpError(400, "invalid_repository", "Repository identity is invalid");
  }
  type StoredProject = { id: string; organization_id: string; repository_owner: string;
    repository_name: string; github_repository_id: number | null };
  const findById = (repositoryId: number) => env.DB.prepare(`
    SELECT id, organization_id, repository_owner, repository_name, github_repository_id FROM projects
     WHERE organization_id = ? AND github_repository_id = ? LIMIT 1
  `).bind(organizationId, repositoryId).first<StoredProject>();
  const findByName = () => env.DB.prepare(`
    SELECT id, organization_id, repository_owner, repository_name, github_repository_id FROM projects
     WHERE organization_id = ? AND lower(repository_owner) = lower(?) AND lower(repository_name) = lower(?) LIMIT 1
  `).bind(organizationId, input.repositoryOwner, input.repositoryName).first<StoredProject>();
  const resolveExisting = async (): Promise<StoredProject | null> => {
    if (input.githubRepositoryId === undefined) return findByName();
    const identified = await findById(input.githubRepositoryId);
    if (identified) return identified;
    const named = await findByName();
    if (named?.github_repository_id != null) {
      throw new HttpError(409, "repository_identity_conflict", "This repository name belongs to a different GitHub repository identity");
    }
    return named;
  };
  let project = await resolveExisting();
  let created = false;
  if (!project) {
    const projectId = randomId("prj");
    const slugSuffix = input.githubRepositoryId?.toString(36) ?? projectId.slice(-10).toLowerCase();
    const slugBase = input.repositoryName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repository";
    const slug = `${slugBase.slice(0, Math.max(1, 62 - slugSuffix.length)).replace(/-+$/g, "")}-${slugSuffix}`;
    try {
      const result = await env.DB.prepare(`INSERT INTO projects
        (id, organization_id, name, slug, repository_owner, repository_name, github_repository_id, default_branch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(projectId, organizationId, input.repositoryName, slug, input.repositoryOwner, input.repositoryName,
          input.githubRepositoryId ?? null, input.defaultBranch ?? "main").run();
      created = Number(result.meta?.["changes"] ?? 0) === 1;
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
    }
    project = await resolveExisting();
    if (!project) throw new HttpError(409, "project_conflict", "The repository conflicts with an existing project");
  } else {
    try {
      await env.DB.prepare(`UPDATE projects SET repository_owner = ?, repository_name = ?,
        github_repository_id = COALESCE(?, github_repository_id),
        default_branch = CASE WHEN ? IS NULL THEN default_branch ELSE ? END, deleted_at = NULL,
        updated_at = unixepoch() WHERE id = ? AND organization_id = ?`)
        .bind(input.repositoryOwner, input.repositoryName, input.githubRepositoryId ?? null,
          input.defaultBranch ?? null, input.defaultBranch ?? null, project.id, organizationId).run();
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new HttpError(409, "repository_identity_conflict", "Repository identity conflicts with another project");
      }
      throw error;
    }
  }
  await env.DB.prepare(`INSERT INTO suites (id, organization_id, project_id, name, is_system_default)
    VALUES (?, ?, ?, 'default', 1) ON CONFLICT (organization_id, project_id, name) DO NOTHING`)
    .bind(randomId("ste"), organizationId, project.id).run();
  return {
    id: project.id,
    organizationId: project.organization_id,
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    created,
  };
}

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
      promoted_retention_days AS promotedRetentionDays, created_at AS createdAt, updated_at AS updatedAt,
      EXISTS(SELECT 1 FROM github_installations installation
        WHERE installation.organization_id = projects.organization_id
          AND installation.repository_owner = projects.repository_owner
          AND installation.repository_name = projects.repository_name
          AND installation.suspended_at IS NULL) AS githubConnected
      FROM projects WHERE organization_id = ? AND id = ? AND deleted_at IS NULL
  `).bind(session.organizationId, projectId).first();
  if (!project) throw new HttpError(404, "project_not_found", "Project was not found");
  return json({ project });
}
