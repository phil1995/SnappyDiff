import type { Session } from "./auth.ts";
import { requirePermission } from "./authorization.ts";
import { randomId, sha256 } from "./crypto.ts";
import { isAncestor } from "./baselines.ts";
import { HttpError, json, readJson, type RequestContext } from "./http.ts";
import type { D1PreparedStatement, Env } from "./platform.ts";

export async function getProjectOperations(env: Env, session: Session, projectId: string): Promise<Response> {
  requirePermission(session, "runs:view");
  const project = await env.DB.prepare(`
    SELECT p.id, p.name, p.slug, p.repository_owner AS repositoryOwner, p.repository_name AS repositoryName,
      p.default_branch AS defaultBranch, p.retention_days AS retentionDays,
      p.promoted_retention_days AS promotedRetentionDays, s.id AS suiteId,
      s.promotion_mode AS promotionMode, s.active_baseline_run_id AS activeBaselineRunId,
      s.rollback_run_id AS rollbackRunId, s.known_default_head_sha AS knownDefaultHeadSha,
      ar.commit_sha AS activeBaselineSha, rr.commit_sha AS rollbackSha
      FROM projects p JOIN suites s ON s.project_id = p.id AND s.organization_id = p.organization_id
      LEFT JOIN runs ar ON ar.id = s.active_baseline_run_id AND ar.organization_id = s.organization_id
      LEFT JOIN runs rr ON rr.id = s.rollback_run_id AND rr.organization_id = s.organization_id
     WHERE p.id = ? AND p.organization_id = ? AND p.deleted_at IS NULL
  `).bind(projectId, session.organizationId).first();
  if (!project) throw new HttpError(404, "project_not_found", "Project was not found");
  const history = await env.DB.prepare(`
    SELECT b.id, b.action, b.run_id AS runId, b.previous_run_id AS previousRunId, b.created_at AS createdAt,
      r.commit_sha AS commitSha, u.email AS actorEmail
      FROM baselines b JOIN runs r ON r.id = b.run_id AND r.organization_id = b.organization_id
      LEFT JOIN users u ON u.id = b.actor_user_id
     WHERE b.organization_id = ? AND b.suite_id = ? ORDER BY b.created_at DESC, b.id DESC LIMIT 100
  `).bind(session.organizationId, String(project["suiteId"])).all();
  const warnings = await env.DB.prepare(`
    SELECT number, state, retention_state AS retentionState, reconciliation_error AS reconciliationError,
      last_reconciled_at AS lastReconciledAt FROM pull_requests
     WHERE organization_id = ? AND project_id = ? AND retention_state = 'unresolved'
     ORDER BY number
  `).bind(session.organizationId, projectId).all();
  return json({ project, baselineHistory: history.results ?? [], retentionWarnings: warnings.results ?? [] });
}

export async function updateProjectSettings(request: Request, env: Env, session: Session, projectId: string, context: RequestContext): Promise<Response> {
  requirePermission(session, "projects:admin");
  const body = await readJson<{ name?: unknown; defaultBranch?: unknown; retentionDays?: unknown; promotedRetentionDays?: unknown }>(request);
  const name = optionalString(body.name, "name", 100);
  const defaultBranch = optionalString(body.defaultBranch, "defaultBranch", 255);
  const retentionDays = optionalInteger(body.retentionDays, "retentionDays", 1, 3650);
  const promotedRetentionDays = optionalInteger(body.promotedRetentionDays, "promotedRetentionDays", 365, 3650);
  if ([name, defaultBranch, retentionDays, promotedRetentionDays].every((value) => value === undefined)) {
    throw new HttpError(400, "empty_update", "At least one project setting is required");
  }
  const update = await env.DB.prepare(`
    UPDATE projects SET name = COALESCE(?, name), default_branch = COALESCE(?, default_branch),
      retention_days = COALESCE(?, retention_days), promoted_retention_days = COALESCE(?, promoted_retention_days),
      updated_at = unixepoch() WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
  `).bind(name ?? null, defaultBranch ?? null, retentionDays ?? null, promotedRetentionDays ?? null,
    projectId, session.organizationId).run();
  if (Number(update.meta?.["changes"] ?? 0) !== 1) throw new HttpError(404, "project_not_found", "Project was not found");
  await audit(env, session, context, "project.settings_updated", "project", projectId,
    { name, defaultBranch, retentionDays, promotedRetentionDays });
  return json({ updated: true });
}

export async function controlBaseline(request: Request, env: Env, session: Session, projectId: string, context: RequestContext): Promise<Response> {
  requirePermission(session, "baselines:manage");
  const body = await readJson<{ action?: unknown; runId?: unknown }>(request);
  if (!["pause", "resume", "rollback", "clear_rollback", "history_reset"].includes(String(body.action))) {
    throw new HttpError(400, "invalid_baseline_action", "Baseline action is invalid");
  }
  const suite = await env.DB.prepare(`
    SELECT s.id, s.active_baseline_run_id, s.rollback_run_id, s.known_default_head_sha, s.promotion_mode, s.baseline_version
      FROM suites s JOIN projects p ON p.id = s.project_id AND p.organization_id = s.organization_id
     WHERE p.id = ? AND p.organization_id = ? AND p.deleted_at IS NULL
  `).bind(projectId, session.organizationId).first<{
    id: string; active_baseline_run_id: string | null; rollback_run_id: string | null;
    known_default_head_sha: string | null; promotion_mode: string; baseline_version: number;
  }>();
  if (!suite) throw new HttpError(404, "project_not_found", "Project was not found");
  const action = String(body.action);
  if (action === "pause") {
    const result = await env.DB.prepare("UPDATE suites SET promotion_mode = 'paused', baseline_version = baseline_version + 1, updated_at = unixepoch() WHERE id = ? AND organization_id = ? AND baseline_version = ?")
      .bind(suite.id, session.organizationId, suite.baseline_version).run();
    if (Number(result.meta?.["changes"] ?? 0) !== 1) throw new HttpError(409, "baseline_changed", "Baseline state changed; refresh and retry");
  } else if (action === "resume") {
    if (suite.active_baseline_run_id && suite.known_default_head_sha) {
      const active = await env.DB.prepare("SELECT commit_sha FROM runs WHERE id = ? AND organization_id = ?")
        .bind(suite.active_baseline_run_id, session.organizationId).first<{ commit_sha: string }>();
      if (!active || !(await isAncestor(env, session.organizationId, projectId, active.commit_sha, suite.known_default_head_sha))) {
        throw new HttpError(409, "history_reset_required", "The active baseline is not an ancestor of the known default head; choose an explicit history reset run");
      }
    }
    const baselineId = randomId("bsl");
    const results = await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO baselines (id, organization_id, suite_id, run_id, action, actor_user_id, previous_run_id, segment)
        SELECT ?, ?, ?, active_baseline_run_id, 'resume', ?, active_baseline_run_id, ? FROM suites
         WHERE id = ? AND organization_id = ? AND baseline_version = ? AND active_baseline_run_id IS NOT NULL
           AND known_default_head_sha IS ?
      `).bind(baselineId, session.organizationId, suite.id, session.userId, suite.baseline_version + 1,
        suite.id, session.organizationId, suite.baseline_version, suite.known_default_head_sha),
      env.DB.prepare(`UPDATE suites SET promotion_mode = 'automatic', rollback_run_id = NULL,
        baseline_version = baseline_version + 1, updated_at = unixepoch()
        WHERE id = ? AND organization_id = ? AND baseline_version = ? AND known_default_head_sha IS ?`)
        .bind(suite.id, session.organizationId, suite.baseline_version, suite.known_default_head_sha),
      env.DB.prepare(`
        UPDATE retention_pins SET released_at = unixepoch()
         WHERE organization_id = ? AND owner_type = 'rollback' AND owner_id = ? AND released_at IS NULL
           AND EXISTS (SELECT 1 FROM suites WHERE id = ? AND organization_id = ?
             AND baseline_version = ? AND promotion_mode = 'automatic' AND rollback_run_id IS NULL)
      `).bind(session.organizationId, suite.id, suite.id, session.organizationId, suite.baseline_version + 1),
    ]);
    if (Number(results[1]?.meta?.["changes"] ?? 0) !== 1) throw new HttpError(409, "baseline_changed", "Baseline state changed; refresh and retry");
  } else if (action === "clear_rollback") {
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE suites SET rollback_run_id = NULL, baseline_version = baseline_version + 1, updated_at = unixepoch() WHERE id = ? AND organization_id = ? AND baseline_version = ?")
        .bind(suite.id, session.organizationId, suite.baseline_version),
      env.DB.prepare(`
        UPDATE retention_pins SET released_at = unixepoch()
         WHERE organization_id = ? AND owner_type = 'rollback' AND owner_id = ? AND released_at IS NULL
           AND EXISTS (SELECT 1 FROM suites WHERE id = ? AND organization_id = ?
             AND baseline_version = ? AND rollback_run_id IS NULL)
      `).bind(session.organizationId, suite.id, suite.id, session.organizationId, suite.baseline_version + 1),
    ]);
    if (Number(results[0]?.meta?.["changes"] ?? 0) !== 1) throw new HttpError(409, "baseline_changed", "Baseline state changed; refresh and retry");
  } else {
    if (typeof body.runId !== "string") throw new HttpError(400, "run_required", "A completed baseline run is required");
    const run = await env.DB.prepare(`SELECT id, commit_sha FROM runs
      WHERE id = ? AND organization_id = ? AND project_id = ? AND suite_id = ?
        AND state = 'complete' AND trust_class = 'first_party' AND artifacts_expired_at IS NULL
        AND artifact_expiry_owner IS NULL AND metadata_deletion_owner IS NULL`)
      .bind(body.runId, session.organizationId, projectId, suite.id).first<{ id: string; commit_sha: string }>();
    if (!run) throw new HttpError(400, "invalid_baseline_run", "Run is not an eligible completed project run");
    if (action === "history_reset" && suite.known_default_head_sha !== run.commit_sha) {
      throw new HttpError(409, "head_mismatch", "History reset run must match the currently known default-branch head");
    }
    const baselineId = randomId("bsl");
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(`
        INSERT INTO baselines (id, organization_id, suite_id, run_id, action, actor_user_id, previous_run_id, segment)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM suites WHERE id = ? AND organization_id = ? AND baseline_version = ?
            AND (? != 'history_reset' OR known_default_head_sha = ?)
        ) AND EXISTS (
          SELECT 1 FROM runs WHERE id = ? AND organization_id = ? AND artifacts_expired_at IS NULL
            AND artifact_expiry_owner IS NULL AND metadata_deletion_owner IS NULL
        )
      `).bind(baselineId, session.organizationId, suite.id, run.id, action, session.userId,
        suite.active_baseline_run_id, suite.baseline_version + 1, suite.id, session.organizationId,
        suite.baseline_version, action, run.commit_sha, run.id, session.organizationId),
      env.DB.prepare("UPDATE retention_pins SET released_at = unixepoch() WHERE organization_id = ? AND owner_type = ? AND owner_id = ? AND released_at IS NULL AND EXISTS (SELECT 1 FROM baselines WHERE id = ?)")
        .bind(session.organizationId, action === "rollback" ? "rollback" : "active_baseline", suite.id, baselineId),
      env.DB.prepare(`
        INSERT INTO retention_pins (id, organization_id, owner_type, owner_id, run_id)
        SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM baselines WHERE id = ?)
          AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND organization_id = ?
            AND artifacts_expired_at IS NULL AND artifact_expiry_owner IS NULL AND metadata_deletion_owner IS NULL)
      `).bind(randomId("pin"), session.organizationId, action === "rollback" ? "rollback" : "active_baseline",
        suite.id, run.id, baselineId, run.id, session.organizationId),
    ];
    if (action === "rollback") {
      statements.push(env.DB.prepare(`UPDATE suites SET rollback_run_id = ?, baseline_version = baseline_version + 1, updated_at = unixepoch()
        WHERE id = ? AND organization_id = ? AND baseline_version = ? AND EXISTS (SELECT 1 FROM baselines WHERE id = ?)
          AND EXISTS (SELECT 1 FROM retention_pins WHERE organization_id = ? AND owner_type = 'rollback'
            AND owner_id = ? AND run_id = ? AND released_at IS NULL)`)
        .bind(run.id, suite.id, session.organizationId, suite.baseline_version, baselineId,
          session.organizationId, suite.id, run.id));
    } else {
      statements.push(env.DB.prepare(`UPDATE suites SET active_baseline_run_id = ?, rollback_run_id = NULL,
        promotion_mode = 'automatic', baseline_version = baseline_version + 1, updated_at = unixepoch()
        WHERE id = ? AND organization_id = ? AND baseline_version = ? AND EXISTS (SELECT 1 FROM baselines WHERE id = ?)
          AND EXISTS (SELECT 1 FROM retention_pins WHERE organization_id = ? AND owner_type = 'active_baseline'
            AND owner_id = ? AND run_id = ? AND released_at IS NULL)`)
        .bind(run.id, suite.id, session.organizationId, suite.baseline_version, baselineId,
          session.organizationId, suite.id, run.id));
      statements.push(env.DB.prepare(`UPDATE retention_pins SET released_at = unixepoch()
        WHERE organization_id = ? AND owner_type = 'rollback' AND owner_id = ? AND released_at IS NULL
          AND EXISTS (SELECT 1 FROM baselines WHERE id = ?)`)
        .bind(session.organizationId, suite.id, baselineId));
    }
    const results = await env.DB.batch(statements);
    if (Number(results[0]?.meta?.["changes"] ?? 0) !== 1) throw new HttpError(409, "baseline_changed", "Baseline state changed; refresh and retry");
  }
  await audit(env, session, context, `baseline.${action}`, "project", projectId, { runId: body.runId ?? null });
  return json({ action, updated: true });
}

export async function listMembers(env: Env, session: Session): Promise<Response> {
  requirePermission(session, "projects:admin");
  const result = await env.DB.prepare(`
    SELECT u.id, u.email, u.display_name AS displayName, m.role, m.status, m.updated_at AS updatedAt
      FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = ? ORDER BY u.email
  `).bind(session.organizationId).all();
  return json({ members: result.results ?? [] });
}

export async function updateMember(request: Request, env: Env, session: Session, userId: string, context: RequestContext): Promise<Response> {
  requirePermission(session, "projects:admin");
  const body = await readJson<{ role?: unknown; status?: unknown }>(request);
  const role = body.role === undefined ? undefined : ["viewer", "reviewer", "admin"].includes(String(body.role)) ? String(body.role) : null;
  const status = body.status === undefined ? undefined : ["active", "suspended"].includes(String(body.status)) ? String(body.status) : null;
  if (role === null || status === null || (role === undefined && status === undefined)) throw new HttpError(400, "invalid_membership", "A valid role or status is required");
  const result = await env.DB.prepare(`
    UPDATE memberships SET role = COALESCE(?, role), status = COALESCE(?, status), updated_at = unixepoch()
     WHERE organization_id = ? AND user_id = ? AND (
       role != 'admin' OR status != 'active' OR (COALESCE(?, role) = 'admin' AND COALESCE(?, status) = 'active')
       OR (SELECT COUNT(*) FROM memberships WHERE organization_id = ? AND role = 'admin' AND status = 'active') > 1
     )
  `).bind(role ?? null, status ?? null, session.organizationId, userId, role ?? null, status ?? null, session.organizationId).run();
  if (Number(result.meta?.["changes"] ?? 0) !== 1) {
    const exists = await env.DB.prepare("SELECT 1 AS found FROM memberships WHERE organization_id = ? AND user_id = ?")
      .bind(session.organizationId, userId).first();
    if (!exists) throw new HttpError(404, "member_not_found", "Member was not found");
    throw new HttpError(409, "last_admin", "The final active administrator cannot be suspended or demoted");
  }
  await audit(env, session, context, "membership.updated", "user", userId, { role, status });
  return json({ updated: true });
}

export async function listWorkspaceTokens(env: Env, session: Session): Promise<Response> {
  requirePermission(session, "projects:admin");
  const result = await env.DB.prepare(`
    SELECT id, name, token_prefix AS tokenPrefix, scopes_json AS scopesJson, expires_at AS expiresAt,
      last_used_at AS lastUsedAt, revoked_at AS revokedAt, created_at AS createdAt
      FROM api_tokens WHERE organization_id = ? AND project_id IS NULL ORDER BY created_at DESC
  `).bind(session.organizationId).all<Record<string, unknown>>();
  return json({ tokens: (result.results ?? []).map((token) => ({ ...token,
    scopes: JSON.parse(String(token["scopesJson"])), scopesJson: undefined })) });
}

export async function createWorkspaceToken(request: Request, env: Env, session: Session, context: RequestContext): Promise<Response> {
  requirePermission(session, "projects:admin");
  if (!env.TOKEN_PEPPER || env.TOKEN_PEPPER.length < 32) throw new HttpError(503, "token_authentication_not_configured", "Token creation is not configured");
  const body = await readJson<{ name?: unknown; expiresInDays?: unknown }>(request);
  const name = body.name === undefined ? "Workspace uploads" : requiredString(body.name, "name", 100);
  const expiresInDays = body.expiresInDays === undefined ? 365 : optionalInteger(body.expiresInDays, "expiresInDays", 1, 365)!;
  const scopes = ["runs:create", "projects:bootstrap"];
  const created = await tokenRecord(env, session, null, name, scopes, expiresInDays);
  await audit(env, session, context, "workspace_token.created", "api_token", created.id, { scopes, expiresInDays });
  return json({ token: created.raw, record: { id: created.id, name, tokenPrefix: created.prefix, scopes,
    expiresAt: created.expiresAt } }, { status: 201 });
}

export async function revokeToken(env: Env, session: Session, tokenId: string, context: RequestContext): Promise<Response> {
  requirePermission(session, "projects:admin");
  const result = await env.DB.prepare("UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, unixepoch()) WHERE id = ? AND organization_id = ?")
    .bind(tokenId, session.organizationId).run();
  if (Number(result.meta?.["changes"] ?? 0) !== 1) throw new HttpError(404, "token_not_found", "Token was not found");
  await audit(env, session, context, "token.revoked", "api_token", tokenId, {});
  return new Response(null, { status: 204 });
}

export async function rotateToken(request: Request, env: Env, session: Session, tokenId: string, context: RequestContext): Promise<Response> {
  requirePermission(session, "projects:admin");
  if (!env.TOKEN_PEPPER || env.TOKEN_PEPPER.length < 32) throw new HttpError(503, "token_authentication_not_configured", "Token rotation is not configured");
  const old = await env.DB.prepare("SELECT project_id, name, scopes_json FROM api_tokens WHERE id = ? AND organization_id = ? AND revoked_at IS NULL")
    .bind(tokenId, session.organizationId).first<{ project_id: string | null; name: string; scopes_json: string }>();
  if (!old) throw new HttpError(404, "token_not_found", "Active token was not found");
  const body = await readJson<{ expiresInDays?: unknown }>(request);
  const expiresInDays = body.expiresInDays === undefined ? 90 : optionalInteger(body.expiresInDays, "expiresInDays", 1, 365)!;
  const created = await buildToken(env, session, old.project_id, old.name, JSON.parse(old.scopes_json) as string[], expiresInDays);
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO api_tokens (id, organization_id, project_id, name, token_prefix, token_hash, scopes_json, expires_at, created_by_user_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM api_tokens WHERE id = ? AND organization_id = ? AND revoked_at IS NULL
      )
    `).bind(created.id, session.organizationId, old.project_id, old.name, created.prefix, created.hash,
      old.scopes_json, created.expiresAt, session.userId, tokenId, session.organizationId),
    env.DB.prepare("UPDATE api_tokens SET revoked_at = unixepoch() WHERE id = ? AND organization_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM api_tokens WHERE id = ? AND organization_id = ?)")
      .bind(tokenId, session.organizationId, created.id, session.organizationId),
    env.DB.prepare(`INSERT INTO audit_events
      (id, organization_id, actor_user_id, action, target_type, target_id, request_id, metadata_json)
      SELECT ?, ?, ?, 'token.rotated', 'api_token', ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM api_tokens WHERE id = ? AND organization_id = ?
      )
    `).bind(randomId("aud"), session.organizationId, session.userId, created.id, context.requestId,
      JSON.stringify({ previousTokenId: tokenId }), created.id, session.organizationId),
  ]);
  if (Number(results[0]?.meta?.["changes"] ?? 0) !== 1) throw new HttpError(409, "token_already_rotated", "Token was already revoked or rotated");
  return json({ token: created.raw, record: { id: created.id, name: old.name, tokenPrefix: created.prefix, scopes: JSON.parse(old.scopes_json), expiresAt: created.expiresAt } }, { status: 201 });
}

async function tokenRecord(env: Env, session: Session, projectId: string | null, name: string, scopes: string[], expiresInDays: number) {
  const created = await buildToken(env, session, projectId, name, scopes, expiresInDays);
  await created.statement.run();
  return created;
}

async function buildToken(env: Env, session: Session, projectId: string | null, name: string, scopes: string[], expiresInDays: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  const raw = `sd_pat_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
  const id = randomId("tok");
  const prefix = raw.slice(0, 14);
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInDays * 86400;
  const hash = await sha256(`${raw}:${env.TOKEN_PEPPER!}`);
  const statement = env.DB.prepare(`
    INSERT INTO api_tokens (id, organization_id, project_id, name, token_prefix, token_hash, scopes_json, expires_at, created_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, session.organizationId, projectId, name, prefix, hash, JSON.stringify(scopes), expiresAt, session.userId);
  return { id, raw, prefix, expiresAt, hash, statement };
}

async function audit(env: Env, session: Session, context: RequestContext, action: string, targetType: string, targetId: string, metadata: unknown): Promise<void> {
  await auditStatement(env, session, context, action, targetType, targetId, metadata).run();
}

function auditStatement(env: Env, session: Session, context: RequestContext, action: string, targetType: string, targetId: string, metadata: unknown): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_events
    (id, organization_id, actor_user_id, action, target_type, target_id, request_id, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(randomId("aud"), session.organizationId, session.userId, action, targetType, targetId, context.requestId, JSON.stringify(metadata));
}

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new HttpError(400, "invalid_request", `${field} is invalid`);
  return value.trim();
}

function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, maximum);
}

function optionalInteger(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new HttpError(400, "invalid_request", `${field} must be between ${minimum} and ${maximum}`);
  return Number(value);
}
