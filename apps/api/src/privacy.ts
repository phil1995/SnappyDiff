import type { Session } from "./auth.ts";
import { requirePermission } from "./authorization.ts";
import { recordAudit } from "./audit.ts";
import { HttpError, json, readJson, type RequestContext } from "./http.ts";
import type { Env } from "./platform.ts";

const RECOVERY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export async function exportOrganization(env: Env, session: Session): Promise<Response> {
  requirePermission(session, "projects:admin");
  const [organization, members, projects, runs, comparisons, decisions, auditEvents] = await Promise.all([
    env.DB.prepare("SELECT id, external_id, slug, name, created_at, updated_at FROM organizations WHERE id = ?")
      .bind(session.organizationId).first(),
    env.DB.prepare(`SELECT u.email, u.display_name, m.role, m.status, m.created_at, m.updated_at
      FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY u.email LIMIT 10000`)
      .bind(session.organizationId).all(),
    env.DB.prepare(`SELECT id, slug, name, repository_owner, repository_name, default_branch,
      retention_days, promoted_retention_days, created_at, updated_at FROM projects
      WHERE organization_id = ? ORDER BY created_at LIMIT 10000`).bind(session.organizationId).all(),
    env.DB.prepare(`SELECT id, project_id, commit_sha, branch, pull_request_number, provider, provider_run_id,
      attempt_number, state, screenshot_count, logical_bytes, artifacts_expired_at, created_at, completed_at
      FROM runs WHERE organization_id = ? ORDER BY created_at LIMIT 10000`).bind(session.organizationId).all(),
    env.DB.prepare(`SELECT id, project_id, baseline_run_id, current_run_id, added_count, removed_count,
      changed_count, unchanged_count, status, baseline_warning, created_at FROM comparisons
      WHERE organization_id = ? ORDER BY created_at LIMIT 10000`).bind(session.organizationId).all(),
    env.DB.prepare(`SELECT comparison_id, decision, note, created_at FROM comparison_decisions
      WHERE organization_id = ? ORDER BY created_at LIMIT 10000`).bind(session.organizationId).all(),
    env.DB.prepare(`SELECT action, target_type, target_id, request_id, metadata_json, created_at FROM audit_events
      WHERE organization_id = ? ORDER BY created_at LIMIT 10000`).bind(session.organizationId).all(),
  ]);
  if (!organization) throw new HttpError(404, "organization_not_found", "Organization was not found");
  const body = JSON.stringify({
    schemaVersion: 1, exportedAt: new Date().toISOString(), organization,
    members: members.results ?? [], projects: projects.results ?? [], runs: runs.results ?? [],
    comparisons: comparisons.results ?? [], decisions: decisions.results ?? [], auditEvents: auditEvents.results ?? [],
    limits: { rowsPerCollection: 10000 },
  });
  return new Response(body, { headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "content-disposition": `attachment; filename="snappydiff-${session.organizationId}-export.json"`,
  } });
}

export async function scheduleOrganizationDeletion(
  request: Request, env: Env, session: Session, context: RequestContext,
): Promise<Response> {
  requirePermission(session, "projects:admin");
  const body = await readJson<{ confirmOrganizationId?: unknown }>(request);
  if (body.confirmOrganizationId !== session.organizationId) {
    throw new HttpError(400, "deletion_confirmation_required", "Confirm the exact organization ID before scheduling deletion");
  }
  const executeAfter = Math.floor(Date.now() / 1000) + RECOVERY_WINDOW_SECONDS;
  await env.DB.prepare(`INSERT INTO organization_deletion_requests
    (organization_id, requested_by_user_id, execute_after) VALUES (?, ?, ?)
    ON CONFLICT (organization_id) DO UPDATE SET requested_by_user_id = excluded.requested_by_user_id,
      execute_after = excluded.execute_after, state = 'pending', updated_at = unixepoch()`)
    .bind(session.organizationId, session.userId, executeAfter).run();
  await recordAudit(env, { organizationId: session.organizationId, actorUserId: session.userId,
    action: "organization.deletion_scheduled", targetType: "organization", targetId: session.organizationId,
    requestId: context.requestId, metadata: { executeAfter } });
  return json({ scheduled: true, executeAfter }, { status: 202 });
}

export async function cancelOrganizationDeletion(
  env: Env, session: Session, context: RequestContext,
): Promise<Response> {
  requirePermission(session, "projects:admin");
  const result = await env.DB.prepare(`DELETE FROM organization_deletion_requests
    WHERE organization_id = ? AND state = 'pending'`).bind(session.organizationId).run();
  if (Number(result.meta?.["changes"] ?? 0) !== 1) {
    throw new HttpError(409, "deletion_not_cancelable", "No pending organization deletion can be canceled");
  }
  await recordAudit(env, { organizationId: session.organizationId, actorUserId: session.userId,
    action: "organization.deletion_canceled", targetType: "organization", targetId: session.organizationId,
    requestId: context.requestId });
  return json({ canceled: true });
}

export async function requireOrganizationWritable(env: Env, organizationId: string): Promise<void> {
  const request = await env.DB.prepare(`SELECT state, execute_after FROM organization_deletion_requests
    WHERE organization_id = ?`).bind(organizationId).first<{ state: string; execute_after: number }>();
  if (request) throw new HttpError(409, "organization_deletion_pending",
    "Organization changes are frozen while deletion is pending", { state: request.state, executeAfter: request.execute_after });
}

export async function processOrganizationDeletions(env: Env): Promise<void> {
  const due = await env.DB.prepare(`SELECT organization_id, state, deleting_started_at FROM organization_deletion_requests
    WHERE execute_after <= unixepoch() ORDER BY execute_after LIMIT 10`)
    .all<{ organization_id: string; state: string; deleting_started_at: number | null }>();
  for (const deletion of due.results ?? []) {
    const organizationId = deletion.organization_id;
    await env.DB.prepare(`UPDATE organization_deletion_requests SET state = 'deleting',
      deleting_started_at = COALESCE(deleting_started_at, unixepoch()), updated_at = unixepoch()
      WHERE organization_id = ? AND execute_after <= unixepoch()`).bind(organizationId).run();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO organization_deletion_objects (organization_id, r2_key)
        SELECT organization_id, r2_key FROM images WHERE organization_id = ?
        ON CONFLICT (organization_id, r2_key) DO NOTHING`).bind(organizationId),
      env.DB.prepare(`INSERT INTO organization_deletion_objects (organization_id, r2_key)
        SELECT organization_id, r2_key FROM image_publications WHERE organization_id = ?
        ON CONFLICT (organization_id, r2_key) DO NOTHING`).bind(organizationId),
      env.DB.prepare(`INSERT INTO organization_deletion_objects (organization_id, r2_key)
        SELECT organization_id, temporary_key FROM upload_sessions WHERE organization_id = ?
        ON CONFLICT (organization_id, r2_key) DO NOTHING`).bind(organizationId),
    ]);
    const objects = await env.DB.prepare(`SELECT r2_key FROM organization_deletion_objects
      WHERE organization_id = ? AND deleted_at IS NULL LIMIT 500`).bind(organizationId).all<{ r2_key: string }>();
    const keys = (objects.results ?? []).map(({ r2_key }) => r2_key);
    if (keys.length > 0) {
      await env.IMAGES.delete(keys);
      for (const key of keys) {
        await env.DB.prepare(`UPDATE organization_deletion_objects SET deleted_at = unixepoch()
          WHERE organization_id = ? AND r2_key = ?`).bind(organizationId, key).run();
      }
    }
    const remaining = await env.DB.prepare(`SELECT 1 AS found FROM organization_deletion_objects
      WHERE organization_id = ? AND deleted_at IS NULL LIMIT 1`).bind(organizationId).first();
    if (!remaining && deletion.state === "deleting" && deletion.deleting_started_at !== null
      && deletion.deleting_started_at < Math.floor(Date.now() / 1000) - 600) {
      await env.DB.prepare(`DELETE FROM organizations WHERE id = ? AND EXISTS (
        SELECT 1 FROM organization_deletion_requests WHERE organization_id = ? AND state = 'deleting'
          AND deleting_started_at < unixepoch() - 600)`).bind(organizationId, organizationId).run();
    }
  }
}
