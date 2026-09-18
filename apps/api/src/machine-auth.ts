import { sha256, verifyJson } from "./crypto.ts";
import { HttpError } from "./http.ts";
import type { Env } from "./platform.ts";

export interface MachinePrincipal {
  kind: "token";
  tokenId: string;
  organizationId: string;
  projectId: string;
  scopes: string[];
  trustClass: "first_party" | "fork_isolated";
  runConstraints?: OidcRunConstraints;
}

export interface OidcRunConstraints {
  providerRunId: string;
  attemptNumber: number;
  commitSha: string;
  branch: string;
  pullRequestNumber?: number;
  pullRequestHeadSha?: string;
}

export interface OidcMachineGrant {
  tokenId: string;
  organizationId: string;
  projectId: string;
  scopes: string[];
  trustClass: "first_party" | "fork_isolated";
  runConstraints: OidcRunConstraints;
  exp: number;
}

export interface WorkspaceMachineGrant {
  source: "workspace_key";
  tokenId: string;
  organizationId: string;
  projectId: string;
  scopes: string[];
  trustClass: "first_party";
  exp: number;
}

export interface WorkspacePrincipal {
  tokenId: string;
  organizationId: string;
  scopes: string[];
}

export async function requireWorkspacePrincipal(request: Request, env: Env): Promise<WorkspacePrincipal> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer sd_")) throw new HttpError(401, "workspace_authentication_required", "A workspace upload key is required");
  if (!env.TOKEN_PEPPER || env.TOKEN_PEPPER.length < 32) throw new HttpError(503, "token_authentication_not_configured", "Token authentication is not configured");
  const token = authorization.slice("Bearer ".length);
  const tokenHash = await sha256(`${token}:${env.TOKEN_PEPPER}`);
  const record = await env.DB.prepare(`
    SELECT id, organization_id, scopes_json FROM api_tokens
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > unixepoch() AND project_id IS NULL
  `).bind(tokenHash).first<{ id: string; organization_id: string; scopes_json: string }>();
  if (!record) throw new HttpError(401, "invalid_workspace_key", "Workspace upload key is invalid or expired");
  let scopes: string[];
  try { scopes = JSON.parse(record.scopes_json) as string[]; }
  catch { throw new HttpError(401, "invalid_workspace_key", "Workspace upload key has invalid scopes"); }
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) {
    throw new HttpError(401, "invalid_workspace_key", "Workspace upload key has invalid scopes");
  }
  if (!scopes.includes("projects:bootstrap") || !scopes.includes("runs:create")) {
    throw new HttpError(403, "permission_denied", "Workspace upload key cannot provision repositories");
  }
  await env.DB.prepare("UPDATE api_tokens SET last_used_at = unixepoch() WHERE id = ? AND organization_id = ?")
    .bind(record.id, record.organization_id).run();
  return { tokenId: record.id, organizationId: record.organization_id, scopes };
}

export async function requireMachinePrincipal(request: Request, env: Env): Promise<MachinePrincipal> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer sd_")) throw new HttpError(401, "machine_authentication_required", "An exchanged upload credential is required");
  if (!env.TOKEN_PEPPER || env.TOKEN_PEPPER.length < 32) throw new HttpError(503, "token_authentication_not_configured", "Project token authentication is not configured");
  const token = authorization.slice("Bearer ".length);
  if (token.startsWith("sd_wkg_")) {
    const grant = await verifyJson<WorkspaceMachineGrant>(token.slice("sd_wkg_".length), env.TOKEN_PEPPER);
    if (!grant || grant.source !== "workspace_key" || grant.exp < Date.now() / 1000
      || !Array.isArray(grant.scopes) || !grant.scopes.includes("runs:create")
      || typeof grant.tokenId !== "string" || typeof grant.projectId !== "string" || typeof grant.organizationId !== "string") {
      throw new HttpError(401, "invalid_workspace_credential", "Workspace credential is invalid or expired");
    }
    return { kind: "token", tokenId: grant.tokenId, organizationId: grant.organizationId,
      projectId: grant.projectId, scopes: grant.scopes, trustClass: "first_party" };
  }
  if (token.startsWith("sd_oidc_")) {
    const grant = await verifyJson<OidcMachineGrant>(token.slice("sd_oidc_".length), env.TOKEN_PEPPER);
    if (!grant || grant.exp < Date.now() / 1000 || !Array.isArray(grant.scopes) || !grant.scopes.includes("runs:create")
      || !grant.runConstraints || typeof grant.runConstraints.providerRunId !== "string"
      || !Number.isSafeInteger(grant.runConstraints.attemptNumber)
      || typeof grant.runConstraints.commitSha !== "string" || typeof grant.runConstraints.branch !== "string") {
      throw new HttpError(401, "invalid_oidc_credential", "OIDC credential is invalid or expired");
    }
    return { kind: "token", ...grant };
  }
  throw new HttpError(401, "invalid_machine_credential", "Machine credential is invalid or expired");
}
