import { randomId, signJson } from "./crypto.ts";
import { classifyPullRequestFork } from "./github.ts";
import { HttpError, json, readJson } from "./http.ts";
import type { Env } from "./platform.ts";
import type { OidcMachineGrant } from "./machine-auth.ts";

interface GitHubClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  repository?: string;
  repository_id?: string;
  event_name?: string;
  workflow_ref?: string;
  run_id?: string;
  run_attempt?: string;
  ref?: string;
  sha?: string;
  head_ref?: string;
  base_ref?: string;
}

interface JsonWebKeySet { keys: Array<JsonWebKey & { kid?: string }> }

const cachedKeys = new Map<string, { key: CryptoKey; expiresAt: number }>();

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function githubSigningKey(kid: string): Promise<CryptoKey> {
  const cached = cachedKeys.get(kid);
  if (cached && cached.expiresAt > Date.now()) return cached.key;
  const configurationResponse = await fetch("https://token.actions.githubusercontent.com/.well-known/openid-configuration");
  if (!configurationResponse.ok) throw new HttpError(503, "oidc_unavailable", "GitHub OIDC configuration is unavailable");
  const configuration = await configurationResponse.json() as { jwks_uri: string };
  const keysResponse = await fetch(configuration.jwks_uri);
  if (!keysResponse.ok) throw new HttpError(503, "oidc_unavailable", "GitHub OIDC signing keys are unavailable");
  const keySet = await keysResponse.json() as JsonWebKeySet;
  const jwk = keySet.keys.find((item) => item.kid === kid);
  if (!jwk) throw new HttpError(401, "invalid_oidc_token", "OIDC signing key is unknown");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  cachedKeys.set(kid, { key, expiresAt: Date.now() + 60 * 60 * 1000 });
  return key;
}

export async function verifyGitHubOidc(token: string, audience: string, now = Math.floor(Date.now() / 1000)): Promise<GitHubClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new HttpError(401, "invalid_oidc_token", "OIDC token is malformed");
  let header: { alg?: string; kid?: string };
  let claims: GitHubClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0]))) as { alg?: string; kid?: string };
    claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1]))) as GitHubClaims;
  } catch {
    throw new HttpError(401, "invalid_oidc_token", "OIDC token payload is invalid");
  }
  if (header.alg !== "RS256" || !header.kid) throw new HttpError(401, "invalid_oidc_token", "OIDC signing algorithm is invalid");
  const key = await githubSigningKey(header.kid);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!valid || claims.iss !== "https://token.actions.githubusercontent.com" || !audiences.includes(audience)
    || typeof claims.exp !== "number" || claims.exp < now || (claims.nbf !== undefined && claims.nbf > now + 30)
    || !claims.sub || !claims.repository || !claims.run_id || !claims.run_attempt || !claims.ref || !claims.sha) {
    throw new HttpError(401, "invalid_oidc_token", "OIDC claims are invalid or expired");
  }
  return claims;
}

export async function exchangeGitHubOidc(request: Request, env: Env): Promise<Response> {
  if (!env.TOKEN_PEPPER || env.TOKEN_PEPPER.length < 32) throw new HttpError(503, "token_authentication_not_configured", "OIDC exchange is not configured");
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) throw new HttpError(401, "oidc_token_required", "GitHub OIDC bearer token is required");
  const body = await readJson<{ projectId?: unknown; pullRequestNumber?: unknown }>(request);
  if (typeof body.projectId !== "string") throw new HttpError(400, "invalid_project", "projectId is required");
  const claims = await verifyGitHubOidc(authorization.slice("Bearer ".length), env.GITHUB_OIDC_AUDIENCE);
  const repositoryClaim = claims.repository!;
  const project = await env.DB.prepare(`
    SELECT p.id, p.organization_id, p.repository_owner, p.repository_name FROM projects p
     WHERE p.id = ? AND p.deleted_at IS NULL AND EXISTS (
       SELECT 1 FROM github_installations i WHERE i.organization_id = p.organization_id
         AND i.repository_owner = p.repository_owner AND i.repository_name = p.repository_name
         AND i.suspended_at IS NULL
     )
  `).bind(body.projectId).first<{ id: string; organization_id: string; repository_owner: string; repository_name: string }>();
  if (!project || repositoryClaim.toLowerCase() !== `${project.repository_owner}/${project.repository_name}`.toLowerCase()) {
    throw new HttpError(403, "repository_binding_failed", "OIDC repository is not authorized for this project");
  }
  const attemptNumber = Number(claims.run_attempt);
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || !/^\d+$/.test(claims.run_id!)) {
    throw new HttpError(401, "invalid_oidc_token", "OIDC workflow identity is invalid");
  }
  let trustClass: "first_party" | "fork_isolated" = "first_party";
  let pullRequestNumber: number | undefined;
  let pullRequestHeadSha: string | undefined;
  if (claims.event_name === "pull_request") {
    const pullRef = claims.ref!.match(/^refs\/pull\/(\d+)\/(?:merge|head)$/);
    if (!pullRef?.[1]) throw new HttpError(401, "invalid_oidc_token", "OIDC pull request ref is invalid");
    pullRequestNumber = Number(pullRef[1]);
    if (body.pullRequestNumber != null && Number(body.pullRequestNumber) !== pullRequestNumber) {
      throw new HttpError(403, "pull_request_binding_failed", "Requested pull request does not match the workflow ref");
    }
    const installation = await env.DB.prepare(`
      SELECT installation_id FROM github_installations WHERE organization_id = ?
       AND repository_owner = ? AND repository_name = ? AND suspended_at IS NULL LIMIT 1
    `).bind(project.organization_id, project.repository_owner, project.repository_name).first<{ installation_id: number }>();
    if (!installation) throw new HttpError(403, "github_installation_required", "A GitHub App installation is required for pull request authentication");
    const pull = await classifyPullRequestFork(env, installation.installation_id, project.repository_owner, project.repository_name, pullRequestNumber);
    if (pull.state !== "open") throw new HttpError(403, "pull_request_closed", "Closed pull requests cannot exchange upload credentials");
    if (claims.sha !== pull.headSha && claims.sha !== pull.mergeCommitSha) {
      throw new HttpError(403, "commit_binding_failed", "OIDC commit does not match the current pull request");
    }
    pullRequestHeadSha = pull.headSha;
    trustClass = pull.fork ? "fork_isolated" : "first_party";
    await env.DB.prepare(`
      INSERT INTO pull_requests (organization_id, project_id, number, state, head_sha, base_sha, installation_id, github_updated_at)
      VALUES (?, ?, ?, 'open', ?, ?, ?, ?) ON CONFLICT (organization_id, project_id, number) DO UPDATE SET
        state = 'open', head_sha = excluded.head_sha, base_sha = excluded.base_sha,
        installation_id = excluded.installation_id, github_updated_at = excluded.github_updated_at,
        state_version = pull_requests.state_version + 1, updated_at = unixepoch()
      WHERE excluded.github_updated_at >= pull_requests.github_updated_at
    `).bind(project.organization_id, project.id, pullRequestNumber, pull.headSha, pull.baseSha,
      installation.installation_id, pull.updatedAt).run();
    if (claims.sub !== `repo:${repositoryClaim}:pull_request`) {
      throw new HttpError(403, "subject_binding_failed", "OIDC subject does not match the pull request workflow");
    }
  } else if (!claims.ref!.startsWith("refs/heads/")
    || !["push", "workflow_dispatch", "schedule"].includes(claims.event_name ?? "")
    || claims.sub !== `repo:${repositoryClaim}:ref:${claims.ref}`) {
    throw new HttpError(403, "ref_binding_failed", "Only branch and pull request workflows may exchange credentials");
  }
  const expiresAt = Math.min(claims.exp!, Math.floor(Date.now() / 1000) + 15 * 60);
  const grant: OidcMachineGrant = {
    tokenId: randomId("oidc"), organizationId: project.organization_id, projectId: project.id,
    scopes: ["runs:create"], trustClass, exp: expiresAt,
    runConstraints: {
      providerRunId: claims.run_id!, attemptNumber, commitSha: claims.sha!,
      branch: claims.ref!.replace(/^refs\/(?:heads|pull)\//, ""),
      ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
      ...(pullRequestHeadSha === undefined ? {} : { pullRequestHeadSha }),
    },
  };
  return json({ token: `sd_oidc_${await signJson(grant, env.TOKEN_PEPPER)}`, expiresAt, trustClass, runConstraints: grant.runConstraints });
}
