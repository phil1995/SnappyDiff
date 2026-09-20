import { randomId, signJson } from "./crypto.ts";
import { recordAudit } from "./audit.ts";
import { HttpError, json, readJson } from "./http.ts";
import { requireWorkspacePrincipal, type WorkspaceMachineGrant } from "./machine-auth.ts";
import type { Env } from "./platform.ts";
import { resolveOrCreateRepositoryProject } from "./projects.ts";
import { requireOrganizationWritable } from "./privacy.ts";

export async function exchangeWorkspaceKey(request: Request, env: Env): Promise<Response> {
  if (!env.TOKEN_PEPPER || env.TOKEN_PEPPER.length < 32) throw new HttpError(503, "token_authentication_not_configured", "Token exchange is not configured");
  const principal = await requireWorkspacePrincipal(request, env);
  await requireOrganizationWritable(env, principal.organizationId);
  const body = await readJson<{ repositoryOwner?: unknown; repositoryName?: unknown; defaultBranch?: unknown }>(request);
  if (typeof body.repositoryOwner !== "string" || typeof body.repositoryName !== "string"
    || (body.defaultBranch !== undefined && typeof body.defaultBranch !== "string")) {
    throw new HttpError(400, "invalid_repository", "repositoryOwner and repositoryName are required");
  }
  const project = await resolveOrCreateRepositoryProject(env, principal.organizationId, {
    repositoryOwner: body.repositoryOwner,
    repositoryName: body.repositoryName,
    ...(body.defaultBranch === undefined ? {} : { defaultBranch: body.defaultBranch }),
  });
  if (project.created) {
    await recordAudit(env, { organizationId: principal.organizationId, actorTokenId: principal.tokenId,
      action: "project.created_from_upload", targetType: "project", targetId: project.id, requestId: randomId("req"),
      metadata: { repository: `${project.repositoryOwner}/${project.repositoryName}` } });
  }
  const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;
  const grant: WorkspaceMachineGrant = {
    source: "workspace_key",
    tokenId: randomId("wkg"), organizationId: principal.organizationId, projectId: project.id,
    scopes: ["runs:create"], trustClass: "first_party", exp: expiresAt,
  };
  return json({ token: `sd_wkg_${await signJson(grant, env.TOKEN_PEPPER)}`,
    projectId: project.id, expiresAt });
}
