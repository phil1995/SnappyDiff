import { sha256 } from "./crypto.ts";
import { HttpError } from "./http.ts";
import type { Env } from "./platform.ts";

export interface MachinePrincipal {
  kind: "token";
  tokenId: string;
  organizationId: string;
  projectId: string;
  scopes: string[];
}

export async function requireMachinePrincipal(request: Request, env: Env): Promise<MachinePrincipal> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer sd_")) throw new HttpError(401, "machine_authentication_required", "A project token is required");
  if (!env.TOKEN_PEPPER || env.TOKEN_PEPPER.length < 32) throw new HttpError(503, "token_authentication_not_configured", "Project token authentication is not configured");
  const token = authorization.slice("Bearer ".length);
  const tokenHash = await sha256(`${token}:${env.TOKEN_PEPPER}`);
  const record = await env.DB.prepare(`
    SELECT id, organization_id, project_id, scopes_json
      FROM api_tokens
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > unixepoch() AND project_id IS NOT NULL
  `).bind(tokenHash).first<{ id: string; organization_id: string; project_id: string; scopes_json: string }>();
  if (!record) throw new HttpError(401, "invalid_project_token", "Project token is invalid or expired");
  let scopes: string[];
  try {
    scopes = JSON.parse(record.scopes_json) as string[];
  } catch {
    throw new HttpError(401, "invalid_project_token", "Project token has invalid scopes");
  }
  if (!scopes.includes("runs:create")) throw new HttpError(403, "permission_denied", "Project token lacks runs:create");
  await env.DB.prepare("UPDATE api_tokens SET last_used_at = unixepoch() WHERE id = ? AND organization_id = ?")
    .bind(record.id, record.organization_id).run();
  return { kind: "token", tokenId: record.id, organizationId: record.organization_id, projectId: record.project_id, scopes };
}

